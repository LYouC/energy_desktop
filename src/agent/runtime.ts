import {
  APICallError,
  streamText,
  tool,
  stepCountIs,
  type LanguageModel,
} from "ai";
import { setTimeout as delay } from "node:timers/promises";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { z } from "zod";
import { agentTurnSchema, applyAgentTurn, type AgentTurn } from "./turn";
import {
  arrangementForAgent,
  buildContext,
  readConversation,
  refersToCurrentTasks,
  taskAttributesForAgent,
  tasksForAgent,
  upcomingTasks,
} from "./context";
import { localDate, type Command, type State } from "../domain/model";
import { applyCommand, schedulableTodayTasks } from "../domain/operations";
import { repeatTaskStatuses } from "../domain/recurrence";
import { agentInstructions } from "./prompt";
import { capacitySchema, calculateCapacity } from "./capacity";

const decisionSchema = z
  .object({
    intent: z
      .enum(["conversation", "changes"])
      .describe(
        "conversation为纯交流，changes包括已授权操作和待接受方案。changes不代表每项都获授权，每项mode单独判断。",
      ),
    ...agentTurnSchema.omit({ text: true }).shape,
  })
  .refine(
    (decision) =>
      decision.intent === "changes"
        ? decision.actions.length > 0
        : decision.actions.length === 0,
    {
      message:
        "changes意图必须包含具体业务动作，conversation意图的actions应为空。",
    },
  );

export type Connection = { baseURL: string; model: string; apiKey: string };
export type AgentEvent = {
  runId: string;
  type: "text" | "status" | "retry";
  text: string;
};
export type TurnTrace = {
  steps: number;
  inputTokens: number;
  outputTokens: number;
  actions: number;
  tools?: string[];
  calls?: { name: string; input: unknown }[];
  validationErrors?: string[];
};

const maxNetworkRetries = 3;
const retriesExhausted = "模型服务暂时无法连接，自动重试 3 次仍未成功。";
const networkCodes = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENOTFOUND",
  "ENETUNREACH",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

function isRetryableNetworkError(error: unknown): boolean {
  if (APICallError.isInstance(error)) return error.isRetryable;
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return (
    networkCodes.has(code ?? "") ||
    (error instanceof TypeError &&
      /^(fetch failed|failed to fetch|terminated)$/i.test(error.message)) ||
    (error.cause instanceof Error &&
      networkCodes.has((error.cause as NodeJS.ErrnoException).code ?? ""))
  );
}

// 草稿、主题和历史消息的变化不使方案过期，任务事实/能量/偏好变化则必须重新分析。
export function planningSnapshot(state: State) {
  return JSON.stringify([
    state.tasks,
    state.arrangements,
    state.skippedOccurrences,
    state.repeatSchedules,
    state.repeatCompletions,
    state.proposals,
    state.energy,
    state.preferences,
    state.sessions
      .filter((session) => session.agentMemory)
      .map((session) => [session.id, session.agentMemory]),
  ]);
}

