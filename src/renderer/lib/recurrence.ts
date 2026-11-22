import {
  localDate,
  taskSubtreeIds,
  type RecurrenceRule,
  type Task,
} from "../../domain/model";

export const weekdays = [
  [1, "周一"],
  [2, "周二"],
  [3, "周三"],
  [4, "周四"],
  [5, "周五"],
  [6, "周六"],
  [0, "周日"],
] as const;

export function tomorrow(date: string) {
  const day = new Date(`${date}T12:00:00`);
  day.setDate(day.getDate() + 1);
  return localDate(day);
}

export function recurrenceLabel(rule: RecurrenceRule) {
  if (rule.type === "daily") return "每天";
  if (rule.type === "range") return `${rule.start} 至 ${rule.end} · 每天`;
  const days = weekdays.filter(([day]) => rule.weekdays.includes(day));
  const workweek =
    days.length === 5 && days.every(([day]) => day >= 1 && day <= 5);
  return workweek ? "每周一至周五" : days.map(([, label]) => label).join("、");
}

export function affectedRecurringTasks(tasks: Task[], ids: string[]) {
  const affected = taskSubtreeIds(tasks, ids);
  return tasks.filter((task) => task.recurrence && affected.has(task.id));
}
