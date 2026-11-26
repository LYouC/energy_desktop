import type { Arrangement, RecurrenceRule, State, Task } from "./model";

export function taskAncestorIds(tasks: ReadonlyMap<string, Task>, id: string) {
  const ancestors: string[] = [];
  const seen = new Set([id]);
  let parent = tasks.get(id)?.parentId;
  while (parent && !seen.has(parent)) {
    ancestors.push(parent);
    seen.add(parent);
    parent = tasks.get(parent)?.parentId;
  }
  return ancestors;
}

export function arrangementAncestorIds(
  tasks: ReadonlyMap<string, Task>,
  item: Arrangement,
) {
  return item.recurrence
    ? item.recurrence.ancestorIds
    : taskAncestorIds(tasks, item.taskId);
}

export function occurrenceSnapshot(
  tasks: ReadonlyMap<string, Task>,
  task: Task,
) {
  return {
    title: task.title,
    ancestorIds: taskAncestorIds(tasks, task.id),
    version: 0,
  };
}

export function effectiveRecurrences(tasks: Task[]) {
  type EffectiveRecurrence = { sourceId: string; rule: RecurrenceRule };
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const resolved = new Map<string, EffectiveRecurrence | undefined>();
  const resolving = new Set<string>();
  function resolve(id: string): EffectiveRecurrence | undefined {
    if (resolved.has(id)) return resolved.get(id);
    const task = byId.get(id);
    if (!task || resolving.has(id)) return;
    resolving.add(id);
    const recurrence = task.recurrence
      ? { sourceId: id, rule: task.recurrence }
      : task.parentId
        ? resolve(task.parentId)
        : undefined;
    resolving.delete(id);
    resolved.set(id, recurrence);
    return recurrence;
  }
  for (const task of tasks) resolve(task.id);
  return resolved;
}

export function findOccurrence(
  state: State,
  taskId: string,
  date: string,
  skipped = false,
): Arrangement | undefined {
  const matches = (item: Arrangement) =>
    item.taskId === taskId && item.date === date && item.recurrence;
  return skipped
    ? state.skippedOccurrences.find(({ arrangement }) => matches(arrangement))
        ?.arrangement
    : state.arrangements.find(matches);
}

function utcDay(date: string) {
  return new Date(`${date}T00:00:00.000Z`);
}

function followingDate(date: string): string | null {
  const day = utcDay(date);
  day.setUTCDate(day.getUTCDate() + 1);
  if (!Number.isFinite(day.getTime()) || day.getUTCFullYear() > 9999)
    return null;
  return day.toISOString().slice(0, 10);
}

export function nextRecurrenceDate(
  rule: RecurrenceRule,
  onOrAfter: string,
): string | null {
  const first = utcDay(onOrAfter);
  if (
    !Number.isFinite(first.getTime()) ||
    first.toISOString().slice(0, 10) !== onOrAfter
  )
    return null;
  if (rule.type === "daily") return onOrAfter;
  if (rule.type === "range") {
    if (onOrAfter > rule.end) return null;
    return onOrAfter < rule.start ? rule.start : onOrAfter;
  }
  let date: string | null = onOrAfter;
  for (
    let offset = 0;
    offset < 7 && date;
    offset++, date = followingDate(date)
  ) {
    if (rule.weekdays.includes(utcDay(date).getUTCDay())) return date;
  }
  return null;
}

export function synchronizeRecurrence(state: State, date: string): boolean {
  const cursors = new Map(
    state.repeatCursors.map((cursor) => [cursor.taskId, cursor]),
  );
  const previouslySkipped = state.skippedOccurrences;
  let changed = false;
  const tasks = new Map(state.tasks.map((task) => [task.id, task]));
  if (previouslySkipped.some((item) => item.arrangement.date < date)) {
    state.skippedOccurrences = previouslySkipped.filter(
      (item) => item.arrangement.date >= date,
    );
    changed = true;
  }
  const skipped = state.skippedOccurrences.map(
    ({ arrangement }) => arrangement,
  );

  const recurrences = effectiveRecurrences(state.tasks);
  const templates = state.tasks.flatMap((task) => {
    const rule = recurrences.get(task.id)?.rule;
    return rule ? [{ task, rule }] : [];
  });
  for (const id of cursors.keys()) {
    if (!recurrences.get(id)) {
      cursors.delete(id);
      changed = true;
    }
  }

  const due = templates.filter(({ task, rule }) => {
    const cursor = cursors.get(task.id);
    if (!cursor) return true;
    if (cursor.through >= date) return false;
    return (
      rule.type !== "range" || (cursor.through < rule.end && date >= rule.start)
    );
  });

  const scheduled = new Map<string, Map<string, Arrangement>>();
  if (due.length) {
    const dueIds = new Set(due.map(({ task }) => task.id));
    for (const item of [...state.arrangements, ...skipped]) {
      if (!dueIds.has(item.taskId)) continue;
      const taskDates = scheduled.get(item.taskId) ?? new Map();
      taskDates.set(item.date, item);
      scheduled.set(item.taskId, taskDates);
    }
  }

  for (const { task, rule } of due) {
    const cursor = cursors.get(task.id);
    const start = cursor ? followingDate(cursor.through) : date;
    if (!start) continue;
    const taskDates = scheduled.get(task.id);
    for (
      let occurrenceDate = nextRecurrenceDate(rule, start);
      occurrenceDate && occurrenceDate <= date;
    ) {
      const existing = taskDates?.get(occurrenceDate);
      const snapshot = occurrenceSnapshot(tasks, task);
      if (existing) existing.recurrence ??= snapshot;
      else
        state.arrangements.push({
          taskId: task.id,
          date: occurrenceDate,
          scope: task.title,
          done: false,
          recurrence: snapshot,
        });
      const following = followingDate(occurrenceDate);
      occurrenceDate = following ? nextRecurrenceDate(rule, following) : null;
    }
    const through = rule.type === "range" && rule.end < date ? rule.end : date;
    cursors.set(task.id, { taskId: task.id, through });
    changed = true;
  }

  if (changed) state.repeatCursors = [...cursors.values()];
  return changed;
}
