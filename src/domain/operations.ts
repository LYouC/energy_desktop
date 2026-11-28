import {
  commandSchema,
  arrangementSchema,
  taskPatchSchema,
  stateSchema,
  taskSubtreeIds,
  type State,
  type Task,
  type Command,
  type Change,
  type Proposal,
  type Arrangement,
  newTask,
  newSession,
  localDate,
} from "./model";
import { deleteConversation, trimConversations } from "./conversations";
import {
  effectiveRecurrences,
  findOccurrence,
  latestRecurrenceDate,
  nextRecurrenceDate,
  recurrenceProgress,
  synchronizeRecurrence,
  taskAncestorIds,
} from "./recurrence";
import { z } from "zod";

function findTask(state: State, id: string) {
  const task = state.tasks.find((item) => item.id === id);
  if (!task) throw new Error("任务已被删除。");
  return task;
}
export function isTaskOpen(task: Task) {
  return task.status !== "done" && task.status !== "abandoned";
}

export function isArrangementDone(item: Arrangement, task?: Task) {
  return item.recurrence ? item.done : task?.status === "done";
}

export function isArrangementPending(item: Arrangement, task?: Task) {
  return (
    !isArrangementDone(item, task) &&
    (Boolean(item.recurrence) || task?.status !== "abandoned")
  );
}

function unplannedOrdinaryTasks(state: State, date: string) {
  const recurrences = effectiveRecurrences(state.tasks);
  const planned = new Set(
    state.arrangements
      .filter((item) => item.date === date)
      .map((item) => item.taskId),
  );
  for (const { arrangement } of state.skippedOccurrences)
    if (arrangement.date === date) planned.add(arrangement.taskId);
  return state.tasks.filter(
    (task) => !recurrences.get(task.id) && !planned.has(task.id),
  );
}

export function schedulableTodayTasks(state: State, date: string) {
  return unplannedOrdinaryTasks(state, date).filter(isTaskOpen);
}

export function unscheduledTasksDue(state: State, date: string) {
  return schedulableTodayTasks(state, date).filter(
    (task) => task.expectedDate === date,
  );
}

export function completedUnscheduledTasksDue(state: State, date: string) {
  return unplannedOrdinaryTasks(state, date).filter(
    (task) => task.status === "done" && task.expectedDate === date,
  );
}

export function hasCompletedAncestor(
  state: State,
  taskId: string,
  date?: string,
) {
  const tasks = new Map(state.tasks.map((task) => [task.id, task]));
  return taskAncestorIds(tasks, taskId).some((id) =>
    date
      ? findOccurrence(state, id, date)?.done ||
        (state.repeatSchedules.some((entry) => entry.taskId === id) &&
          state.repeatCompletions.some(
            (entry) => entry.taskId === id && entry.date === date,
          ))
      : tasks.get(id)?.status === "done",
  );
}

function completeOrdinarySubtree(state: State, taskId: string, now: string) {
  const ids = taskSubtreeIds(state.tasks, [taskId]);
  for (const member of state.tasks) {
    if (!ids.has(member.id) || member.status === "done") continue;
    member.status = "done";
    member.version++;
    member.updatedAt = now;
  }
}

function setTaskDone(state: State, taskId: string, done: boolean, now: string) {
  const task = findTask(state, taskId);
  const recurrences = effectiveRecurrences(state.tasks);
  if (recurrences.get(taskId)) throw new Error("请完成或撤销当前轮次。");
  if (task.status === "abandoned") throw new Error("请先恢复已放弃的任务。");
  if (done) return completeOrdinarySubtree(state, taskId, now);
  if (task.status !== "done") return;
  if (hasCompletedAncestor(state, taskId))
    throw new Error("请先恢复已完成的上级任务。");
  task.status = "todo";
  task.version++;
  task.updatedAt = now;
}
function checkRelations(tasks: Task[]) {
  for (const task of tasks) {
    const visit = (id: string, path: Set<string>) => {
      if (path.has(id)) throw new Error("父子关系形成了循环。");
      const current = tasks.find((item) => item.id === id);
      if (!current) throw new Error("关联任务不存在。");
      if (current.parentId) visit(current.parentId, new Set([...path, id]));
    };
    visit(task.id, new Set());
  }
}
function checkDates(task: Task) {
  for (const date of [task.startDate, task.expectedDate])
    if (date && !z.iso.date().safeParse(date).success)
      throw new Error("请选择有效的任务日期。");
  if (task.startDate && task.expectedDate && task.startDate > task.expectedDate)
    throw new Error("预计完成日期不能早于预计开始日期。");
}
export function checkRecurringTaskPatch(
  patch: z.infer<typeof taskPatchSchema>,
) {
  if (patch.startDate !== undefined || patch.expectedDate !== undefined)
    throw new Error("重复任务使用规则表达起止日期，请核实重复范围。");
  if (patch.status !== undefined)
    throw new Error("重复任务按轮次记录完成，请操作当前轮次。");
}

