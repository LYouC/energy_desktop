import { streamText, tool, stepCountIs, type LanguageModel } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { z } from "zod";
import {
  agentActionSchema,
  applyAgentTurn,
  type AgentTurn,
} from "../../shared/agent";
import { buildContext, readConversation } from "../../shared/context";
import {
  agentMemorySchema,
  type Command,
  type State,
} from "../../shared/model";
import { agentInstructions } from "./prompt";
import { capacitySchema, calculateCapacity } from "../../shared/capacity";

const decisionSchema = z
  .object({
    intent: z
      .enum(["conversation", "changes"])
      .describe(
        "conversation为纯交流，changes包括已授权操作和待接受方案。changes不代表每项都获授权，每项mode单独判断。",
      ),
    actions: z.array(agentActionSchema).max(20),
    memory: agentMemorySchema.optional(),
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
  type: "text" | "status";
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

// 草稿、主题和历史消息的变化不使方案过期，任务事实/能量/偏好变化则必须重新分析。
export function planningSnapshot(state: State) {
  return JSON.stringify([
    state.tasks,
    state.arrangements,
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
}): Promise<{ turn: AgentTurn; trace: TurnTrace }> {
  const { state, sessionId, userText, connection, signal, emit } = options;
  const provider = createOpenAICompatible({
    name: "siliconflow",
    baseURL: connection.baseURL,
    apiKey: connection.apiKey,
  });
  let finalText: string | undefined;
  let memory: AgentTurn["memory"];
  let streamFinalReply = false;
  let prepared: AgentTurn["actions"] | undefined;
  let streamError = false;
  const validationErrors: string[] = [];
  emit({ type: "status", text: "正在结合最新任务与背景分析…" });
  const context = {
    ...buildContext(state, sessionId),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    focusedId: options.focusedId,
  };
  const today = new Date(context.date + "T12:00:00");
  const dateAt = (offset: number) => {
    const value = new Date(today);
    value.setDate(value.getDate() + offset);
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
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
      "结合完整对话判断本轮意图并提交具体决定。纯交流选择conversation且actions为空，用户要求执行或需要展示正式方案时选择changes并提交相应动作。程序执行该决定，随后根据回执自然回复。每轮都需要此决定。",
    inputSchema: decisionSchema,
    execute: async ({ intent, actions, memory: nextMemory }) => {
      if (prepared) throw new Error("本轮决定已准备完成，请根据回执回复。");
      // 同一SDK循环内预演并返回具体业务结果。最终回复必须基于这份结果。
      // 所有真实写入仍在最后一次事务中完成，取消不会留下半轮变更。
      try {
        const next = applyAgentTurn(state, sessionId, userText, {
          text: "[等待最终回复]",
          actions,
          ...(nextMemory ? { memory: nextMemory } : {}),
        });
        const oldTasks = new Map(state.tasks.map((task) => [task.id, task]));
        const changedTasks = next.tasks.filter(
          (task) => oldTasks.get(task.id)?.version !== task.version,
        );
        prepared = actions;
        memory = next.sessions.find(
          (session) => session.id === sessionId,
        )?.agentMemory;
        return {
          validated: true,
          intent,
          changesPrepared: actions.length > 0,
          taskDraft: memory?.taskDraft ?? null,
          tasks: changedTasks.map(
            ({ title, goal, deadline, status, progress, nextStep }) => ({
              title,
              goal,
              deadline,
              status,
              progress,
              nextStep,
            }),
          ),
          arrangements: next.arrangements.map(({ taskId, ...arrangement }) => ({
            ...arrangement,
            taskTitle: next.tasks.find((task) => task.id === taskId)!.title,
          })),
          pendingChanges: next.proposals
            .filter((proposal) => proposal.sessionId === sessionId)
            .flatMap((proposal) =>
              proposal.changes
                .filter((change) => change.status === "pending")
                .map(({ label, type, scope }) => ({ label, type, scope })),
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
      `\n本轮实际本地日期为${calendar.today}，时区为${context.timezone}。相对日期、今天以及会话记忆中的本轮日期均据此确定。`,
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

      return {
        activeTools: [
          "readConversation",
          "calculateCapacity",
          "readTask",
          "prepareTurn",
        ],
      };
    },
    onStepEnd: (step) => {
      if (step.toolCalls.length === 0 && step.text.trim()) {
        finalText = step.text;
        if (!streamFinalReply) emit({ type: "text", text: step.text });
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
      readTask: tool({
        description: "按任务ID查看完整任务、子任务与历史安排。",
        inputSchema: z.object({ taskId: z.string() }),
        execute: async ({ taskId }) => {
          emit({ type: "status", text: "正在查看相关任务背景…" });
          return {
            task: state.tasks.find((t) => t.id === taskId) ?? null,
            children: state.tasks.filter((t) => t.parentId === taskId),
            arrangements: state.arrangements.filter((a) => a.taskId === taskId),
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
    if (event.type === "error") streamError = true;
    if (event.type === "tool-error")
      validationErrors.push(String(event.error).slice(0, 1000));
  }
  signal.throwIfAborted();
  if (streamError || !finalText || !prepared) {
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
      draft.patch.goal ? `目标为${draft.patch.goal}` : "",
      draft.patch.deadline ? `截止日期为${draft.patch.deadline}` : "",
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
    actions: prepared ?? [],
    ...(memory ? { memory } : {}),
  };
  applyAgentTurn(state, sessionId, userText, turn);
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
      load: () => State;
      execute: (revision: number, command: Command) => State;
      commitAgentTurn: (
        revision: number,
        sessionId: string,
        userText: string,
        turn: AgentTurn,
        replyId?: string,
      ) => State;
    },
    private connection: () => Connection,
    private generate: typeof generateAgentTurn = generateAgentTurn,
  ) {}
  cancel(runId: string) {
    if (this.active?.runId === runId) this.active.controller.abort();
  }
  async send(
    input: unknown,
    emit: (event: AgentEvent) => void,
  ): Promise<State> {
    const request = z
      .object({
        runId: z.string().uuid(),
        sessionId: z.string(),
        text: z.string().trim().min(1).max(20000),
        focusedId: z.string().nullable(),
      })
      .parse(input);
    let state = this.database.load();
    const messageId = `${request.runId}:user`;
    const replyId = `${request.runId}:assistant`;
    const previousMessage = state.messages.find((m) => m.id === messageId);
    if (
      previousMessage &&
      (previousMessage.sessionId !== request.sessionId ||
        previousMessage.text !== request.text)
    )
      throw new Error("请求标识已经用于其他消息，请重新发送。");
    // 成功标识与结果在同一事务保存，重启后也能识别重试。
    if (state.messages.some((m) => m.id === replyId)) return state;
    if (this.active) throw new Error("已有一轮分析正在进行，请等待或取消。");
    const connection = this.connection();
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
          },
        });
      const snapshot = planningSnapshot(state);
      const { turn } = await this.generate({
        state,
        sessionId: request.sessionId,
        focusedId: request.focusedId,
        userText: request.text,
        connection,
        signal: controller.signal,
        emit: (event) => emit({ ...event, runId: request.runId }),
      });
      controller.signal.throwIfAborted();
      const latest = this.database.load();
      if (planningSnapshot(latest) !== snapshot)
        throw new Error("分析期间任务或状态已变化，请根据最新数据重新发送。");
      // 从最后一次读取到事务写入之间无await，取消和其他IPC无法插入半轮提交。
      const next = this.database.commitAgentTurn(
        latest.revision,
        request.sessionId,
        request.text,
        turn,
        replyId,
      );
      return next;
    } catch (error) {
      if (controller.signal.aborted)
        throw new Error("本轮分析已取消或超时，本轮业务变更未提交。");
      // provider错误可能包含请求头或响应原文，只对外返回有限的应用错误。
      if (
        error instanceof Error &&
        /分析期间|模型未生成|对话不存在/.test(error.message)
      )
        throw error;
      throw new Error("模型调用或结果校验失败，请检查服务配置，稍后重试。");
    } finally {
      clearTimeout(timeout);
      this.active = undefined;
    }
  }
}
