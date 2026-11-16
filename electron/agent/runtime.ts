import { streamText, tool, stepCountIs } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { z } from "zod";
import {
  agentTurnSchema,
  applyAgentTurn,
  type AgentTurn,
} from "../../shared/agent";
import { buildContext } from "../../shared/context";
import { type Command, type State } from "../../shared/model";
import { agentInstructions } from "./prompt";
import { capacitySchema, calculateCapacity } from "../../shared/capacity";

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
}): Promise<{ turn: AgentTurn; trace: TurnTrace }> {
  const { state, sessionId, userText, connection, signal, emit } = options;
  const provider = createOpenAICompatible({
    name: "siliconflow",
    baseURL: connection.baseURL,
    apiKey: connection.apiKey,
  });
  let staged: AgentTurn | undefined;
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
  const result = streamText({
    model: provider.chatModel(connection.model),
    system: agentInstructions,
    prompt: JSON.stringify({ context, calendar, currentUserMessage: userText }),
    abortSignal: signal,
    maxRetries: 0,
    maxOutputTokens: 6000,
    providerOptions:
      connection.baseURL === "https://api.siliconflow.cn/v1"
        ? { siliconflow: { enable_thinking: false } }
        : undefined,
    // SDK 默认会打印完整 provider 错误。凭据与请求体只留在调用进程内。
    onError: () => {},
    // SDK 承担唯一工具循环。submitTurn仅暂存，模型没有直接写数据库的工具。
    stopWhen: [stepCountIs(6), () => staged !== undefined],
    toolChoice: "required",
    tools: {
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
      submitTurn: tool({
        description:
          "提交完整中文回复和有限业务动作。提问或纯建议使用空actions。一次提交结束本轮。",
        inputSchema: agentTurnSchema,
        execute: async (turn) => {
          if (staged) throw new Error("本轮已提交。");
          // 在内存预演所有规则，失败会作为工具错误反馈，供同一个循环修正。
          try {
            if (
              /给.{0,5}拆分建议/.test(userText) &&
              !turn.actions.some((action) => action.type === "split")
            )
              throw new Error(
                "本轮用户同时要求拆分建议，请在本次submitTurn的actions里包含mode:proposal的split，创建父任务和拆分建议需同轮提交，不能只创建任务就结束。",
              );
            if (
              /帮我记下|请记录|添加一个任务/.test(userText) &&
              !turn.actions.some((action) =>
                ["createTask", "updateTask", "context"].includes(action.type),
              )
            )
              throw new Error(
                "用户明确要求记录任务，请提交创建或更新动作，不能只在文字中声称已记录。",
              );
            applyAgentTurn(state, sessionId, userText, turn);
          } catch (error) {
            validationErrors.push(
              error instanceof Error
                ? error.message.slice(0, 300)
                : "业务校验失败",
            );
            throw error;
          }
          staged = turn;
          return { validated: true, actions: turn.actions.length };
        },
      }),
    },
  });
  const toolInputs = new Map<string, string>();
  const previews = new Map<string, string>();
  for await (const event of result.fullStream) {
    if (event.type === "text-delta") emit({ type: "text", text: event.text });
    if (event.type === "tool-input-start" && event.toolName === "submitTurn")
      toolInputs.set(event.id, "");
    if (event.type === "tool-input-delta" && toolInputs.has(event.id)) {
      const input = toolInputs.get(event.id)! + event.delta;
      toolInputs.set(event.id, input);
      // 仅预览JSON中完整可解码的text前缀，动作参数仍须等完整工具校验。
      const match = /"text"\s*:\s*"((?:[^"\\]|\\.)*)/s.exec(input);
      if (match)
        try {
          const text = JSON.parse('"' + match[1] + '"') as string;
          const previous = previews.get(event.id) || "";
          if (text.startsWith(previous) && text.length > previous.length)
            emit({ type: "text", text: text.slice(previous.length) });
          previews.set(event.id, text);
        } catch {}
    }
    if (event.type === "error") streamError = true;
    if (event.type === "tool-error")
      validationErrors.push(String(event.error).slice(0, 1000));
  }
  signal.throwIfAborted();
  if (streamError || !staged) {
    const failure = new Error(
      "模型未生成可应用的完整结果，请重试或明确操作范围。",
    );
    Object.assign(failure, { validationErrors });
    throw failure;
  }
  const usage = await result.totalUsage;
  const steps = await result.steps;
  return {
    turn: staged,
    trace: {
      steps: steps.length,
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      actions: staged.actions.length,
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
