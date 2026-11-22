import { z } from "zod";
import {
  localDate,
  newTask,
  taskSchema,
  taskPatchSchema,
  recurrenceRuleSchema,
  arrangementSchema,
  taskSubtreeIds,
  childTaskSchema,
  agentMemorySchema,
  type State,
  type Proposal,
  type Change,
  type Command,
} from "../domain/model";
import { applyCommand, checkRecurringTaskPatch } from "../domain/operations";
import { findOccurrence, synchronizeRecurrence } from "../domain/recurrence";

const authorization = {
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
  ...authorization,
};
const occurrenceTarget = {
  ...existingTask,
  date: z.iso.date().describe("该重复实例的本地日期，必须是 context.date"),
};
const recurrence = recurrenceRuleSchema.describe(
  "daily 为每天，weekly 的 weekdays 使用 0=周日、1=周一至 6=周六，range 的 start/end 是含首尾的 YYYY-MM-DD。",
);
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
    title: taskSchema.shape.title.describe("根据对话自主概括的简洁任务标题"),
    patch: agentTaskPatchSchema,
    recurrence: recurrence.optional(),
    ...authorization,
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
  z
    .object({
      type: z.literal("updateRecurrence"),
      ...existingTask,
      recurrence,
    })
    .strict(),
  z
    .object({
      type: z.literal("deleteRecurringTask"),
      ...existingTask,
      includeChildren: z
        .boolean()
        .optional()
        .describe("删除也会级联删除子任务，明确覆盖全部子任务时填写 true"),
    })
    .strict(),
  z
    .object({
      type: z.literal("updateOccurrenceScope"),
      ...occurrenceTarget,
      scope: arrangementSchema.shape.scope,
    })
    .strict(),
  z
    .object({
      type: z.literal("setOccurrenceDone"),
      ...occurrenceTarget,
      done: z.boolean(),
    })
    .strict(),
  z
    .object({
      type: z.literal("skipOccurrence"),
      ...occurrenceTarget,
    })
    .strict(),
  z
    .object({
      type: z.literal("restoreOccurrence"),
      ...occurrenceTarget,
    })
    .strict(),
  z.object({
    type: z.literal("resolve"),
    proposalId: z.string(),
    ids: z.array(z.string()).min(1),
    accept: z.boolean(),
    ...authorization,
  }),
]);
export const agentTurnSchema = z.object({
  text: z.string().min(1),
  actions: z.array(agentActionSchema).max(20),
  memory: agentMemorySchema.optional(),
});
export type AgentTurn = z.infer<typeof agentTurnSchema>;

const recurringChangeLabels: Partial<
  Record<AgentTurn["actions"][number]["type"], string>
> = {
  updateRecurrence: "设置重复规则",
  deleteRecurringTask: "删除重复模板",
  updateOccurrenceScope: "修改今日范围",
  setOccurrenceDone: "记录今日完成状态",
  skipOccurrence: "移除今日重复实例",
  restoreOccurrence: "撤销今日移除",
};