function checkRecurrence(task: Task, old: Task | undefined, date: string) {
  const rule = task.recurrence;
  if (task.parentId && rule) throw new Error("子任务沿用父任务的重复规则。");
  if (!rule && old?.recurrence && !task.parentId)
    throw new Error("请使用停止重复或删除任务。");
  if (!rule) return;
  if (task.status === "done" || task.status === "abandoned")
    throw new Error("请先恢复任务，再设置重复。");
  if (JSON.stringify(rule) === JSON.stringify(old?.recurrence)) return;
  if (rule.type === "range") {
    const continuingRange =
      old?.recurrence?.type === "range" && old.recurrence.start === rule.start;
    if (rule.start < date && !continuingRange)
      throw new Error("重复开始日期不能早于今天。");
    if (rule.end < date) throw new Error("重复结束日期不能早于今天。");
  }
}
function advanceArrangementVersion(state: State, arrangement: Arrangement) {
  if (arrangement.recurrence) arrangement.recurrence.version++;
  else findTask(state, arrangement.taskId).version++;
}
function schedule(state: State, taskId: string, date: string, scope: string) {
  const task = findTask(state, taskId);
  if (effectiveRecurrences(state.tasks).get(taskId))
    throw new Error("请编辑重复规则来调整日期。");
  if (["done", "abandoned"].includes(task.status))
    throw new Error("请先恢复任务，再安排推进。");
  if (!z.iso.date().safeParse(date).success)
    throw new Error("请选择有效的安排日期。");
  const existing = state.arrangements.find(
    (item) => item.taskId === taskId && item.date === date,
  );
  if (
    state.skippedOccurrences.some(
      ({ arrangement }) =>
        arrangement.taskId === taskId && arrangement.date === date,
    )
  )
    throw new Error("请在今日安排中调整这次重复任务。");
  if (existing) {
    existing.scope = scope;
    existing.done = false;
  } else state.arrangements.push({ taskId, date, scope, done: false });
  task.version++;
}
function removeArrangement(state: State, taskId: string, date: string) {
  const index = state.arrangements.findIndex(
    (item) => item.taskId === taskId && item.date === date,
  );
  if (index < 0) throw new Error("原安排已不存在。");
  if (state.arrangements[index].recurrence)
    throw new Error("请从今天移除这次重复任务。");
  state.arrangements.splice(index, 1);
  findTask(state, taskId).version++;
}
export function pendingOccurrenceDescendants(
  state: State,
  taskId: string,
  date: string,
) {
  const tasks = new Map(state.tasks.map((task) => [task.id, task]));
  const recurrences = effectiveRecurrences(state.tasks);
  const sourceId = recurrences.get(taskId)?.sourceId;
  return state.arrangements.filter(
    (item) =>
      item.date === date &&
      !item.done &&
      item.recurrence &&
      recurrences.get(item.taskId)?.sourceId === sourceId &&
      taskAncestorIds(tasks, item.taskId).includes(taskId),
  );
}

