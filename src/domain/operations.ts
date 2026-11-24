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
  arrangementAncestorIds,
  effectiveRecurrences,
  findOccurrence,
  nextRecurrenceDate,
  occurrenceSnapshot,
  synchronizeRecurrence,
} from "./recurrence";
import { z } from "zod";

function findTask(state: State, id: string) {
  const task = state.tasks.find((item) => item.id === id);
  if (!task) throw new Error("任务已被删除，请刷新后重试。");
  return task;
}
export function isTaskOpen(task: Task) {
  return task.status !== "done" && task.status !== "abandoned";
}

export function isArrangementDone(
  item: Arrangement,
  task?: Task,
  repeats = Boolean(task?.recurrence),
) {
  return item.done || (!item.recurrence && !repeats && task?.status === "done");
}

export function isArrangementPending(
  item: Arrangement,
  task?: Task,
  repeats = Boolean(task?.recurrence),
) {
  return (
    !isArrangementDone(item, task, repeats) &&
    (Boolean(item.recurrence) || repeats || task?.status !== "abandoned")
  );
}

export function unscheduledTasksDue(state: State, date: string) {
  const recurrences = effectiveRecurrences(state.tasks);
  const planned = new Set(
    state.arrangements
      .filter((item) => item.date === date)
      .map((item) => item.taskId),
  );
  for (const { arrangement } of state.skippedOccurrences ?? [])
    if (arrangement.date === date) planned.add(arrangement.taskId);
  return state.tasks.filter(
    (task) =>
      task.expectedDate === date &&
      isTaskOpen(task) &&
      !recurrences.get(task.id) &&
      !planned.has(task.id),
  );
}

function setTaskDone(state: State, taskId: string, done: boolean, now: string) {
  const task = findTask(state, taskId);
  const recurrences = effectiveRecurrences(state.tasks);
  if (recurrences.get(taskId)) throw new Error("请完成或恢复当天的重复实例。");
  if (task.status === "abandoned") throw new Error("请先恢复已放弃的任务。");
  if ((task.status === "done") === done) return;
  const ids = done ? taskSubtreeIds(state.tasks, [taskId]) : new Set([taskId]);
  for (const member of state.tasks) {
    if (!ids.has(member.id) || recurrences.get(member.id)) continue;
    if (done ? !isTaskOpen(member) : member.status !== "done") continue;
    member.status = done ? "done" : "todo";
    member.version++;
    member.updatedAt = now;
  }
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
    throw new Error("重复模板不设置整体状态，请用单次操作记录实例结果。");
}

