import { z } from "zod";
import {
  newTask,
  taskPatchSchema,
  type State,
  type Proposal,
  type Change,
} from "./model";
import { applyCommand } from "./operations";

const evidence = {
  quote: z
    .string()
    .min(1)
    .describe("当前用户消息中支持本操作的原文，必须逐字引用"),
  mode: z
    .enum(["direct", "proposal"])
    .describe("用户明确指令或事实反馈用direct，Agent新增建议用proposal"),
};
const existingTask = { taskId: z.string(), ...evidence };
const childSchema = z.object({
  title: z.string().min(1),
  goal: z.string().min(1),
});

// 有限动作协议取代任意 Command 注入。模型不能设置版本、执行状态、能量或主题。
export const agentActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("createTask"),
    ref: z
      .string()
      .optional()
      .describe("本轮新任务的临时引用，后续action.taskId可使用此值"),
    title: z.string().min(1),
    patch: taskPatchSchema,
    ...evidence,
  }),
  z.object({
    type: z.literal("updateTask"),
    ...existingTask,
    patch: taskPatchSchema,
  }),
  z.object({
    type: z.literal("context"),
    ...existingTask,
    background: z.string(),
    backgroundKind: z.enum(["用户事实", "暂估", "推测"]),
    progress: z.string(),
    obstacle: z.string(),
    nextStep: z.string(),
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
    type: z.literal("stage"),
    ...existingTask,
    date: z.iso.date(),
    done: z.boolean(),
  }),
  z.object({
    type: z.literal("split"),
    ...existingTask,
    children: z.array(childSchema).min(1).max(20),
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
});
export type AgentTurn = z.infer<typeof agentTurnSchema>;
type Action = z.infer<typeof agentActionSchema>;

