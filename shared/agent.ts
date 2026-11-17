import { z } from "zod";
import {
  newTask,
  taskPatchSchema,
  childTaskSchema,
  agentMemorySchema,
  type State,
  type Proposal,
  type Change,
} from "./model";
import { applyCommand } from "./operations";

const evidence = {
  quote: z
    .string()
    .optional()
    .describe(
      "可选的操作依据说明。应用自行绑定本轮真实用户原话，无需重新抄写原文。",
    ),
  mode: z
    .enum(["direct", "proposal"])
    .describe(
      "用户已授权这一项具体变更才用direct，待用户决定的建议用proposal。可用时间等背景条件不代表接受新日程。按用户反馈更新说明可用direct。",
    ),
};
const existingTask = {
  taskId: z
    .string()
    .describe(
      "已保存任务的真实id，或同批createTask声明的ref。任务标题不是id，待接受拆分中的子任务尚无真实id。",
    ),
  ...evidence,
};
// 拒绝旧字段并交给同一工具循环修正，避免将已移除的内容静默丢弃。
const agentTaskPatchSchema = taskPatchSchema
  .strict()
  .describe(
    "仅填写要修改的名称、状态、预计开始startDate、预计完成expectedDate、说明description、所属任务parentId。日期为YYYY-MM-DD或空字符串，未知可省略。说明为完整新文本，保留仍有效的目标、事实、硬截止和停点。系统维护id/version/updatedAt。",
  );

// 有限动作协议取代任意 Command 注入。模型不能设置版本、执行状态、能量或主题。
export const agentActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("createTask"),
    ref: z
      .string()
      .optional()
      .describe("本轮新任务的临时引用，后续action.taskId可使用此值"),
    title: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .describe("根据对话自主概括的简洁任务标题"),
    patch: agentTaskPatchSchema,
    ...evidence,
  }),
  z.object({
    type: z.literal("updateTask"),
    ...existingTask,
    patch: agentTaskPatchSchema,
  }),
  z.object({
    type: z.literal("schedule"),
    ...existingTask,
    date: z.iso.date(),
    scope: z.string().min(1),
    fromDate: z.iso.date().optional(),
  }),
  z.object({
    type: z.literal("unschedule"),
    ...existingTask,
    date: z.iso.date(),
  }),
  z.object({
    type: z
      .literal("updateArrangement")
      .describe(
        "修改已存在安排的范围，taskId/date必须指向原安排。可选targetTaskId可将同一安排转给子任务或另一任务，源安排原子移除。",
      ),
    ...existingTask,
    date: z.iso.date(),
    scope: z.string().min(1),
    targetTaskId: z.string().optional(),
  }),
  z.object({
    type: z.literal("stage"),
    ...existingTask,
    date: z.iso.date(),
    done: z.boolean(),
  }),
  z.object({
    type: z.literal("split"),
    ...existingTask,
    children: z.array(childTaskSchema.strict()).min(1).max(20),
  }),
  z.object({
    type: z.literal("resolve"),
    proposalId: z.string(),
    ids: z.array(z.string()).min(1),
    accept: z.boolean(),
    ...evidence,
  }),
]);
export const agentTurnSchema = z.object({
  text: z.string().min(1),
  actions: z.array(agentActionSchema).max(20),
  memory: agentMemorySchema.optional(),
});
export type AgentTurn = z.infer<typeof agentTurnSchema>;