function checkRecurrence(
  task: Task,
  old: Task | undefined,
  date: string,
  replacesRule: boolean,
) {
  const rule = task.recurrence;
  if (!rule) return;
  if (task.status === "done" || task.status === "abandoned")
    throw new Error("请先恢复任务，再设置重复。");
  if (JSON.stringify(rule) === JSON.stringify(old?.recurrence)) return;
  if (rule.type === "range") {
    const continuingRange =
      old?.recurrence?.type === "range" && old.recurrence.start === rule.start;
    if (rule.start < date && !continuingRange)
      throw new Error("重复开始日期不能早于今天。");
    if (replacesRule && rule.end <= date)
      throw new Error("新规则从明天生效，结束日期需在今天之后。");
  }
}
function advanceArrangementVersion(state: State, arrangement: Arrangement) {
  if (arrangement.recurrence)
    arrangement.occurrenceVersion = (arrangement.occurrenceVersion ?? 0) + 1;
  else findTask(state, arrangement.taskId).version++;
}
function schedule(state: State, taskId: string, date: string, scope: string) {
  const task = findTask(state, taskId);
  if (["done", "abandoned"].includes(task.status))
    throw new Error("请先恢复任务，再安排推进。");
  if (!z.iso.date().safeParse(date).success)
    throw new Error("请选择有效的安排日期。");
  const existing = state.arrangements.find(
    (item) => item.taskId === taskId && item.date === date,
  );
  if (
    existing?.recurrence ||
    state.skippedOccurrences?.some(
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
  if (index < 0) throw new Error("这项安排已变化。");
  if (state.arrangements[index].recurrence)
    throw new Error("请从今天移除这次重复任务。");
  state.arrangements.splice(index, 1);
  findTask(state, taskId).version++;
}
export function pendingStageDescendants(
  state: State,
  taskId: string,
  date: string,
) {
  const tasks = new Map(state.tasks.map((task) => [task.id, task]));
  return state.arrangements.filter(
    (item) =>
      item.date === date &&
      !item.done &&
      arrangementAncestorIds(tasks, item).includes(taskId),
  );
}

function setStage(
  state: State,
  taskId: string,
  date: string,
  done: boolean,
  today: string,
  descendantIds?: readonly string[],
) {
  const item = state.arrangements.find(
    (item) => item.taskId === taskId && item.date === date,
  );
  if (!item) throw new Error("这项安排已变化。");
  if (item.recurrence && date !== today)
    throw new Error("请在今日安排中处理当天的重复任务。");
  const descendants =
    done && date === today
      ? pendingStageDescendants(state, taskId, date).filter(
          (stage) => !descendantIds || descendantIds.includes(stage.taskId),
        )
      : [];
  for (const stage of [item, ...descendants]) {
    if (stage.done === done) continue;
    stage.done = done;
    advanceArrangementVersion(state, stage);
  }
}
function createOccurrence(
  state: State,
  taskId: string,
  date: string,
  scope: string,
  today: string,
) {
  if (date !== today) throw new Error("只能补加当天的重复实例。");
  const task = findTask(state, taskId);
  if (!effectiveRecurrences(state.tasks).get(taskId))
    throw new Error("请选择重复模板。");
  if (findOccurrence(state, taskId, date, true))
    throw new Error("这次安排已移除，请使用撤销移除。");
  if (
    state.arrangements.some(
      (item) => item.taskId === taskId && item.date === date,
    )
  )
    throw new Error("当天已有安排，请调整已有安排。");
  const tasks = new Map(state.tasks.map((item) => [item.id, item]));
  state.arrangements.push({
    taskId,
    date,
    scope,
    done: false,
    recurrence: occurrenceSnapshot(tasks, task),
  });
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
type SkippedOccurrence = NonNullable<State["skippedOccurrences"]>[number];

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
  const skipped = (state.skippedOccurrences ??= []);
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
  });
  state.arrangements.splice(index, 1);
  advanceArrangementVersion(state, arrangement);
}
function restoreOccurrence(
  state: State,
  taskId: string,
  date: string,
  today: string,
) {
  if (date !== today) throw new Error("只能撤销当天移除的重复任务。");
  const skipped = state.skippedOccurrences ?? [];
  const index = skipped.findIndex(
    ({ arrangement }) =>
      arrangement.taskId === taskId && arrangement.date === date,
  );
  if (index < 0) throw new Error("没有可恢复的重复任务。");
  const [removed] = skipped.splice(index, 1);
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
function saveTask(
  state: State,
  input: Extract<Command, { type: "saveTask" }>["task"],
  date: string,
  now: string,
  arrangement?: Extract<Command, { type: "saveTask" }>["arrangement"],
) {
  const old = state.tasks.find((task) => task.id === input.id);
  if (!old && input.version !== 0)
    throw new Error("任务已被删除，请刷新后重试。");
  if (old && old.version !== input.version)
    throw new Error("任务已更新，请重新打开详情。");
  const task = {
    ...input,
    importance:
      input.importance === undefined
        ? (old?.importance ?? null)
        : input.importance,
    version: (old?.version ?? 0) + 1,
    updatedAt: now,
  };
  if (old?.recurrence && !task.recurrence) task.recurrence = old.recurrence;
  checkDates(task);
  const ruleChanged = old
    ? old.parentId !== task.parentId ||
      JSON.stringify(old.recurrence) !== JSON.stringify(task.recurrence)
    : Boolean(task.parentId || task.recurrence);
  const previousRecurrences = ruleChanged
    ? effectiveRecurrences(state.tasks)
    : undefined;
  checkRecurrence(task, old, date, Boolean(previousRecurrences?.get(task.id)));
  if (old) state.tasks[state.tasks.indexOf(old)] = task;
  else state.tasks.push(task);
  checkRelations(state.tasks);
  if (arrangement)
    schedule(state, task.id, arrangement.date, arrangement.scope);
  if (previousRecurrences) {
    const recurrences = effectiveRecurrences(state.tasks);
    const cursors = new Map(
      state.repeatCursors?.map((cursor) => [cursor.taskId, cursor]),
    );
    for (const member of state.tasks) {
      const previous = previousRecurrences.get(member.id);
      const current = recurrences.get(member.id);
      if (JSON.stringify(previous) === JSON.stringify(current)) continue;
      if (member !== task) member.version++;
      const cursor = cursors.get(member.id);
      // A replacement rule starts tomorrow, including when the old range ended.
      if (previous && current && cursor && cursor.through < date)
        cursor.through = date;
    }
    synchronizeRecurrence(state, date);
  }
}
function deleteTask(state: State, id: string) {
  findTask(state, id);
  const ids = taskSubtreeIds(state.tasks, [id]);
  state.tasks = state.tasks.filter((task) => !ids.has(task.id));
  state.arrangements = state.arrangements.filter(
    (item) => item.recurrence || !ids.has(item.taskId),
  );
  if (state.repeatCursors)
    state.repeatCursors = state.repeatCursors.filter(
      (item) => !ids.has(item.taskId),
    );
  for (const proposal of state.proposals)
    for (const card of proposal.cards) {
      if (
        card.status === "pending" &&
        card.changes.some(
          (change) =>
            (ids.has(change.taskId) ||
              (change.fromTaskId && ids.has(change.fromTaskId))) &&
            (!isOccurrenceChange(change) || change.type === "createOccurrence"),
        )
      )
        card.status = "rejected";
    }
}
function updateOccurrenceScope(
  state: State,
  taskId: string,
  date: string,
  scope: string,
  today: string,
) {
  const index = activeOccurrence(state, taskId, date, today);
  const arrangement = state.arrangements[index];
  arrangement.scope = scope;
  advanceArrangementVersion(state, arrangement);
}

function isOccurrenceChange(change: Change) {
  return (
    change.type === "createOccurrence" ||
    change.type === "updateOccurrenceScope" ||
    change.type === "setOccurrenceDone" ||
    change.type === "skipOccurrence" ||
    change.type === "restoreOccurrence"
  );
}

function isRecurringChange(change: Change) {
  return (
    isOccurrenceChange(change) ||
    change.type === "updateRecurrence" ||
    change.type === "deleteRecurringTask"
  );
}

function checkChangeVersion(state: State, change: Change) {
  if (isOccurrenceChange(change) && change.type !== "createOccurrence") {
    if (
      change.taskVersion !== null &&
      !state.tasks.some(({ id }) => id === change.taskId)
    )
      throw new Error("任务已变化，这部分方案需要重新分析。");
    return;
  }
  const version = findTask(state, change.taskId).version;
  if (version !== change.taskVersion)
    throw new Error("任务已变化，这部分方案需要重新分析。");
}

function checkRecurringTarget(state: State, change: Change, today: string) {
  if (change.date !== today)
    throw new Error("本地日期已变化，请重新核对这项重复任务操作。");
  if (!isOccurrenceChange(change) || change.type === "createOccurrence") return;
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
    occurrence.recurrence?.title !== change.occurrence.recurrence.title ||
    (occurrence.occurrenceVersion ?? 0) !==
      (change.occurrence.occurrenceVersion ?? 0)
  )
    throw new Error("这次重复任务已变化，请重新核对当天安排。");
}