export async function generateAgentTurn(options: {
  state: State;
  sessionId: string;
  focusedId: string | null;
  userText: string;
  connection: Connection;
  signal: AbortSignal;
  emit: (event: Omit<AgentEvent, "runId">) => void;
  model?: LanguageModel;
  date?: string;
  suggestOnly?: boolean;
  onModelRequest?: (body: string) => void;
}): Promise<{ turn: AgentTurn; trace: TurnTrace }> {
  const { state, sessionId, userText, connection, signal, emit } = options;
  const provider = createOpenAICompatible({
    name: "siliconflow",
    baseURL: connection.baseURL,
    apiKey: connection.apiKey,
    fetch: options.onModelRequest
      ? (input, init) => {
          if (typeof init?.body === "string")
            options.onModelRequest?.(init.body);
          return globalThis.fetch(input, init);
        }
      : undefined,
  });
  let finalText: string | undefined;
  let memory: AgentTurn["memory"];
  let streamFinalReply = false;
  let prepared: AgentTurn["actions"] | undefined;
  const upcomingTaskIds = new Set<string>();
  let streamError = false;
  const validationErrors: string[] = [];
  emit({ type: "status", text: "正在结合最新任务与背景分析…" });
  const context = {
    ...buildContext(state, sessionId, options.date),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    focusedId: state.tasks.some((task) => task.id === options.focusedId)
      ? options.focusedId
      : null,
  };
  const contextTasks = tasksForAgent(state.tasks);
  const today = new Date(context.date + "T12:00:00");
  const dateAt = (offset: number) => {
    const value = new Date(today);
    value.setDate(value.getDate() + offset);
    return localDate(value);
  };
  const weekday = (today.getDay() + 6) % 7;
  const calendar = {
    today: context.date,
    tomorrow: dateAt(1),
    thisFriday: dateAt(4 - weekday),
    nextFriday: dateAt(11 - weekday),
  };
  // 保留真实的user/assistant轮次，让短答自然承接上一轮，而不是把整段对话塞成一条JSON消息。
  const { recentMessages, ...workspaceContext } = context;
  const todayTaskIds = new Set([
    ...context.today.map(({ taskId }) => taskId),
    ...context.dueToday.map(({ id }) => id),
  ]);
  const existingTaskIds = new Set(state.tasks.map(({ id }) => id));
  const schedulableTodayIds = new Set(
    schedulableTodayTasks(state, context.date).map(({ id }) => id),
  );
  if (options.suggestOnly) {
    // 一键优化先核算今天，未来安排由模型按需查询。
    workspaceContext.unfinishedTasks = context.unfinishedTasks.filter(
      ({ id }) => todayTaskIds.has(id),
    );
  }
  const messages = recentMessages.map(({ role, text }) => ({
    role,
    content: text,
  }));
  if (
    recentMessages.at(-1)?.role !== "user" ||
    recentMessages.at(-1)?.text !== userText
  )
    messages.push({ role: "user", content: userText });
  const prepareTurn = tool({
    description:
      "结合完整对话判断本轮意图并提交具体决定。纯交流选择conversation且actions为空，执行或提出正式方案时选择changes。每个任务的首个proposal动作必须填actions[].reason作为卡片理由。程序执行后根据回执自然回复。每轮都需要此决定。",
    inputSchema: decisionSchema,
    execute: async ({ intent, actions, memory: nextMemory }) => {
      if (prepared) throw new Error("本轮决定已准备完成，请根据回执回复。");
      // 同一SDK循环内预演并返回具体业务结果。最终回复必须基于这份结果。
      // 所有真实写入仍在最后一次事务中完成，取消不会留下半轮变更。
      try {
        if (
          options.suggestOnly &&
          actions.some((action) => action.mode === "direct")
        )
          throw new Error(
            "一键优化只允许提出待用户接受的方案，请改用 proposal 或仅交流。",
          );
        for (const action of actions) {
          if (action.mode !== "proposal") continue;
          const schedulesToday =
            action.type === "schedule" &&
            !action.fromDate &&
            action.date === context.date;
          const splitsForToday =
            action.type === "split" &&
            action.children.some(({ todayScope }) => todayScope);
          if (!schedulesToday && !splitsForToday) continue;
          // 同轮新建的任务使用 ref，本轮已有任务按今日两区和候选筛选。
          if (!existingTaskIds.has(action.taskId)) continue;
          if (schedulesToday && !schedulableTodayIds.has(action.taskId))
            throw new Error(
              "任务当前不能新增今日安排，请重新核对状态或改用已有安排操作。",
            );
          if (
            !todayTaskIds.has(action.taskId) &&
            !upcomingTaskIds.has(action.taskId)
          )
            throw new Error(
              "提前推进建议须从本轮 readUpcomingTasks 返回的候选选择，请先查询或修正任务。",
            );
        }
        const next = applyAgentTurn(
          state,
          sessionId,
          userText,
          {
            text: "[等待最终回复]",
            actions,
            ...(nextMemory ? { memory: nextMemory } : {}),
          },
          undefined,
          context.date,
        );
        const newProposalId = next.messages.at(-1)?.proposalId;
        const newProposal = next.proposals.find(
          ({ id }) => id === newProposalId,
        );
        const missingReason = newProposal?.cards.find((card) => !card.reason);
        if (missingReason)
          throw new Error(
            `请在「${missingReason.title}」的首个 proposal 动作的 reason 字段填写一条具体理由，并重新提交完整动作。`,
          );
        if (newProposal)
          for (const card of newProposal.cards)
            applyCommand(
              next,
              {
                type: "resolve",
                proposalId: newProposal.id,
                cardIds: [card.id],
                accept: true,
              },
              context.date,
            );
        const oldTasks = new Map(state.tasks.map((task) => [task.id, task]));
        const updatedTasks = tasksForAgent(next.tasks);
        const changedTasks = updatedTasks.filter(
          (task) => oldTasks.get(task.id)?.version !== task.version,
        );
        const nextTasks = new Map(updatedTasks.map((task) => [task.id, task]));
        const nextTaskIds = new Set(nextTasks.keys());
        const repeatStatuses = repeatTaskStatuses(next, context.date);
        const withTaskTitle = (item: State["arrangements"][number]) => {
          const task = nextTasks.get(item.taskId);
          const {
            taskId: _taskId,
            recurrence,
            ...arrangement
          } = arrangementForAgent(item, task);
          return {
            ...arrangement,
            ...(recurrence ? { repeating: true } : {}),
            taskTitle: task?.title,
          };
        };
        prepared = actions;
        memory = next.sessions.find(
          (session) => session.id === sessionId,
        )?.agentMemory;
        return {
          validated: true,
          intent,
          changesPrepared: actions.length > 0,
          taskDraft: memory?.taskDraft ?? null,
          // 新任务 ID 在预演与最终提交时分别分配，回执用名称表达归属，
          // 避免模型把预演 ID 记成后续会话可调用的真实 ID。
          tasks: changedTasks.map(
            ({
              title,
              status,
              startDate,
              expectedDate,
              description,
              parentId,
              recurrence,
            }) => ({
              title,
              ...(recurrence ? {} : { status }),
              startDate,
              expectedDate,
              description,
              recurrence,
              parentTitle: parentId
                ? (nextTasks.get(parentId)?.title ?? null)
                : null,
            }),
          ),
          repeatResults: next.repeatSchedules.flatMap(({ taskId }) => {
            const before = context.unfinishedTasks.find(
              (task) => task.id === taskId,
            )?.repeatProgress;
            const after = repeatStatuses.get(taskId);
            if (JSON.stringify(before) === JSON.stringify(after)) return [];
            return [{ title: nextTasks.get(taskId)?.title, progress: after }];
          }),
          deletedTasks: state.tasks
            .filter((task) => !nextTasks.has(task.id))
            .map(({ title }) => title),
          arrangements: next.arrangements
            .filter(
              (item) =>
                nextTasks.has(item.taskId) &&
                (item.date === context.date ||
                  (!options.suggestOnly && !item.recurrence)),
            )
            .map(withTaskTitle),
          skippedToday: next.skippedOccurrences
            .filter(
              ({ arrangement }) =>
                arrangement.date === context.date &&
                nextTasks.has(arrangement.taskId),
            )
            .map(({ arrangement }) => withTaskTitle(arrangement)),
          resolvedCards: actions.flatMap((action) => {
            if (action.type !== "resolve") return [];
            const proposal = next.proposals.find(
              (item) => item.id === action.proposalId,
            );
            return (proposal?.cards ?? [])
              .filter((card) => action.cardIds.includes(card.id))
              .map(({ title, status }) => ({ title, status }));
          }),
          pendingCards: next.proposals
            .filter((proposal) => proposal.sessionId === sessionId)
            .flatMap((proposal) =>
              proposal.cards
                .filter(
                  (card) =>
                    card.status === "pending" &&
                    card.changes.every((change) =>
                      refersToCurrentTasks(change, nextTaskIds),
                    ),
                )
                .map(({ title, reason, changes, previousExpectedDate }) => ({
                  title,
                  reason,
                  previousExpectedDate,
                  changes: changes.map(
                    ({
                      label,
                      type,
                      scope,
                      date,
                      fromDate,
                      fromTaskTitle,
                      targetTaskTitle,
                      originalScope,
                      patch,
                      recurrence,
                      children,
                      done,
                      descendantIds,
                    }) => {
                      const { parentId, ...fields } = patch ?? {};
                      return {
                        label,
                        type,
                        scope,
                        date,
                        fromDate,
                        fromTaskTitle,
                        targetTaskTitle,
                        originalScope,
                        patch: patch && {
                          ...fields,
                          parentTitle: parentId
                            ? nextTasks.get(parentId)?.title
                            : parentId,
                        },
                        recurrence,
                        children,
                        done,
                        completionDescendantCount: done
                          ? descendantIds?.length
                          : undefined,
                      };
                    },
                  ),
                })),
            ),
        };
      } catch (error) {
        validationErrors.push(
          error instanceof Error ? error.message.slice(0, 300) : "业务校验失败",
        );
        throw error;
      }
    },
  });
  const result = streamText({
    model: options.model ?? provider.chatModel(connection.model),
    system:
      agentInstructions +
      `\n本轮读取的系统本地时间为 ${context.time}（时区 ${context.timezone}）。涉及当前钟点时直接使用此值。工作区今日日期为 ${calendar.today}，安排和相对日期使用 calendar 锚点。`,
    messages: [
      {
        role: "user",
        content:
          "以下JSON是工作区数据，用于理解后续对话。\n" +
          JSON.stringify({ context: workspaceContext, calendar }),
      },
      ...messages,
    ],
    abortSignal: signal,
    maxRetries: 0,
    maxOutputTokens: 6000,
    providerOptions:
      connection.baseURL === "https://api.siliconflow.cn/v1"
        ? { siliconflow: { enable_thinking: false } }
        : undefined,
    // SDK 默认会打印完整 provider 错误。凭据与请求体只留在调用进程内。
    onError: () => {},
    // SDK承担工具循环，工具仅暂存。含工具调用的步骤不作为最终答复。
    stopWhen: stepCountIs(6),
    prepareStep: () => {
      streamFinalReply = Boolean(prepared);
      if (streamFinalReply) return { activeTools: [], toolChoice: "none" };
    },
    onStepEnd: (step) => {
      if (streamFinalReply && step.toolCalls.length === 0 && step.text.trim()) {
        finalText = step.text;
      }
    },
    // 每轮先由模型明确本轮意图和动作，避免直接声称完成却跳过工具。
    toolChoice: "required",
    tools: {
      readConversation: tool({
        description:
          "读取当前会话更早的原文。近期消息不足以解释指代、待创建任务或历史决定时使用，按nextBeforeMessageId继续向前翻页。",
        inputSchema: z.object({
          beforeMessageId: z.string().optional(),
          limit: z.number().int().min(1).max(40).default(20),
        }),
        execute: async ({ beforeMessageId, limit }) =>
          readConversation(state, sessionId, beforeMessageId, limit),
      }),
      calculateCapacity: tool({
        description:
          "规划有明确可用时间和任务估时，先调用此工具核算容量。所有数值单位为分钟，估计仍保留不确定性。",
        inputSchema: capacitySchema,
        execute: async (input) => calculateCapacity(input),
      }),
      readUpcomingTasks: tool({
        description:
          "只读查询从明天起最多七个本地日历日内、尚未纳入今天的一次性任务。按预计开始、预计完成或未完成的普通安排匹配，返回任务背景、重要性与窗口内的待推进范围。提前推进或确认今日有余量时使用。",
        inputSchema: z.object({
          days: z
            .number()
            .int()
            .min(1)
            .max(7)
            .default(7)
            .describe("从明天开始向后查询的天数，含最后一天。"),
        }),
        execute: async ({ days }) => {
          const through = dateAt(days);
          const tasks = upcomingTasks(state, context.date, through);
          for (const { id } of tasks) upcomingTaskIds.add(id);
          return {
            from: calendar.tomorrow,
            through,
            tasks,
          };
        },
      }),
      readTask: tool({
        description:
          "按任务ID查看属性、子任务、安排和重复完成记录。已删除的任务返回 task:null。更新说明前核实旧内容。",
        inputSchema: z.object({ taskId: z.string() }),
        execute: async ({ taskId }) => {
          emit({ type: "status", text: "正在查看相关任务背景…" });
          const task = contextTasks.find((item) => item.id === taskId) ?? null;
          return {
            task: task ? taskAttributesForAgent(task) : null,
            repeatProgress: context.unfinishedTasks.find(
              (entry) => entry.id === taskId,
            )?.repeatProgress,
            repeatCompletions: state.repeatCompletions.filter(
              (entry) => entry.taskId === taskId,
            ),
            children: contextTasks
              .filter((t) => t.parentId === taskId)
              .map(taskAttributesForAgent),
            arrangements: task
              ? state.arrangements
                  .filter(
                    (item) =>
                      item.taskId === taskId &&
                      (!item.recurrence || item.date === context.date),
                  )
                  .map((item) => arrangementForAgent(item, task))
              : [],
            skippedToday: context.skippedToday.filter(
              (item) => item.taskId === taskId,
            ),
          };
        },
      }),
      prepareTurn,
    },
  });
  for await (const event of result.fullStream) {
    // 最终回复阶段已关闭工具，文字可以安全流式展示。
    if (streamFinalReply && event.type === "text-delta")
      emit({ type: "text", text: event.text });
    if (event.type === "error") {
      if (isRetryableNetworkError(event.error)) throw event.error;
      streamError = true;
    }
    if (event.type === "tool-error")
      validationErrors.push(String(event.error).slice(0, 1000));
  }
  signal.throwIfAborted();
  // 部分模型在关闭工具后仍把补充动作输出成 DSML 正文，这些动作没有执行。
  // 将整轮判为不完整，避免保存缺字段的任务。工具执行只接受正式工具通道。
  const malformedReply = /<[|｜]DSML[|｜]\s*(?:calls|invoke|parameter)\b/u.test(
    finalText ?? "",
  );
  if (streamError || !finalText || !prepared || malformedReply) {
    const failure = new Error(
      "模型未生成可应用的完整结果，请重试或明确操作范围。",
    );
    Object.assign(failure, { validationErrors });
    throw failure;
  }
  // 草拟内容是模型已经生成的结构化数据。确保用户能看到具体对象，
  // 避免模型只说“草稿已记下”而把标题留在后台。此处仅补充展示，不决定是否创建。
  const draft = memory?.taskDraft;
  if (draft && !finalText.includes(draft.title)) {
    const details = [
      `待创建任务「${draft.title}」`,
      draft.patch.description ? `说明为${draft.patch.description}` : "",
      draft.patch.startDate ? `预计开始为${draft.patch.startDate}` : "",
      draft.patch.expectedDate ? `预计完成为${draft.patch.expectedDate}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    const addition = `\n\n${details}`;
    finalText += addition;
    emit({ type: "text", text: addition });
  }
  const usage = await result.totalUsage;
  const steps = await result.steps;
  const turn: AgentTurn = {
    text: finalText,
    actions: prepared,
    ...(memory ? { memory } : {}),
  };
  return {
    turn,
    trace: {
      steps: steps.length,
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      actions: turn.actions.length,
      tools: steps.flatMap((step) =>
        step.toolCalls.map((call) => call.toolName),
      ),
      calls: steps.flatMap((step) =>
        step.toolCalls.map((call) => ({
          name: call.toolName,
          input: call.input,
        })),
      ),
      validationErrors,
    },
  };
}

/** 单应用串行运行，避免并发模型调用基于同一份旧任务互相覆盖。 */
export class AgentRuntime {
  private active?: { runId: string; controller: AbortController };
  constructor(
    private database: {
      currentDate: () => string;
      load: () => State;
      execute: (revision: number, command: Command) => State;
      commitAgentTurn: (
        revision: number,
        sessionId: string,
        userText: string,
        turn: AgentTurn,
        replyId?: string,
        expectedDate?: string,
      ) => State;
    },
    private connection: () => Connection,
    private generate: typeof generateAgentTurn = generateAgentTurn,
  ) {}
  cancel(runId: string) {
    if (this.active?.runId === runId) this.active.controller.abort();
  }
  private async generateWithRetry(
    options: Parameters<typeof generateAgentTurn>[0],
  ) {
    for (let attempt = 0; ; attempt++) {
      options.signal.throwIfAborted();
      try {
        return await this.generate(options);
      } catch (error) {
        options.signal.throwIfAborted();
        if (!isRetryableNetworkError(error)) throw error;
        if (attempt === maxNetworkRetries) throw new Error(retriesExhausted);
        options.emit({
          type: "retry",
          text: `模型服务暂不可用，正在自动重试（${attempt + 1}/${maxNetworkRetries}）…`,
        });
        await delay(250 * 2 ** attempt, undefined, { signal: options.signal });
      }
    }
  }
  async send(
    input: unknown,
    emit: (event: AgentEvent) => void,
    onModelRequest?: (
      run: { runId: string; sessionId: string },
      body: string,
    ) => void,
  ): Promise<State> {
    const request = z
      .object({
        runId: z.string().uuid(),
        sessionId: z.string(),
        text: z.string().trim().min(1).max(20000),
        focusedId: z.string().nullable(),
        source: z.literal("optimizeToday").optional(),
      })
      .parse(input);
    const date = this.database.currentDate();
    let state = this.database.load();
    const messageId = `${request.runId}:user`;
    const replyId = `${request.runId}:assistant`;
    const suggestOnly = request.source === "optimizeToday";
    const previousMessage = state.messages.find((m) => m.id === messageId);
    if (
      previousMessage &&
      (previousMessage.sessionId !== request.sessionId ||
        previousMessage.text !== request.text ||
        previousMessage.source !== request.source)
    )
      throw new Error("请求标识已经用于其他消息，请重新发送。");
    // 成功标识与结果在同一事务保存，重启后也能识别重试。
    if (state.messages.some((m) => m.id === replyId)) return state;
    if (
      previousMessage &&
      state.messages.filter((m) => m.sessionId === request.sessionId).at(-1)
        ?.id !== messageId
    )
      throw new Error("此对话已有后续消息，不能重试较早的一轮。");
    if (this.active) throw new Error("已有一轮分析正在进行，请等待或取消。");
    const controller = new AbortController();
    this.active = { runId: request.runId, controller };
    const timeout = setTimeout(() => controller.abort(), 120000);
    try {
      if (!state.messages.some((m) => m.id === messageId))
        state = this.database.execute(state.revision, {
          type: "message",
          message: {
            id: messageId,
            sessionId: request.sessionId,
            role: "user",
            text: request.text,
            createdAt: new Date().toISOString(),
            source: request.source,
          },
        });
      const snapshot = planningSnapshot(state);
      const { turn } = await this.generateWithRetry({
        state,
        date,
        suggestOnly,
        sessionId: request.sessionId,
        focusedId: request.focusedId,
        userText: request.text,
        connection: this.connection(),
        signal: controller.signal,
        emit: (event) => emit({ ...event, runId: request.runId }),
        onModelRequest:
          onModelRequest && ((body) => onModelRequest(request, body)),
      });
      controller.signal.throwIfAborted();
      const latest = this.database.load();
      if (
        !latest.messages.some((message) => message.id === messageId) ||
        planningSnapshot(latest) !== snapshot
      )
        throw new Error("分析期间任务或状态已变化，请根据最新数据重新发送。");
      // 从最后一次读取到事务写入之间无await，取消和其他IPC无法插入半轮提交。
      const next = this.database.commitAgentTurn(
        latest.revision,
        request.sessionId,
        request.text,
        turn,
        replyId,
        date,
      );
      return next;
    } catch (error) {
      if (controller.signal.aborted)
        throw new Error("本轮分析已取消或超时，本轮业务变更未提交。");
      // provider错误可能包含请求头或响应原文，只对外返回有限的应用错误。
      if (
        error instanceof Error &&
        (error.message === retriesExhausted ||
          /^(分析期间(?:任务或状态|本地日期)已变化|模型未生成可应用的完整结果|对话不存在。$)/.test(
            error.message,
          ))
      )
        throw error;
      throw new Error("模型调用或结果校验失败，请检查服务配置，稍后重试。");
    } finally {
      clearTimeout(timeout);
      this.active = undefined;
    }
  }
}