function setOccurrenceDone(
  state: State,
  taskId: string,
  date: string,
  done: boolean,
  today: string,
  descendantIds?: readonly string[],
) {
  const task = findTask(state, taskId);
  if (date > today) throw new Error("这一轮还没到应做日期。");
  const item = date === today ? findOccurrence(state, taskId, date) : undefined;
  if (task.recurrence) {
    const schedule = state.repeatSchedules.find(
      (entry) => entry.taskId === taskId,
    )!;
    const completions = state.repeatCompletions.filter(
      (entry) => entry.taskId === taskId,
    );
    const progress = recurrenceProgress(
      task.recurrence,
      schedule,
      completions,
      today,
    );
    const completed = completions.find((entry) => entry.date === date);
    if (done ? Boolean(completed) : !completed) return;
    if (done && !(progress.canComplete && progress.target === date))
      throw new Error("当前无法完成这一轮，请核对日期。");
    if (!done && progress.undo !== date && !item?.done)
      throw new Error("这一轮已无法撤销完成。");
    if (done)
      state.repeatCompletions.push({ taskId, date, completedOn: today });
    else
      state.repeatCompletions = state.repeatCompletions.filter(
        (entry) => entry !== completed,
      );
    if (!item) task.version++;
  } else if (!item) {
    throw new Error("这次重复任务已变化，只能记录今天已安排的重复子任务。");
  } else if (!done && item.done && hasCompletedAncestor(state, taskId, date)) {
    throw new Error("请先撤销已完成的上级任务的本轮完成。");
  }
  if (!item) return;
  const descendants = done
    ? pendingOccurrenceDescendants(state, taskId, date).filter(
        (item) => !descendantIds || descendantIds.includes(item.taskId),
      )
    : [];
  for (const occurrence of [item, ...descendants]) {
    if (occurrence.done === done) continue;
    occurrence.done = done;
    advanceArrangementVersion(state, occurrence);
  }
}
function activeOccurrence(
  state: State,
  taskId: string,
  date: string,
  today: string,
) {
  if (date !== today) throw new Error("只能调整当天的重复任务。");
  const index = state.arrangements.findIndex(
    (item) => item.taskId === taskId && item.date === date && item.recurrence,
  );
  if (index < 0) throw new Error("这次重复任务已变化，请刷新后重试。");
  return index;
}
type SkippedOccurrence = State["skippedOccurrences"][number];