function checkCompletionScope(state: State, change: Change, today: string) {
  if (
    (change.type !== "stage" && change.type !== "setOccurrenceDone") ||
    !change.done ||
    change.date !== today
  )
    return;
  const pending = pendingStageDescendants(state, change.taskId, today);
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
  if (change.type === "updateRecurrence") {
    if (!change.recurrence) throw new Error("重复规则缺失。");
    const task = findTask(state, change.taskId);
    if (!task.recurrence && task.startDate > today) {
      const first = nextRecurrenceDate(change.recurrence, today);
      if (first && first < task.startDate)
        throw new Error("规则会在预计开始日期前生成实例，请核实首次重复日期。");
    }
    saveTask(state, { ...task, recurrence: change.recurrence }, today, now);
    return;
  }
  if (change.type === "deleteRecurringTask") {
    const task = findTask(state, change.taskId);
    if (!effectiveRecurrences(state.tasks).get(task.id))
      throw new Error("请选择重复模板。");
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
    case "createOccurrence":
      createOccurrence(
        state,
        taskId,
        date,
        arrangementSchema.shape.scope.parse(change.scope),
        today,
      );
      break;
    case "updateOccurrenceScope":
      updateOccurrenceScope(
        state,
        taskId,
        date,
        arrangementSchema.shape.scope.parse(change.scope),
        today,
      );
      break;
    case "setOccurrenceDone":
      if (change.done === undefined) throw new Error("本次完成状态缺失。");
      activeOccurrence(state, taskId, date, today);
      setStage(
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
      saveTask(state, command.task, date, now, command.arrangement);
      break;
    }
    case "deleteTask":
      deleteTask(state, command.id);
      break;
    case "setTaskDone":
      setTaskDone(state, command.taskId, command.done, now);
      break;
    case "schedule":
      schedule(state, command.taskId, command.date, command.scope);
      break;
    case "scheduleDueToday": {
      if (command.date !== date) break;
      const task = unscheduledTasksDue(state, date).find(
        ({ id }) => id === command.taskId,
      );
      if (task) schedule(state, task.id, date, task.title);
      break;
    }
    case "unschedule":
      removeArrangement(state, command.taskId, command.date);
      break;
    case "stage":
      setStage(state, command.taskId, command.date, command.done, date);
      break;
    case "createOccurrence":
      createOccurrence(
        state,
        command.taskId,
        command.date,
        command.scope,
        date,
      );
      break;
    case "skipOccurrence":
      skipOccurrence(state, command.taskId, command.date, date);
      break;
    case "restoreOccurrence":
      restoreOccurrence(state, command.taskId, command.date, date);
      break;
    case "updateOccurrenceScope":
      updateOccurrenceScope(
        state,
        command.taskId,
        command.date,
        command.scope,
        date,
      );
      break;
    case "move": {
      const source = state.arrangements.findIndex(
        (item) =>
          item.date === command.date &&
          !item.done &&
          item.taskId === command.taskId,
      );
      const target = state.arrangements.findIndex(
        (item) =>
          item.date === command.date &&
          !item.done &&
          item.taskId === command.targetTaskId,
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
      const slots = state.arrangements.flatMap((item, index) =>
        item.date === date &&
        !item.done &&
        (source.has(item.taskId) || target.has(item.taskId))
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
        )
          throw new Error("原安排所属任务已变化，这张调整卡需要重新分析。");
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
          saveTask(state, { ...task, ...change.patch }, date, now);
        } else if (change.type === "unschedule") {
          removeArrangement(state, change.taskId, change.date);
        } else if (change.type === "stage") {
          if (change.done === undefined) throw new Error("阶段完成状态缺失。");
          setStage(
            state,
            change.taskId,
            change.date,
            change.done,
            date,
            change.descendantIds ?? [],
          );
        } else {
          const parent = findTask(state, change.taskId);
          for (const { todayScope, ...child } of change.children) {
            if (
              todayScope &&
              (change.date !== date || recurrences.get(parent.id))
            )
              throw new Error(
                "只能将普通任务拆出的子任务安排到原建议当天，请重新分析。",
              );
            const task = {
              ...newTask(parent.id),
              ...child,
              version: 1,
              updatedAt: now,
            };
            checkDates(task);
            state.tasks.push(task);
            if (todayScope) schedule(state, task.id, date, todayScope);
          }
          parent.version++;
          synchronizeRecurrence(state, date);
        }
      }
      const deletedTemplates = new Set(
        changes
          .filter((change) => change.type === "deleteRecurringTask")
          .flatMap((change) => [
            change.taskId,
            ...(change.descendantIds ?? []),
          ]),
      );
      if (!proposal.legacy) {
        // 同一方案确认了模板删除后，保留其他卡对仍存在的实例的操作资格。
        for (const card of proposal.cards) {
          if (card.status !== "pending" || !deletedTemplates.has(card.taskId))
            continue;
          for (const change of card.changes)
            if (
              isOccurrenceChange(change) &&
              change.type !== "createOccurrence"
            )
              change.taskVersion = null;
        }
        break;
      }
      // 旧方案允许逐项确认，同任务的剩余待定项沿用原先的版本衔接。
      const affectedTasks = new Set(
        changes.flatMap((change) => [
          change.taskId,
          ...(change.fromTaskId ? [change.fromTaskId] : []),
          ...(change.type === "deleteRecurringTask"
            ? (change.descendantIds ?? [])
            : []),
        ]),
      );
      for (const card of proposal.cards) {
        if (card.status !== "pending") continue;
        const [change] = card.changes;
        if (affectedTasks.has(change.taskId))
          change.taskVersion =
            state.tasks.find((task) => task.id === change.taskId)?.version ??
            null;
        if (change.fromTaskId && affectedTasks.has(change.fromTaskId))
          change.fromTaskVersion = findTask(state, change.fromTaskId).version;
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
  state.revision++;
  return stateSchema.parse(state);
}
