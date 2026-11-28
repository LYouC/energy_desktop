import { z } from "zod";

export const energyLabels = [
  "精力充足",
  "状态平稳",
  "有些疲惫",
  "需要恢复",
] as const;
export const statusLabels = {
  todo: "未开始",
  doing: "进行中",
  waiting: "暂停 / 等待",
  done: "整体完成",
  abandoned: "主动放弃",
} as const;
const taskImportance = z.enum(["high", "medium", "low"]);
const taskImportanceSchema = taskImportance.nullable();
export const importanceLabels: Record<
  z.infer<typeof taskImportance>,
  string
> = {
  high: "高",
  medium: "中",
  low: "低",
};
const recurrenceDate = z.iso.date();
export const recurrenceRuleSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("daily") }),
  z.strictObject({
    type: z.literal("weekly"),
    weekdays: z
      .array(z.number().int().min(0).max(6))
      .min(1, "至少选择一个重复星期。")
      .max(7)
      .refine(
        (days) => new Set(days).size === days.length,
        "重复星期不能重复。",
      )
      .transform((days) => days.sort((a, b) => a - b)),
  }),
  z
    .strictObject({
      type: z.literal("range"),
      start: recurrenceDate,
      end: recurrenceDate,
    })
    .refine(({ start, end }) => start <= end, "重复结束日期不能早于开始日期。"),
]);
export type RecurrenceRule = z.infer<typeof recurrenceRuleSchema>;
export const taskSchema = z.object({
  id: z.string(),
  version: z.number().int(),
  title: z.string().trim().min(1).max(200),
  description: z
    .string()
    .describe(
      "该任务自身的说明，按需保留目标、背景、进展、停点、硬截止和前提。",
    ),
  startDate: z
    .string()
    .describe("该任务自身的预计开始日期，YYYY-MM-DD，未知用空字符串。"),
  expectedDate: z
    .string()
    .describe("该任务自身的预计完成日期，YYYY-MM-DD，未知用空字符串。"),
  status: z.enum(["todo", "doing", "waiting", "done", "abandoned"]),
  importance: taskImportanceSchema,
  recurrence: recurrenceRuleSchema.optional(),
  parentId: z.string().nullable(),
  updatedAt: z.string(),
});
export type Task = z.infer<typeof taskSchema>;
export function taskSubtreeIds(
  tasks: readonly Task[],
  rootIds: Iterable<string>,
): Set<string> {
  const ids = new Set(rootIds);
  const children = new Map<string, string[]>();
  for (const task of tasks) {
    if (!task.parentId) continue;
    const siblings = children.get(task.parentId) ?? [];
    siblings.push(task.id);
    children.set(task.parentId, siblings);
  }
  for (const id of ids) {
    for (const child of children.get(id) ?? []) ids.add(child);
  }
  return ids;
}
// 重要性和重复规则分别处理，避免由通用属性修改隐式变更。
export const taskPatchSchema = taskSchema
  .omit({
    id: true,
    version: true,
    updatedAt: true,
    importance: true,
    recurrence: true,
  })
  .partial();