/** 整轮结果在内存中计算，任何一步失败都会丢弃整份新状态。 */
export function applyAgentTurn(
  previous: State,
  sessionId: string,
  userText: string,
  input: unknown,
  replyId: string = crypto.randomUUID(),
  date = localDate(),
): State {
  const turn = agentTurnSchema.parse(input);
  if (!previous.sessions.some((s) => s.id === sessionId))
    throw new Error("对话不存在。");
  let state = structuredClone(previous);
  synchronizeRecurrence(state, date);
  const apply = (command: Command) => {
    state = applyCommand(state, command, date);
  };
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
      if (action.recurrence) checkRecurringTaskPatch(action.patch);
      const duplicate = state.tasks.find(
        (t) => t.title.trim() === action.title.trim(),
      );
      if (duplicate) throw new Error("同名任务已存在，请关联已有任务再更新。");
      const task = {
        ...newTask(),
        ...taskPatch(action.patch),
        title: action.title,
        ...(action.recurrence ? { recurrence: action.recurrence } : {}),
      };
      if (action.ref) {
        if (
          references.has(action.ref) ||
          state.tasks.some((t) => t.id === action.ref)
        )
          throw new Error("新任务引用重复。");
        references.set(action.ref, task.id);
      }
      apply({ type: "saveTask", task });
      createdTitles.add(task.title);
      continue;
    }
    if (action.type === "resolve") {
      if (action.mode !== "direct") throw new Error("接受方案需要明确授权。");
      const target = state.proposals.find(
        (p) => p.id === action.proposalId && p.sessionId === sessionId,
      );
      if (!target) throw new Error("只能接受当前对话中明确的方案。");
      apply({
        type: "resolve",
        proposalId: target.id,
        ids: action.ids,
        accept: action.accept,
      });
      continue;
    }
    const sourceId = references.get(action.taskId) ?? action.taskId;
    const sourceTask = state.tasks.find((t) => t.id === sourceId);
    const occurrence =
      action.type === "updateOccurrenceScope" ||
      action.type === "setOccurrenceDone" ||
      action.type === "skipOccurrence" ||
      action.type === "restoreOccurrence"
        ? findOccurrence(
            state,
            sourceId,
            action.date,
            action.type === "restoreOccurrence",
          )
        : undefined;
    if (!sourceTask && !occurrence)
      throw new Error(
        `操作${action.type}引用的任务${action.taskId}不存在。请使用已保存任务id或本批createTask.ref，本批已声明的ref为${JSON.stringify([...references.keys()])}。待接受拆分尚未建立真实子任务，今日建议可关联父任务并在scope写具体范围。修正引用后保留完整操作重新提交。`,
      );
    let task = sourceTask;
    if (action.type === "updateArrangement") {
      if (
        !state.arrangements.some(
          (item) => item.taskId === sourceId && item.date === action.date,
        )
      )
        throw new Error(
          "修改安排需要引用已存在的原taskId/date，请核对context.today或readTask。",
        );
      const targetId = action.targetTaskId
        ? (references.get(action.targetTaskId) ?? action.targetTaskId)
        : sourceId;
      const target = state.tasks.find((item) => item.id === targetId);
      if (!target) throw new Error("替换安排的目标任务不存在。");
      task = target;
    }
    if (
      (sourceTask?.recurrence || task?.recurrence) &&
      (action.type === "schedule" ||
        action.type === "unschedule" ||
        action.type === "updateArrangement" ||
        action.type === "stage" ||
        action.type === "split")
    )
      throw new Error("请选择对应的重复任务操作，今日实例使用单次操作。");
    if (sourceTask?.recurrence && action.type === "updateTask")
      checkRecurringTaskPatch(action.patch);
    // 模型选择直接落地的拆分若与现有待接受条目完全相同，复用该条目执行，
    // 让真实子任务与接受记录同步，避免另建一份已接受记录而遗留原卡片。
    if (task && action.type === "split" && action.mode === "direct") {
      const { id, version } = task;
      const matching = state.proposals
        .filter((item) => item.sessionId === sessionId)
        .flatMap((item) =>
          item.changes
            .filter(
              (change) =>
                change.type === "split" &&
                change.status === "pending" &&
                change.taskId === id &&
                change.taskVersion === version &&
                JSON.stringify(change.children) ===
                  JSON.stringify(action.children),
            )
            .map((change) => ({ proposalId: item.id, changeId: change.id })),
        )
        .at(-1);
      if (matching) {
        apply({
          type: "resolve",
          proposalId: matching.proposalId,
          ids: [matching.changeId],
          accept: true,
        });
        continue;
      }
    }
    const title = task?.title ?? occurrence?.recurrence?.title;
    let descendantIds: string[] | undefined;
    if (action.type === "deleteRecurringTask") {
      const descendants = taskSubtreeIds(state.tasks, [sourceId]);
      descendants.delete(sourceId);
      descendantIds = [...descendants];
      if (descendantIds.length && !action.includeChildren)
        throw new Error("删除模板也会删除其子任务，请核实删除范围。");
    }
    const label =
      recurringChangeLabels[action.type] ??
      (action.type === "split" ? "拆分" : "调整");
    const change: Change = {
      id: crypto.randomUUID(),
      taskId: task?.id ?? sourceId,
      taskVersion: task?.version ?? null,
      label: `${label}「${title}」`,
      reason: `${action.mode === "direct" ? "按用户要求" : "待用户接受的建议"}，本轮原话为${userText}`,
      type:
        action.type === "updateTask"
          ? "update"
          : action.type === "updateArrangement"
            ? "schedule"
            : action.type,
      date:
        "date" in action
          ? action.date
          : action.type === "updateRecurrence" ||
              action.type === "deleteRecurringTask"
            ? date
            : "",
      scope: "scope" in action ? action.scope : "",
      children: action.type === "split" ? action.children : [],
      status: "pending",
      ...(action.type === "updateTask"
        ? { patch: taskPatch(action.patch) }
        : {}),
      ...(action.type === "schedule" && action.fromDate
        ? { fromDate: action.fromDate }
        : {}),
      ...("done" in action ? { done: action.done } : {}),
      ...(action.type === "updateRecurrence"
        ? { recurrence: action.recurrence }
        : {}),
      ...(occurrence ? { occurrence } : {}),
      ...(descendantIds ? { descendantIds } : {}),
      ...(action.type === "updateArrangement" && sourceTask
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
      apply({ type: "proposal", proposal: immediate });
      apply({
        type: "resolve",
        proposalId: immediate.id,
        ids: [change.id],
        accept: true,
      });
    }
  }
  // 先完成本轮事实和已授权操作，再给尚未接受的建议绑定最新任务版本。
  for (const change of proposal.changes) {
    const task = state.tasks.find((item) => item.id === change.taskId);
    if (!task && !change.occurrence)
      throw new Error("建议所引用的任务已在本轮删除，请重新核对。");
    if (task?.recurrence && change.patch) checkRecurringTaskPatch(change.patch);
    change.taskVersion = task?.version ?? null;
    if (change.fromTaskId) {
      const source = state.tasks.find((item) => item.id === change.fromTaskId);
      if (!source) throw new Error("原安排所属任务已在本轮删除，请重新核对。");
      change.fromTaskVersion = source.version;
    }
  }
  const session = state.sessions.find((item) => item.id === sessionId)!;
  if (turn.memory) session.agentMemory = turn.memory;
  const draft = session.agentMemory?.taskDraft;
  // 创建动作由模型决定；同名草拟已实际落地后，由应用结束其待创建状态。
  if (draft && createdTitles.has(draft.title.trim())) {
    session.agentMemory = { ...session.agentMemory!, taskDraft: null };
  }
  apply({
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
