import { localDate, type State } from "../domain/model";

export function buildContext(
  state: State,
  sessionId: string,
  date = localDate(),
) {
  const active = state.tasks.filter(
    (task) => !["done", "abandoned"].includes(task.status),
  );
  const messages = state.messages.filter(
    (message) => message.sessionId === sessionId,
  );
  return {
    date,
    time: new Date().toISOString(),
    energy: state.energy,
    preferences: state.preferences,
    recentResults: state.tasks
      .filter((task) => ["done", "abandoned"].includes(task.status))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 10),
    today: state.arrangements.filter((item) => item.date === date),
    unfinishedTasks: active.map((task) => ({
      ...task,
      previousArrangements: state.arrangements.filter(
        (item) => item.taskId === task.id && item.date < date,
      ),
    })),
    agentMemory:
      state.sessions.find((session) => session.id === sessionId)?.agentMemory ??
      null,
    conversationHistory: {
      totalMessages: messages.length,
      hasEarlierMessages: messages.length > 12,
    },
    recentMessages: messages.slice(-12),
    pendingProposals: state.proposals.filter(
      (proposal) =>
        proposal.sessionId === sessionId &&
        proposal.changes.some((change) => change.status === "pending"),
    ),
  };
}

/** 按消息游标向前取同一会话的历史，供模型核实被近期窗口截掉的原话。 */
export function readConversation(
  state: State,
  sessionId: string,
  beforeMessageId?: string,
  limit = 20,
) {
  const messages = state.messages.filter(
    (message) => message.sessionId === sessionId,
  );
  const end = beforeMessageId
    ? messages.findIndex((message) => message.id === beforeMessageId)
    : messages.length;
  if (end < 0) throw new Error("历史消息游标不属于当前会话。");
  const start = Math.max(0, end - Math.min(40, Math.max(1, limit)));
  const page = messages.slice(start, end);
  return {
    messages: page,
    hasMore: start > 0,
    nextBeforeMessageId: start > 0 ? page[0].id : null,
  };
}