/** 整轮结果在内存中计算，任何一步失败都会丢弃整份新状态。 */
export function applyAgentTurn(
  previous: State,
  sessionId: string,
  userText: string,
  input: unknown,
  replyId: string = crypto.randomUUID(),
): State {
  const turn = agentTurnSchema.parse(input);
  if (!previous.sessions.some((s) => s.id === sessionId))
    throw new Error("对话不存在。");
  let state = structuredClone(previous);
  const references = new Map<string, string>();
  const taskPatch = (patch: z.infer<typeof taskPatchSchema>) => ({
    ...patch,
    ...(patch.parentId
      ? { parentId: references.get(patch.parentId) ?? patch.parentId }
      : {}),
  });
  const createdTitles = new Set<string>();
  const proposal: Proposal = {
    id: crypto.randomUUID(),
    sessionId,
    createdAt: new Date().toISOString(),
    changes: [],
  };
  for (const action of turn.actions) {
    // 应用已持有本轮真实消息，直接记录来源，避免要求模型重抄原话而误拦操作。
    // 意图、否定、指代和接受范围均由模型判断，执行层检查结构与业务一致性。
    if (action.type === "createTask") {
      if (action.mode !== "direct")
        throw new Error("创建任务需要用户明确要求记录。");
      const duplicate = state.tasks.find(
        (t) => t.title.trim() === action.title.trim(),
      );
      if (duplicate) throw new Error("同名任务已存在，请关联已有任务再更新。");
      const task = {
        ...newTask(),
        ...taskPatch(action.patch),
        title: action.title,
      };
      if (action.ref) {
        if (
          references.has(action.ref) ||
          state.tasks.some((t) => t.id === action.ref)
        )
          throw new Error("新任务引用重复。");
        references.set(action.ref, task.id);
      }
      state = applyCommand(state, { type: "saveTask", task });
      createdTitles.add(task.title);
      continue;
    }
    if (action.type === "resolve") {
      if (action.mode !== "direct") throw new Error("接受方案需要明确授权。");
      const target = state.proposals.find(
        (p) => p.id === action.proposalId && p.sessionId === sessionId,
      );
      if (!target) throw new Error("只能接受当前对话中明确的方案。");
      state = applyCommand(state, {
        type: "resolve",
        proposalId: target.id,
        ids: action.ids,
        accept: action.accept,
      });
      continue;
    }
    const sourceTask = state.tasks.find(
      (t) => t.id === (references.get(action.taskId) ?? action.taskId),
    );
    if (!sourceTask)
      throw new Error(
        `操作${action.type}引用的任务${action.taskId}不存在。请使用已保存任务id或本批createTask.ref，本批已声明的ref为${JSON.stringify([...references.keys()])}。待接受拆分尚未建立真实子任务，今日建议可关联父任务并在scope写具体范围。修正引用后保留完整操作重新提交。`,
      );
    let task = sourceTask;
    if (action.type === "updateArrangement") {
      if (
        !state.arrangements.some(
          (item) => item.taskId === sourceTask.id && item.date === action.date,
        )
      )
        throw new Error(
          "修改安排需要引用已存在的原taskId/date，请核对context.today或readTask。",
        );
      const targetId = action.targetTaskId
        ? (references.get(action.targetTaskId) ?? action.targetTaskId)
        : sourceTask.id;
      const target = state.tasks.find((item) => item.id === targetId);
      if (!target) throw new Error("替换安排的目标任务不存在。");
      task = target;
    }
    // 模型选择直接落地的拆分若与现有待接受条目完全相同，复用该条目执行，
    // 让真实子任务与接受记录同步，避免另建一份已接受记录而遗留原卡片。
    if (action.type === "split" && action.mode === "direct") {
      const matching = state.proposals
        .filter((item) => item.sessionId === sessionId)
        .flatMap((item) =>
          item.changes
            .filter(
              (change) =>
                change.type === "split" &&
                change.status === "pending" &&
                change.taskId === task.id &&
                change.taskVersion === task.version &&
                JSON.stringify(change.children) ===
                  JSON.stringify(action.children),
            )
            .map((change) => ({ proposalId: item.id, changeId: change.id })),
        )
        .at(-1);
      if (matching) {
        state = applyCommand(state, {
          type: "resolve",
          proposalId: matching.proposalId,
          ids: [matching.changeId],
          accept: true,
        });
        continue;
      }
    }
    const change: Change = {
      id: crypto.randomUUID(),
      taskId: task.id,
      taskVersion: task.version,
      label:
        action.type === "split"
          ? `拆分「${task.title}」`
          : `调整「${task.title}」`,
      reason: `${action.mode === "direct" ? "按用户要求" : "待用户接受的建议"}，本轮原话为${userText}`,
      type:
        action.type === "updateTask"
          ? "update"
          : action.type === "updateArrangement"
            ? "schedule"
            : action.type,
      date: "date" in action ? action.date : "",
      scope: "scope" in action ? action.scope : "",
      children: action.type === "split" ? action.children : [],
      status: "pending",
      ...(action.type === "updateTask"
        ? { patch: taskPatch(action.patch) }
        : {}),
      ...(action.type === "schedule" && action.fromDate
        ? { fromDate: action.fromDate }
        : {}),
      ...(action.type === "stage" ? { done: action.done } : {}),
      ...(action.type === "updateArrangement"
        ? {
            fromTaskId: sourceTask.id,
            fromTaskVersion: sourceTask.version,
            fromDate: action.date,
          }
        : {}),
    };
    if (action.mode === "proposal") proposal.changes.push(change);
    else {
      // 直接操作也复用方案应用器，确保日期、关系、版本与阶段规则一致。
      const immediate: Proposal = {
        ...proposal,
        id: crypto.randomUUID(),
        changes: [change],
      };
      state = applyCommand(state, { type: "proposal", proposal: immediate });
      state = applyCommand(state, {
        type: "resolve",
        proposalId: immediate.id,
        ids: [change.id],
        accept: true,
      });
    }
  }
  // 先完成本轮事实和已授权操作，再给尚未接受的建议绑定最新任务版本。
  for (const change of proposal.changes) {
    change.taskVersion = state.tasks.find(
      (t) => t.id === change.taskId,
    )!.version;
    if (change.fromTaskId)
      change.fromTaskVersion = state.tasks.find(
        (task) => task.id === change.fromTaskId,
      )!.version;
  }
  const session = state.sessions.find((item) => item.id === sessionId)!;
  if (turn.memory) session.agentMemory = turn.memory;
  const draft = session.agentMemory?.taskDraft;
  // 创建动作由模型决定；同名草拟已实际落地后，由应用结束其待创建状态。
  if (draft && createdTitles.has(draft.title.trim())) {
    session.agentMemory = { ...session.agentMemory!, taskDraft: null };
  }
  state = applyCommand(state, {
    type: "reply",
    proposal: proposal.changes.length ? proposal : null,
    message: {
      id: replyId,
      sessionId,
      role: "assistant",
      text: turn.text,
      createdAt: new Date().toISOString(),
      ...(proposal.changes.length ? { proposalId: proposal.id } : {}),
    },
  });
  return state;
}