// 拆分只固定所属父任务，其余属性与普通任务一致，简单子任务仅需名称。
export const childTaskSchema = taskPatchSchema.omit({ parentId: true }).extend({
  title: taskSchema.shape.title,
  description: taskSchema.shape.description.default(""),
  todayScope: z.string().trim().min(1).optional(),
});
// 会话工作记忆由模型整理。待创建内容仍留在会话里，用户接受后才成为真实任务。
export const agentMemorySchema = z.object({
  summary: z.string().max(6000),
  taskDraft: z
    .object({
      title: z.string().trim().min(1).max(200),
      patch: taskPatchSchema.strict(),
    })
    .nullable(),
});
export const arrangementSchema = z.object({
  taskId: z.string(),
  date: z.string(),
  scope: z.string().trim().min(1),
  done: z.boolean(),
  recurrence: z
    .object({
      version: z.number().int().nonnegative(),
    })
    .optional(),
});
export type Arrangement = z.infer<typeof arrangementSchema>;
const changeStatus = z.enum(["pending", "accepted", "rejected"]);
const changeSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  taskVersion: z.number().int(),
  label: z.string(),
  type: z.enum([
    "schedule",
    "split",
    "update",
    "unschedule",
    "updateRecurrence",
    "deleteRecurringTask",
    "stopRecurrence",
    "resumeRecurrence",
    "setOccurrenceDone",
    "skipOccurrence",
    "restoreOccurrence",
  ]),
  date: z.string(),
  asOfDate: recurrenceDate.optional(),
  scope: z.string(),
  children: z.array(childTaskSchema.strict()),
  patch: taskPatchSchema.optional(),
  fromDate: z.string().optional(),
  newArrangementOnly: z.literal(true).optional(),
  fromTaskId: z.string().optional(),
  fromTaskTitle: z.string().optional(),
  targetTaskTitle: z.string().optional(),
  originalScope: z.string().optional(),
  fromTaskVersion: z.number().int().optional(),
  done: z.boolean().optional(),
  recurrence: recurrenceRuleSchema.optional(),
  occurrence: arrangementSchema.optional(),
  descendantIds: z.array(z.string()).optional(),
});
export type Change = z.infer<typeof changeSchema>;
const adjustmentCardSchema = z.strictObject({
  id: z.string(),
  taskId: z.string(),
  title: z.string(),
  reason: z.string(),
  status: changeStatus.or(z.literal("failed")),
  failureReason: z.string().optional(),
  previousExpectedDate: z.string().optional(),
  changes: z.array(changeSchema).nonempty(),
});
export type AdjustmentCard = z.infer<typeof adjustmentCardSchema>;
export const proposalSchema = z
  .strictObject({
    id: z.string(),
    sessionId: z.string(),
    createdAt: z.string(),
    cards: z
      .array(adjustmentCardSchema)
      .refine(
        (cards) => new Set(cards.map((card) => card.id)).size === cards.length,
        { message: "调整卡 ID 必须唯一。" },
      ),
  })
  .refine(
    ({ cards }) =>
      cards.every((card) =>
        card.changes.every(
          (change) =>
            change.taskId === card.taskId ||
            (change.type === "schedule" && change.fromTaskId === card.taskId),
        ),
      ) && new Set(cards.map((card) => card.taskId)).size === cards.length,
    { message: "调整卡必须按任务分组。" },
  );
