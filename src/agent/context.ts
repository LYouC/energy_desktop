import {
  localDate,
  type Arrangement,
  type Change,
  type State,
  type Task,
} from "../domain/model";
import { effectiveRecurrences } from "../domain/recurrence";
import { isTaskOpen, unscheduledTasksDue } from "../domain/operations";

export function arrangementForAgent(item: Arrangement, task?: Task) {
  return !item.recurrence && !task?.recurrence && task?.status === "done"
    ? { ...item, taskDone: true }
    : item;
}

export function tasksForAgent(
  tasks: Task[],
): (Task & { recurrenceSourceId?: string })[] {
  const recurrences = effectiveRecurrences(tasks);
  return tasks.map((task) => {
    const recurrence = recurrences.get(task.id);
    return recurrence && !task.recurrence
      ? {
          ...task,
          recurrence: recurrence.rule,
          recurrenceSourceId: recurrence.sourceId,
        }
      : task;
  });
}

export function refersToCurrentTasks(
  change: Change,
  taskIds: ReadonlySet<string>,
) {
  return (
    taskIds.has(change.taskId) &&
    (!change.fromTaskId || taskIds.has(change.fromTaskId))
  );
}

export function buildContext(state: State, sessionId: string, date?: string) {
  const now = new Date();
  const today = localDate(now);
  date ??= today;
  const tasks = tasksForAgent(state.tasks);
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const taskIds = new Set(tasks.map((task) => task.id));
  const active = tasks.filter((task) => task.recurrence || isTaskOpen(task));
  const messages = state.messages.filter(
    (message) => message.sessionId === sessionId,
  );
  return {
    date,
    time: `${today} ${now.toTimeString().slice(0, 5)}`,
    energy: state.energy,
    preferences: state.preferences,
    recentResults: tasks
      .filter(
        (task) =>
          !task.recurrence && ["done", "abandoned"].includes(task.status),
      )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 10),
    today: state.arrangements
      .filter(
        (item) =>
          item.date === date &&
          taskIds.has(item.taskId) &&
          (item.done ||
            item.recurrence ||
            tasksById.get(item.taskId)?.recurrence ||
            tasksById.get(item.taskId)?.status !== "abandoned"),
      )
      .map((item) => arrangementForAgent(item, tasksById.get(item.taskId))),
    dueToday: unscheduledTasksDue(state, date),
    skippedToday: (state.skippedOccurrences ?? [])
      .map(({ arrangement }) => arrangement)
      .filter((item) => item.date === date && taskIds.has(item.taskId)),
    unfinishedTasks: active.map((task) => ({
      ...task,
      previousArrangements: state.arrangements.filter(
        (item) =>
          item.taskId === task.id && item.date < date && !item.recurrence,
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
    pendingProposals: state.proposals.flatMap((proposal) => {
      if (proposal.sessionId !== sessionId) return [];
      const cards = proposal.cards.filter((card) =>
        card.changes.every((change) => refersToCurrentTasks(change, taskIds)),
      );
      return cards.some((card) => card.status === "pending")
        ? [{ ...proposal, cards }]
        : [];
    }),
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