function occurrencePosition(taskIds: string[], skipped: SkippedOccurrence) {
  for (const id of skipped.nextTaskIds) {
    const position = taskIds.indexOf(id);
    if (position >= 0) return position;
  }
  for (const id of skipped.previousTaskIds) {
    const position = taskIds.indexOf(id);
    if (position >= 0) return position + 1;
  }
  return taskIds.length;
}
function skipOccurrence(
  state: State,
  taskId: string,
  date: string,
  today: string,
) {
  const index = activeOccurrence(state, taskId, date, today);
  const arrangement = state.arrangements[index];
  if (arrangement.done) throw new Error("请先恢复这次已完成的重复任务。");
  const schedule = state.repeatSchedules.find(
    (entry) => entry.taskId === taskId,
  );
  if (schedule) {
    schedule.skippedDate = today;
    const recurrences = effectiveRecurrences(state.tasks);
    const group = state.arrangements.filter(
      (item) =>
        item.date === today &&
        recurrences.get(item.taskId)?.sourceId === taskId,
    );
    for (const item of group) skipOccurrenceMember(state, item, taskId);
  } else skipOccurrenceMember(state, arrangement);
}
function skipOccurrenceMember(
  state: State,
  arrangement: Arrangement,
  groupRootId?: string,
) {
  const { taskId, date } = arrangement;
  const skipped = state.skippedOccurrences;
  const taskIds = state.arrangements
    .filter((item) => item.date === date)
    .map((item) => item.taskId);
  // Rebuild the queue in reverse removal order so later removals still have
  // neighbors that were hidden when the action was taken.
  for (const item of [...skipped].reverse()) {
    if (item.arrangement.date === date)
      taskIds.splice(
        occurrencePosition(taskIds, item),
        0,
        item.arrangement.taskId,
      );
  }
  const position = taskIds.indexOf(taskId);
  skipped.push({
    arrangement,
    previousTaskIds: taskIds.slice(0, position).reverse(),
    nextTaskIds: taskIds.slice(position + 1),
    groupRootId,
  });
  state.arrangements.splice(state.arrangements.indexOf(arrangement), 1);
  advanceArrangementVersion(state, arrangement);
}
function restoreOccurrence(
  state: State,
  taskId: string,
  date: string,
  today: string,
) {
  if (date !== today) throw new Error("只能撤销当天移除的重复任务。");
  const repeat = effectiveRecurrences(state.tasks).get(taskId);
  const schedule = state.repeatSchedules.find(
    (entry) => entry.taskId === repeat?.sourceId,
  );
  if (
    !repeat ||
    schedule?.stoppedOn ||
    nextRecurrenceDate(repeat.rule, today) !== today
  )
    throw new Error("今天已无这项重复安排。");
  const removed = state.skippedOccurrences.find(
    ({ arrangement }) =>
      arrangement.taskId === taskId && arrangement.date === date,
  );
  if (!removed) throw new Error("没有可恢复的重复任务。");
  if (removed.groupRootId && removed.groupRootId !== taskId)
    throw new Error("请从重复任务恢复整组安排。");
  if (schedule?.taskId === taskId) {
    delete schedule.skippedDate;
    for (const member of [...state.skippedOccurrences].reverse()) {
      if (member.groupRootId === taskId) restoreOccurrenceMember(state, member);
    }
  } else restoreOccurrenceMember(state, removed);
}
function restoreOccurrenceMember(state: State, removed: SkippedOccurrence) {
  const skipped = state.skippedOccurrences;
  skipped.splice(skipped.indexOf(removed), 1);
  const { date } = removed.arrangement;
  const dayIndices = state.arrangements.flatMap((item, position) =>
    item.date === date ? [position] : [],
  );
  const taskIds = dayIndices.map(
    (position) => state.arrangements[position].taskId,
  );
  const position =
    dayIndices[occurrencePosition(taskIds, removed)] ??
    (dayIndices.at(-1) ?? state.arrangements.length - 1) + 1;
  state.arrangements.splice(position, 0, removed.arrangement);
  advanceArrangementVersion(state, removed.arrangement);
}
function saveTask(state: State, input: Task, date: string, now: string) {
  const old = state.tasks.find((task) => task.id === input.id);
  if (!old && input.version !== 0)
    throw new Error("任务已被删除，请刷新后重试。");
  if (old && old.version !== input.version)
    throw new Error("任务已更新，请重新打开详情。");
  const task = {
    ...input,
    version: (old?.version ?? 0) + 1,
    updatedAt: now,
  };
  checkDates(task);
  const ruleChanged = old
    ? old.parentId !== task.parentId ||
      JSON.stringify(old.recurrence) !== JSON.stringify(task.recurrence)
    : Boolean(task.parentId || task.recurrence);
  const previousRecurrences = ruleChanged
    ? effectiveRecurrences(state.tasks)
    : undefined;
  checkRecurrence(task, old, date);
  if (old?.recurrence && task.parentId) {
    state.repeatSchedules = state.repeatSchedules.filter(
      (entry) => entry.taskId !== task.id,
    );
  }
  if (
    task.recurrence &&
    old?.recurrence &&
    JSON.stringify(task.recurrence) !== JSON.stringify(old.recurrence)
  ) {
    const schedule = state.repeatSchedules.find(
      (entry) => entry.taskId === task.id,
    )!;
    const previous = !schedule.stoppedOn
      ? latestRecurrenceDate(old.recurrence, schedule, date)
      : null;
    schedule.since = date;
    schedule.previousDate =
      previous &&
      previous < date &&
      nextRecurrenceDate(task.recurrence, previous) === previous
        ? previous
        : undefined;
  }
  if (old) state.tasks[state.tasks.indexOf(old)] = task;
  else state.tasks.push(task);
  checkRelations(state.tasks);
  const recurrences = effectiveRecurrences(state.tasks);
  if (!recurrences.get(task.id)) {
    if (hasCompletedAncestor(state, task.id)) {
      if (
        old &&
        old.parentId === task.parentId &&
        old.status === "done" &&
        task.status !== "done"
      )
        throw new Error("请先恢复已完成的上级任务。");
      task.status = "done";
    }
    if (task.status === "done") completeOrdinarySubtree(state, task.id, now);
  }

  if (previousRecurrences) {
    const moved =
      old && old.parentId !== task.parentId
        ? taskSubtreeIds(state.tasks, [task.id])
        : undefined;
    const leftSource = new Set<string>();
    for (const member of state.tasks) {
      const previous = previousRecurrences.get(member.id);
      const current = recurrences.get(member.id);
      if (
        moved?.has(member.id) &&
        previous &&
        previous.sourceId !== current?.sourceId
      )
        leftSource.add(member.id);
      if (member === task) continue;
      if (
        (current && moved?.has(member.id)) ||
        JSON.stringify(previous) !== JSON.stringify(current)
      )
        member.version++;
    }
    if (leftSource.size) {
      for (const item of state.arrangements) {
        if (!item.recurrence || !item.done || !leftSource.has(item.taskId))
          continue;
        item.done = false;
        item.recurrence.version++;
      }
    }
    synchronizeRecurrence(state, date);
  }
}
function deleteTask(state: State, id: string) {
  findTask(state, id);
  const ids = taskSubtreeIds(state.tasks, [id]);
  state.tasks = state.tasks.filter((task) => !ids.has(task.id));
  state.arrangements = state.arrangements.filter(
    (item) => !ids.has(item.taskId),
  );
  state.skippedOccurrences = state.skippedOccurrences.filter(
    ({ arrangement }) => !ids.has(arrangement.taskId),
  );
  state.repeatSchedules = state.repeatSchedules.filter(
    (item) => !ids.has(item.taskId),
  );
  state.repeatCompletions = state.repeatCompletions.filter(
    (item) => !ids.has(item.taskId),
  );
}
function setRecurrenceStopped(
  state: State,
  taskId: string,
  stopped: boolean,
  date: string,
  now: string,
) {
  const task = findTask(state, taskId);
  const schedule = state.repeatSchedules.find(
    (entry) => entry.taskId === taskId,
  );
  if (!task.recurrence || !schedule)
    throw new Error("请选择设置了规则的重复任务。");
  if (Boolean(schedule.stoppedOn) === stopped) return;
  if (stopped) schedule.stoppedOn = date;
  else {
    schedule.since = date;
    delete schedule.previousDate;
    delete schedule.stoppedOn;
  }
  task.version++;
  task.updatedAt = now;
  const recurrences = effectiveRecurrences(state.tasks);
  for (const member of state.tasks) {
    if (member.id !== taskId && recurrences.get(member.id)?.sourceId === taskId)
      member.version++;
  }
  synchronizeRecurrence(state, date);
}