export type Proposal = z.infer<typeof proposalSchema>;
export const stateSchema = z.object({
  revision: z.number().int(),
  tasks: z.array(taskSchema),
  arrangements: z.array(arrangementSchema),
  repeatSchedules: z.array(
    z.object({
      taskId: z.string(),
      since: recurrenceDate,
      previousDate: recurrenceDate.optional(),
      skippedDate: recurrenceDate.optional(),
      stoppedOn: recurrenceDate.optional(),
    }),
  ),
  repeatCompletions: z.array(
    z.object({
      taskId: z.string(),
      date: recurrenceDate,
      completedOn: recurrenceDate,
    }),
  ),
  skippedOccurrences: z.array(
    z.object({
      arrangement: arrangementSchema,
      previousTaskIds: z.array(z.string()),
      nextTaskIds: z.array(z.string()),
      groupRootId: z.string().optional(),
    }),
  ),
  proposals: z.array(proposalSchema),
  sessions: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      draft: z.string(),
      createdAt: z.string(),
      agentMemory: agentMemorySchema.optional(),
    }),
  ),
  activeSessionId: z.string(),
  messages: z.array(
    z.object({
      id: z.string(),
      sessionId: z.string(),
      role: z.enum(["user", "assistant"]),
      text: z.string(),
      createdAt: z.string(),
      proposalId: z.string().optional(),
      source: z.literal("optimizeToday").optional(),
    }),
  ),
  energy: z.object({
    value: z.enum(energyLabels).nullable(),
    updatedAt: z.string(),
    source: z.literal("用户设置"),
  }),
  preferences: z.string(),
  theme: z.enum(["light", "dark", "system"]),
});
export type State = z.infer<typeof stateSchema>;
export const commandSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("saveTask"),
    task: taskSchema,
  }),
  z.object({ type: z.literal("deleteTask"), id: z.string() }),
  z.object({
    type: z.literal(["stopRecurrence", "resumeRecurrence"]),
    taskId: z.string(),
  }),
  z.object({
    type: z.literal("setTaskDone"),
    taskId: z.string(),
    done: z.boolean(),
  }),
  z.object({
    type: z.literal("schedule"),
    taskId: z.string(),
    date: z.string(),
    scope: z.string().trim().min(1),
  }),
  z.object({
    type: z.literal(["scheduleToday", "scheduleDueToday"]),
    taskId: z.string(),
    date: recurrenceDate,
  }),
  z.object({
    type: z.literal("unschedule"),
    taskId: z.string(),
    date: z.string(),
  }),
  z.object({
    type: z.literal("setOccurrenceDone"),
    taskId: z.string(),
    date: recurrenceDate,
    done: z.boolean(),
  }),
  z.object({
    type: z.literal("skipOccurrence"),
    taskId: z.string(),
    date: recurrenceDate,
  }),
  z.object({
    type: z.literal("restoreOccurrence"),
    taskId: z.string(),
    date: recurrenceDate,
  }),
  z.object({
    type: z.literal("move"),
    taskId: z.string(),
    date: z.string(),
    targetTaskId: z.string(),
  }),
  z.object({
    type: z.literal("moveTodayGroups"),
    date: recurrenceDate,
    taskIds: z.array(z.string()).nonempty(),
    targetTaskIds: z.array(z.string()).nonempty(),
  }),
  z.object({ type: z.literal("proposal"), proposal: proposalSchema }),
  z.object({
    type: z.literal("respondToCard"),
    proposalId: z.string(),
    cardId: z.string(),
    accept: z.boolean(),
  }),
  z.object({
    type: z.literal("resolve"),
    proposalId: z.string(),
    cardIds: z.array(z.string()).min(1),
    accept: z.boolean(),
  }),
  z.object({
    type: z.literal("energy"),
    value: z.enum(energyLabels).nullable(),
  }),
  z.object({
    type: z.literal("settings"),
    preferences: z.string(),
    theme: z.enum(["light", "dark", "system"]),
  }),
  z.object({
    type: z.literal("message"),
    message: stateSchema.shape.messages.element,
  }),
  z.object({
    type: z.literal("reply"),
    message: stateSchema.shape.messages.element,
    proposal: proposalSchema.nullable(),
  }),
  z.object({
    type: z.literal("draft"),
    sessionId: z.string(),
    text: z.string(),
  }),
  z.object({ type: z.literal("session"), id: z.string() }),
  z.object({ type: z.literal("deleteSession"), id: z.string() }),
]);
export type Command = z.infer<typeof commandSchema>;
export function localDate(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
export function newTask(parentId: string | null = null): Task {
  return {
    id: crypto.randomUUID(),
    version: 0,
    title: "",
    description: "",
    startDate: "",
    expectedDate: "",
    status: "todo",
    importance: null,
    parentId,
    updatedAt: new Date().toISOString(),
  };
}
export function newSession(
  id: string = crypto.randomUUID(),
): State["sessions"][number] {
  return {
    id,
    title: "新的对话",
    draft: "",
    createdAt: new Date().toISOString(),
  };
}
export function emptyState(): State {
  const session = newSession();
  return {
    revision: 0,
    tasks: [],
    arrangements: [],
    repeatSchedules: [],
    repeatCompletions: [],
    skippedOccurrences: [],
    proposals: [],
    sessions: [session],
    activeSessionId: session.id,
    messages: [],
    energy: { value: null, updatedAt: "", source: "用户设置" },
    preferences: "",
    theme: "system",
  };
}