function hasDirectIntent(action: Action, quote: string) {
  // 原文证据与动作词只是第二道防线，自然语言授权仍需模型判断和场景评估。
  // 拒绝、试探和求建议不得升级为直接执行。明确命令不要求重复确认。
  if (/不要|别再|先不|不想|不接受|拒绝/.test(quote))
    return action.type === "resolve" && !action.accept;
  if (/要不要|能不能|是否|建议|考虑|也许|可能|想想/.test(quote)) return false;
  if (
    ((action.type === "stage" && action.done) ||
      (action.type === "updateTask" && action.patch.status === "done")) &&
    /还没|没有|没做完|未完成|尚未|没能|不能|并未/.test(quote)
  )
    return false;
  if (
    action.type === "updateTask" &&
    action.patch.status === "done" &&
    !/完成|做完|搞定|提交了/.test(quote)
  )
    return false;
  if (
    action.type === "updateTask" &&
    action.patch.status === "abandoned" &&
    !/放弃/.test(quote)
  )
    return false;
  if (
    action.type === "updateTask" &&
    action.patch.status === "waiting" &&
    !/暂停|等待|等.*再/.test(quote)
  )
    return false;
  const verbs: Record<Action["type"], RegExp> = {
    createTask: /记下|记录|添加|创建|新建|帮我记/,
    updateTask: /改|更新|设为|完成了|做完了|放弃|暂停|截止|提交|交|重要/,
    context: /./s,
    schedule: /安排|改到|移到|放到|放明天|范围|今天做|今天只|按这个|就这样/,
    unschedule: /取消|移除|今天不做|明天再做|改到|移到/,
    stage: /完成|搞定|做完|列出来|先到这里|结束/,
    split: /拆分|拆一下|建子任务|按.*拆|按这个|按你.*来/,
    resolve:
      action.type === "resolve" && !action.accept
        ? /拒绝|不要|不接受|保持|原来/
        : /接受|按这个|按你.*来|按(?:你|这|刚才).{0,12}拆分|就这样|可以|同意/,
  };
  return verbs[action.type].test(quote);
}

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
  const proposal: Proposal = {
    id: crypto.randomUUID(),
    sessionId,
    createdAt: new Date().toISOString(),
    changes: [],
  };
  for (const action of turn.actions) {
    if (!userText.includes(action.quote))
      throw new Error("操作缺少本轮用户原文依据，请重新分析。");
    const quoteIndex = userText.indexOf(action.quote);
    const preceding = userText.slice(Math.max(0, quoteIndex - 4), quoteIndex);
    const contextualQuote = /(?:不要|别|不|未|没|还没|没有|尚未)$/.test(
      preceding,
    )
      ? preceding + action.quote
      : action.quote;
    if (action.mode === "direct" && !hasDirectIntent(action, contextualQuote))
      throw new Error(
        `操作 ${action.type} 的原文「${action.quote}」混有试探、建议或否定，不能直接执行。请为该操作截取独立明确的授权短句，Agent新增建议使用proposal。`,
      );
    if (action.type === "createTask") {
      if (action.mode !== "direct")
        throw new Error("创建任务需要用户明确要求记录。");
      if (
        action.patch.status &&
        action.patch.status !== "todo" &&
        !hasDirectIntent(
          { ...action, type: "updateTask", taskId: "new" },
          contextualQuote,
        )
      )
        throw new Error("新任务的进展状态缺少明确依据。");
      const duplicate = state.tasks.find(
        (t) => t.title.trim() === action.title.trim(),
      );
      if (duplicate) throw new Error("同名任务已存在，请关联已有任务再更新。");
      const task = { ...newTask(), ...action.patch, title: action.title };
      if (action.ref) {
        if (
          references.has(action.ref) ||
          state.tasks.some((t) => t.id === action.ref)
        )
          throw new Error("新任务引用重复。");
        references.set(action.ref, task.id);
      }
      state = applyCommand(state, { type: "saveTask", task });
      continue;
    }
    if (action.type === "resolve") {
      if (action.mode !== "direct") throw new Error("接受方案需要明确授权。");
      const target = state.proposals.find(
        (p) => p.id === action.proposalId && p.sessionId === sessionId,
      );
      if (!target) throw new Error("只能接受当前对话中明确的方案。");
      // 明确只接受拆分时，不能把同卡片里的日程也标为接受；即使随后覆盖日程，
      // 接受记录仍必须反映用户实际授权的范围。
      if (
        action.accept &&
        /拆分|子任务/.test(action.quote) &&
        !/安排|日程|全部|整份|整个/.test(action.quote) &&
        target.changes.some(
          (change) => action.ids.includes(change.id) && change.type !== "split",
        )
      )
        throw new Error(
          "本项原文只授权拆分，resolve.ids只能包含split变更；用户另行指定的今日范围请单独direct schedule。",
        );
      state = applyCommand(state, {
        type: "resolve",
        proposalId: target.id,
        ids: action.ids,
        accept: action.accept,
      });
      continue;
    }
    const task = state.tasks.find(
      (t) => t.id === (references.get(action.taskId) ?? action.taskId),
    );
    if (!task) throw new Error("操作关联的任务不存在。");
    if (action.type === "context") {
      // 保留事实/暂估/推测标记及本轮来源，纠正后的内容取代旧背景。
      // 背景动作没有目标、截止、完成状态或安排的写权限。
      if (action.mode !== "direct") throw new Error("背景补充应来自本轮交流。");
      const { background, backgroundKind, progress, obstacle, nextStep } =
        action;
      state = applyCommand(state, {
        type: "saveTask",
        task: {
          ...task,
          background,
          backgroundKind,
          backgroundSource: action.quote,
          progress,
          obstacle,
          nextStep,
        },
      });
      continue;
    }
    const change: Change = {
      id: crypto.randomUUID(),
      taskId: task.id,
      taskVersion: task.version,
      label:
        action.type === "split"
          ? `拆分「${task.title}」`
          : `调整「${task.title}」`,
      reason: `${action.mode === "direct" ? "按用户要求" : "待用户接受的建议"}；依据：${action.quote}`,
      type: action.type === "updateTask" ? "update" : action.type,
      date: "date" in action ? action.date : "",
      scope: "scope" in action ? action.scope : "",
      children: action.type === "split" ? action.children : [],
      status: "pending",
      ...(action.type === "updateTask" ? { patch: action.patch } : {}),
      ...(action.type === "schedule" && action.fromDate
        ? { fromDate: action.fromDate }
        : {}),
      ...(action.type === "stage" ? { done: action.done } : {}),
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
  for (const change of proposal.changes)
    change.taskVersion = state.tasks.find(
      (t) => t.id === change.taskId,
    )!.version;
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