function isOccurrenceChange(change: Change) {
  return (
    change.type === "setOccurrenceDone" ||
    change.type === "skipOccurrence" ||
    change.type === "restoreOccurrence"
  );
}

function isRecurringChange(change: Change) {
  return (
    isOccurrenceChange(change) ||
    change.type === "updateRecurrence" ||
    change.type === "deleteRecurringTask" ||
    change.type === "stopRecurrence" ||
    change.type === "resumeRecurrence"
  );
}

function checkChangeVersion(state: State, change: Change) {
  const task = findTask(state, change.taskId);
  if (task.version !== change.taskVersion) {
    const sourceDate =
      change.fromDate ?? (change.type === "unschedule" ? change.date : "");
    if (
      sourceDate &&
      !state.arrangements.some(
        (item) =>
          item.taskId === (change.fromTaskId ?? change.taskId) &&
          item.date === sourceDate,
      )
    )
      throw new Error("原安排已不存在。");
    throw new Error("任务已变化，这部分方案需要重新分析。");
  }
}

function checkRecurringTarget(state: State, change: Change, today: string) {
  if ((change.asOfDate ?? change.date) !== today)
    throw new Error("本地日期已变化，请重新核对这项重复任务操作。");
  if (
    !isOccurrenceChange(change) ||
    (change.type === "setOccurrenceDone" && change.date !== today)
  )
    return;
  const occurrence = findOccurrence(
    state,
    change.taskId,
    change.date,
    change.type === "restoreOccurrence",
  );
  if (
    !occurrence ||
    !change.occurrence?.recurrence ||
    occurrence.scope !== change.occurrence.scope ||
    occurrence.done !== change.occurrence.done ||
    occurrence.recurrence?.version !== change.occurrence.recurrence.version
  )
    throw new Error("这次重复任务已变化，请重新核对当天安排。");
}

function checkCompletionScope(state: State, change: Change, today: string) {
  if (
    change.type !== "setOccurrenceDone" ||
    !change.done ||
    change.date !== today
  )
    return;
  const pending = pendingOccurrenceDescendants(state, change.taskId, today);
  const confirmed = new Set(change.descendantIds);
  if (
    pending.length !== confirmed.size ||
    pending.some((item) => !confirmed.has(item.taskId))
  )
    throw new Error("子任务的今日完成范围已变化，请重新核对。");
}

