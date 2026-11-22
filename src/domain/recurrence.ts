import type { Arrangement, RecurrenceRule, State } from "./model";

export function findOccurrence(
  state: State,
  taskId: string,
  date: string,
  skipped = false,
): Arrangement | undefined {
  const matches = (item: Arrangement) =>
    item.taskId === taskId && item.date === date && item.recurrence;
  return skipped
    ? state.skippedOccurrences?.find(({ arrangement }) => matches(arrangement))
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
    state.repeatCursors?.map((cursor) => [cursor.taskId, cursor]),
  );
  const previouslySkipped = state.skippedOccurrences;
  let changed = false;
  if (previouslySkipped?.some((item) => item.arrangement.date < date)) {
    state.skippedOccurrences = previouslySkipped.filter(
      (item) => item.arrangement.date >= date,
    );
    changed = true;
  }

  const templates = state.tasks.filter((task) => task.recurrence);
  const templateIds = new Set(templates.map((task) => task.id));
  for (const id of cursors.keys()) {
    if (!templateIds.has(id)) {
      cursors.delete(id);
      changed = true;
    }
  }

  const due = templates.filter((task) => {
    const cursor = cursors.get(task.id);
    if (!cursor) return true;
    if (cursor.through >= date) return false;
    const rule = task.recurrence;
    return (
      rule?.type !== "range" ||
      (cursor.through < rule.end && date >= rule.start)
    );
  });

  const scheduled = new Map<string, Map<string, Arrangement>>();
  if (due.length) {
    const dueIds = new Set(due.map((task) => task.id));
    for (const item of state.arrangements) {
      if (!dueIds.has(item.taskId)) continue;
      const taskDates = scheduled.get(item.taskId) ?? new Map();
      taskDates.set(item.date, item);
      scheduled.set(item.taskId, taskDates);
    }
  }

  for (const task of due) {
    const rule = task.recurrence;
    if (!rule) continue;
    const cursor = cursors.get(task.id);
    const start = cursor ? followingDate(cursor.through) : date;
    if (!start) continue;
    const taskDates = scheduled.get(task.id);
    for (
      let occurrenceDate = nextRecurrenceDate(rule, start);
      occurrenceDate && occurrenceDate <= date;
    ) {
      const existing = taskDates?.get(occurrenceDate);
      const snapshot = { title: task.title };
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

  if (changed && (state.repeatCursors || cursors.size))
    state.repeatCursors = [...cursors.values()];
  return changed;
}
