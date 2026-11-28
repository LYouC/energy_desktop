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
    const recurrence = task.parentId
      ? resolve(task.parentId)
      : task.recurrence && { sourceId: id, rule: task.recurrence };
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

function shiftedDate(date: string, offset: number): string | null {
  const day = utcDay(date);
  day.setUTCDate(day.getUTCDate() + offset);
  if (
    !Number.isFinite(day.getTime()) ||
    day.getUTCFullYear() > 9999 ||
    day.getUTCFullYear() < 0
  )
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
    offset++, date = shiftedDate(date, 1)
  ) {
    if (rule.weekdays.includes(utcDay(date).getUTCDay())) return date;
  }
  return null;
}

export type RepeatSchedule = State["repeatSchedules"][number];
type RepeatCompletion = State["repeatCompletions"][number];

export function latestRecurrenceDate(
  rule: RecurrenceRule,
  schedule: RepeatSchedule,
  today: string,
) {
  let date: string | null =
    rule.type === "range" ? (today < rule.end ? today : rule.end) : today;
  for (
    let offset = 0;
    offset < 7 && date && date >= schedule.since;
    offset++, date = shiftedDate(date, -1)
  ) {
    if (nextRecurrenceDate(rule, date) === date) return date;
  }
  return schedule.previousDate && schedule.previousDate <= today
    ? schedule.previousDate
    : null;
}

export function recurrenceProgress(
  rule: RecurrenceRule,
  schedule: RepeatSchedule,
  completions: readonly RepeatCompletion[],
  today: string,
) {
  if (schedule.stoppedOn)
    return { target: null, overdue: false, canComplete: false, undo: null };
  const current = latestRecurrenceDate(rule, schedule, today);
  const completed =
    current !== null && completions.some(({ date }) => date === current);
  const pending =
    current && current !== schedule.skippedDate && !completed ? current : null;
  const tomorrow = shiftedDate(today, 1);
  const nextStart =
    tomorrow && (schedule.since > tomorrow ? schedule.since : tomorrow);
  return {
    target: pending ?? (nextStart ? nextRecurrenceDate(rule, nextStart) : null),
    overdue: pending !== null && pending < today,
    canComplete: pending !== null,
    undo: completed ? current : null,
  };
}

export function repeatCompletionsByTask(state: State) {
  const records = new Map<string, RepeatCompletion[]>();
  for (const item of state.repeatCompletions) {
    const list = records.get(item.taskId) ?? [];
    list.push(item);
    records.set(item.taskId, list);
  }
  return records;
}

export function repeatTaskStatuses(state: State, date: string) {
  const completions = repeatCompletionsByTask(state);
  const rules = new Map(state.tasks.map((task) => [task.id, task.recurrence]));
  return new Map(
    state.repeatSchedules.flatMap((schedule) => {
      const rule = rules.get(schedule.taskId);
      if (!rule) return [];
      const records = completions.get(schedule.taskId) ?? [];
      return [
        [
          schedule.taskId,
          {
            ...recurrenceProgress(rule, schedule, records, date),
            stopped: Boolean(schedule.stoppedOn),
            completionCount: records.length,
          },
        ] as const,
      ];
    }),
  );
}

export function synchronizeRecurrence(state: State, date: string): boolean {
  let changed = false;
  const tasks = new Map(state.tasks.map((task) => [task.id, task]));
  const recurrences = effectiveRecurrences(state.tasks);
  const schedules = new Map(
    state.repeatSchedules.map((entry) => [entry.taskId, entry]),
  );
  for (const task of state.tasks) {
    if (task.parentId || !task.recurrence || schedules.has(task.id)) continue;
    const schedule = { taskId: task.id, since: date };
    state.repeatSchedules.push(schedule);
    schedules.set(task.id, schedule);
    changed = true;
  }

  const currentSkips = state.skippedOccurrences.filter(
    ({ arrangement, groupRootId }) =>
      arrangement.date === date &&
      (!groupRootId ||
        recurrences.get(arrangement.taskId)?.sourceId === groupRootId),
  );
  if (currentSkips.length !== state.skippedOccurrences.length) {
    state.skippedOccurrences = currentSkips;
    changed = true;
  }
  const skippedIds = new Set(
    currentSkips.map(({ arrangement }) => arrangement.taskId),
  );
  const completedToday = new Set(
    state.repeatCompletions
      .filter((item) => item.date === date && schedules.has(item.taskId))
      .map((item) => item.taskId),
  );
  const todayItems = new Map(
    state.arrangements
      .filter((item) => item.date === date)
      .map((item) => [item.taskId, item]),
  );
  const visible = new Map<string, string>();
  for (const [id, repeat] of recurrences) {
    if (!repeat) continue;
    const schedule = schedules.get(repeat.sourceId)!;
    if (
      date < schedule.since ||
      schedule.skippedDate === date ||
      skippedIds.has(id) ||
      nextRecurrenceDate(repeat.rule, date) !== date ||
      (schedule.stoppedOn &&
        (schedule.stoppedOn !== date ||
          !completedToday.has(repeat.sourceId) ||
          (id !== repeat.sourceId && !todayItems.get(id)?.done)))
    )
      continue;
    visible.set(id, repeat.sourceId);
  }

  const retained = state.arrangements.filter(
    (item) =>
      (item.date === date && visible.has(item.taskId)) ||
      (!item.recurrence && (item.date < date || !recurrences.get(item.taskId))),
  );
  if (retained.length !== state.arrangements.length) {
    state.arrangements = retained;
    changed = true;
  }
  const completed = new Set(completedToday);
  for (const [id, sourceId] of visible) {
    if (
      id !== sourceId &&
      todayItems.get(id)?.recurrence &&
      todayItems.get(id)?.done
    )
      completed.add(id);
  }
  for (const [id, sourceId] of visible) {
    const task = tasks.get(id)!;
    const existing = todayItems.get(id);
    const done =
      completed.has(id) ||
      (id !== sourceId &&
        taskAncestorIds(tasks, id).some((ancestor) => completed.has(ancestor)));
    if (!existing?.recurrence) {
      const values = {
        scope: task.title,
        done,
        recurrence: { version: 0 },
      };
      if (existing) Object.assign(existing, values);
      else state.arrangements.push({ taskId: id, date, ...values });
      changed = true;
    } else {
      if (existing.done !== done || existing.scope !== task.title) {
        existing.done = done;
        existing.scope = task.title;
        existing.recurrence.version++;
        changed = true;
      }
    }
  }
  return changed;
}