function applyRecurringChange(
  state: State,
  change: Change,
  today: string,
  now: string,
) {
  if (change.type === "stopRecurrence" || change.type === "resumeRecurrence") {
    setRecurrenceStopped(
      state,
      change.taskId,
      change.type === "stopRecurrence",
      today,
      now,
    );
    return;
  }
  if (change.type === "updateRecurrence") {
    if (!change.recurrence) throw new Error("重复规则缺失。");
    const task = findTask(state, change.taskId);
    if (!task.recurrence && task.startDate > today) {
      const first = nextRecurrenceDate(change.recurrence, today);
      if (first && first < task.startDate)
        throw new Error("首轮早于预计开始日期，请核实重复规则。");
    }
    saveTask(state, { ...task, recurrence: change.recurrence }, today, now);
    return;
  }
  if (change.type === "deleteRecurringTask") {
    const task = findTask(state, change.taskId);
    if (!effectiveRecurrences(state.tasks).get(task.id))
      throw new Error("请选择重复任务。");
    const descendants = taskSubtreeIds(state.tasks, [task.id]);
    descendants.delete(task.id);
    const expected = new Set(change.descendantIds);
    if (
      !change.descendantIds ||
      descendants.size !== expected.size ||
      ![...descendants].every((id) => expected.has(id))
    )
      throw new Error("子任务范围已变化，请重新核对删除范围。");
    deleteTask(state, task.id);
    return;
  }
  const { taskId, date } = change;
  switch (change.type) {
    case "setOccurrenceDone":
      if (change.done === undefined) throw new Error("本次完成状态缺失。");
      setOccurrenceDone(
        state,
        taskId,
        date,
        change.done,
        today,
        change.descendantIds ?? [],
      );
      break;
    case "skipOccurrence":
      skipOccurrence(state, taskId, date, today);
      break;
    case "restoreOccurrence":
      restoreOccurrence(state, taskId, date, today);
      break;
  }
}

function addProposal(
  state: State,
  proposal: Proposal,
  date: string,
  now: string,
  preview = false,
) {
  if (!state.sessions.some((session) => session.id === proposal.sessionId))
    throw new Error("方案所属对话不存在。");
  if (state.proposals.some((item) => item.id === proposal.id))
    throw new Error("方案已经存在。");
  for (const card of proposal.cards) {
    if (card.status !== "pending") throw new Error("新调整卡必须待接受。");
    for (const change of card.changes) {
      checkChangeVersion(state, change);
      checkCompletionScope(state, change, date);
      if (preview && isRecurringChange(change)) {
        checkRecurringTarget(state, change, date);
        applyRecurringChange(structuredClone(state), change, date, now);
      }
    }
  }
  state.proposals.push(proposal);
}
export function applyCommand(
  previous: State,
  input: Command,
  date = localDate(),
): State {
  const command = commandSchema.parse(input);
  const state: State = structuredClone(previous);
  const now = new Date().toISOString();
  synchronizeRecurrence(state, date);
  switch (command.type) {
    case "saveTask": {
      saveTask(state, command.task, date, now);
      break;
    }
    case "deleteTask":
      deleteTask(state, command.id);
      break;
    case "stopRecurrence":
    case "resumeRecurrence":
      setRecurrenceStopped(
        state,
        command.taskId,
        command.type === "stopRecurrence",
        date,
        now,
      );
      break;
    case "setTaskDone":
      setTaskDone(state, command.taskId, command.done, now);
      break;
    case "schedule":
      schedule(state, command.taskId, command.date, command.scope);
      break;
    case "scheduleToday":
    case "scheduleDueToday": {
      if (command.date !== date) break;
      const eligible =
        command.type === "scheduleDueToday"
          ? unscheduledTasksDue(state, date)
          : schedulableTodayTasks(state, date);
      const task = eligible.find(({ id }) => id === command.taskId);
      if (task) schedule(state, task.id, date, task.title);
      break;
    }
    case "unschedule":
      removeArrangement(state, command.taskId, command.date);
      break;
    case "setOccurrenceDone":
      setOccurrenceDone(
        state,
        command.taskId,
        command.date,
        command.done,
        date,
      );
      break;
    case "skipOccurrence":
      skipOccurrence(state, command.taskId, command.date, date);
      break;
    case "restoreOccurrence":
      restoreOccurrence(state, command.taskId, command.date, date);
      break;
    case "move": {
      const tasks = new Map(state.tasks.map((task) => [task.id, task]));
      const movable = (item: Arrangement) =>
        item.date === command.date &&
        isArrangementPending(item, tasks.get(item.taskId));
      const source = state.arrangements.findIndex(
        (item) => item.taskId === command.taskId && movable(item),
      );
      const target = state.arrangements.findIndex(
        (item) => item.taskId === command.targetTaskId && movable(item),
      );
      if (source >= 0 && target >= 0 && source !== target) {
        if (
          command.date !== date &&
          (state.arrangements[source].recurrence ||
            state.arrangements[target].recurrence)
        )
          throw new Error("只能调整当天的重复任务顺序。");
        [state.arrangements[source], state.arrangements[target]] = [
          state.arrangements[target],
          state.arrangements[source],
        ];
        advanceArrangementVersion(state, state.arrangements[source]);
        advanceArrangementVersion(state, state.arrangements[target]);
      }
      break;
    }
    case "moveTodayGroups": {
      if (command.date !== date) throw new Error("只能调整当天的分组顺序。");
      const source = new Set(command.taskIds);
      const target = new Set(command.targetTaskIds);
      const tasks = new Map(state.tasks.map((task) => [task.id, task]));
      const slots = state.arrangements.flatMap((item, index) =>
        item.date === date &&
        (source.has(item.taskId) || target.has(item.taskId)) &&
        isArrangementPending(item, tasks.get(item.taskId))
          ? [index]
          : [],
      );
      if (
        slots.length !==
        command.taskIds.length + command.targetTaskIds.length
      )
        throw new Error("今日安排已变化，请刷新后重试。");
      const items = slots.map((index) => state.arrangements[index]);
      const sourceItems = items.filter((item) => source.has(item.taskId));
      const targetItems = items.filter((item) => target.has(item.taskId));
      const sourceSlots = items.map((item) => source.has(item.taskId));
      const firstSource = sourceSlots.indexOf(true);
      const firstTarget = sourceSlots.indexOf(false);
      // The first pending slot controls each group's position in the queue.
      sourceSlots[firstSource] = false;
      sourceSlots[firstTarget] = true;
      let sourceIndex = 0;
      let targetIndex = 0;
      const reordered = sourceSlots.map((belongsToSource) =>
        belongsToSource
          ? sourceItems[sourceIndex++]
          : targetItems[targetIndex++],
      );
      for (const [position, index] of slots.entries()) {
        if (state.arrangements[index] !== reordered[position])
          advanceArrangementVersion(state, reordered[position]);
        state.arrangements[index] = reordered[position];
      }
      break;
    }
    case "proposal": {
      addProposal(state, command.proposal, date, now);
      break;
    }
    case "respondToCard": {
      const card = state.proposals
        .find(({ id }) => id === command.proposalId)
        ?.cards.find(({ id }) => id === command.cardId);
      if (!card) throw new Error("找不到这张调整卡。");
      if (card.status !== "pending") return state;
      try {
        return applyCommand(
          state,
          {
            type: "resolve",
            proposalId: command.proposalId,
            cardIds: [command.cardId],
            accept: command.accept,
          },
          date,
        );
      } catch (error) {
        if (
          !command.accept ||
          !(error instanceof Error) ||
          error instanceof z.ZodError
        )
          throw error;
        // resolve 在副本中应用，失败后只保存界面卡片的执行结果。
        card.status = "failed";
        card.failureReason = error.message;
      }
      break;
    }
    case "resolve": {
      const proposal = state.proposals.find(
        (item) => item.id === command.proposalId,
      );
      if (!proposal) throw new Error("找不到这份方案。");
      const cards = [...new Set(command.cardIds)]
        .map((id) => {
          const card = proposal.cards.find((item) => item.id === id);
          if (!card) throw new Error("调整卡范围无效。");
          return card;
        })
        .filter((card) => card.status === "pending");
      if (!cards.length) return state;
      for (const card of cards)
        card.status = command.accept ? "accepted" : "rejected";
      if (!command.accept) break;

      const changes = cards.flatMap((card) => card.changes);
      for (const change of changes) {
        checkChangeVersion(state, change);
        checkCompletionScope(state, change, date);
        if (isRecurringChange(change))
          checkRecurringTarget(state, change, date);
        if (
          change.fromTaskId &&
          findTask(state, change.fromTaskId).version !== change.fromTaskVersion
        ) {
          if (
            !state.arrangements.some(
              (item) =>
                item.taskId === change.fromTaskId &&
                item.date === (change.fromDate ?? change.date),
            )
          )
            throw new Error("原安排已不存在。");
          throw new Error("原安排所属任务已变化，这张调整卡需要重新分析。");
        }
      }
      for (const change of changes) {
        if (isRecurringChange(change)) {
          applyRecurringChange(state, change, date, now);
          continue;
        }
        const recurrences = effectiveRecurrences(state.tasks);
        if (
          (change.type !== "update" &&
            change.type !== "split" &&
            recurrences.get(change.taskId)) ||
          (change.fromTaskId && recurrences.get(change.fromTaskId))
        )
          throw new Error("请选择对应的重复任务操作。");
        if (change.type === "schedule") {
          if (change.newArrangementOnly) {
            if (
              !schedulableTodayTasks(state, change.date).some(
                ({ id }) => id === change.taskId,
              )
            )
              throw new Error("目标日期已有安排，或任务已无法安排。");
          }
          // 同批较早的变更也可能已移除源安排，实际替换前再次检查，失败整批回滚。
          if (
            change.fromTaskId &&
            !state.arrangements.some(
              (item) =>
                item.taskId === change.fromTaskId &&
                item.date === (change.fromDate ?? change.date),
            )
          )
            throw new Error("原安排已不存在，请重新分析替换范围。");
          if (
            change.fromTaskId &&
            (change.fromTaskId !== change.taskId ||
              (change.fromDate ?? change.date) !== change.date)
          )
            removeArrangement(
              state,
              change.fromTaskId,
              change.fromDate ?? change.date,
            );
          else if (change.fromDate && change.fromDate !== change.date)
            removeArrangement(state, change.taskId, change.fromDate);
          schedule(state, change.taskId, change.date, change.scope);
        } else if (change.type === "update") {
          if (!change.patch) throw new Error("任务修改内容缺失。");
          const task = findTask(state, change.taskId);
          if (recurrences.get(task.id)) checkRecurringTaskPatch(change.patch);
          saveTask(
            state,
            {
              ...task,
              ...change.patch,
              ...(change.patch.parentId && task.recurrence
                ? { recurrence: undefined }
                : {}),
            },
            date,
            now,
          );
        } else if (change.type === "unschedule") {
          removeArrangement(state, change.taskId, change.date);
        } else {
          const parent = findTask(state, change.taskId);
          for (const { todayScope, ...child } of change.children) {
            if (todayScope && recurrences.get(parent.id))
              throw new Error("父任务已改为重复任务，无法按卡片安排子任务。");
            const task = {
              ...newTask(parent.id),
              ...child,
            };
            saveTask(state, task, date, now);
            if (todayScope) schedule(state, task.id, change.date, todayScope);
          }
          parent.version++;
          synchronizeRecurrence(state, date);
        }
      }
      break;
    }
    case "energy":
      state.energy = {
        value: command.value,
        source: "用户设置",
        updatedAt: now,
      };
      break;
    case "settings":
      state.preferences = command.preferences;
      state.theme = command.theme;
      break;
    case "reply":
    case "message": {
      if (!state.sessions.some((item) => item.id === command.message.sessionId))
        throw new Error("对话不存在。");
      if (command.type === "reply" && command.proposal) {
        if (
          command.message.role !== "assistant" ||
          command.proposal.sessionId !== command.message.sessionId ||
          command.message.proposalId !== command.proposal.id
        )
          throw new Error("回复与方案关联无效。");
        addProposal(state, command.proposal, date, now, true);
      }
      state.messages.push(command.message);
      const session = state.sessions.find(
        (item) => item.id === command.message.sessionId,
      )!;
      if (command.message.role === "user") {
        if (command.message.source !== "optimizeToday") session.draft = "";
        if (session.title === "新的对话")
          session.title = command.message.text.slice(0, 18);
      }
      break;
    }
    case "draft": {
      const session = state.sessions.find(
        (item) => item.id === command.sessionId,
      );
      if (session) session.draft = command.text;
      break;
    }
    case "session": {
      state.activeSessionId = command.id;
      if (!state.sessions.some((item) => item.id === command.id)) {
        state.sessions.push(newSession(command.id));
        trimConversations(state);
      }
      break;
    }
    case "deleteSession": {
      deleteConversation(state, command.id);
      break;
    }
  }
  synchronizeRecurrence(state, date);
  state.revision++;
  return stateSchema.parse(state);
}
