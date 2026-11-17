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
export const taskSchema = z.object({
  id: z.string(),
  version: z.number().int(),
  title: z.string().trim().min(1).max(200),
  goal: z.string(),
  deadline: z.string(),
  plannedDate: z.string(),
  expectedDate: z.string(),
  importance: z.enum(["待定", "高", "中", "低"]),
  status: z.enum(["todo", "doing", "waiting", "done", "abandoned"]),
  parentId: z.string().nullable(),
  dependencies: z.array(z.string()),
  background: z.string(),
  backgroundKind: z.enum(["用户事实", "暂估", "推测"]),
  backgroundSource: z.string().optional(),
  progress: z.string(),
  obstacle: z.string(),
  nextStep: z.string(),
  updatedAt: z.string(),
});
export type Task = z.infer<typeof taskSchema>;
// Agent 只允许修改这些业务字段，ID、版本和更新时间由应用维护。
export const taskPatchSchema = taskSchema
  .omit({
    id: true,
    version: true,
    updatedAt: true,
    backgroundSource: true,
  })
  .partial();
// 会话工作记忆由模型整理。待创建内容仍留在会话里，用户接受后才成为真实任务。
export const agentMemorySchema = z.object({
  summary: z.string().max(6000),
  taskDraft: z
    .object({
      title: z.string().trim().min(1).max(200),
      patch: taskPatchSchema,
    })
    .nullable(),
});
export const arrangementSchema = z.object({
  taskId: z.string(),
  date: z.string(),
  scope: z.string().trim().min(1),
  done: z.boolean(),
});
export type Arrangement = z.infer<typeof arrangementSchema>;
const changeSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  taskVersion: z.number(),
  label: z.string(),
  reason: z.string(),
  type: z.enum(["schedule", "split", "update", "unschedule", "stage"]),
  date: z.string(),
  scope: z.string(),
  children: z.array(
    z.object({ title: z.string().min(1), goal: z.string().min(1) }),
  ),
  status: z.enum(["pending", "accepted", "rejected"]),
  patch: taskPatchSchema.optional(),
  fromDate: z.string().optional(),
  fromTaskId: z.string().optional(),
  fromTaskVersion: z.number().int().optional(),
  done: z.boolean().optional(),
});
export type Change = z.infer<typeof changeSchema>;
export const proposalSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  createdAt: z.string(),
  changes: z
    .array(changeSchema)
    .refine(
      (changes) =>
        new Set(changes.map((change) => change.id)).size === changes.length,
      { message: "方案变更 ID 必须唯一。" },
    ),
});
export type Proposal = z.infer<typeof proposalSchema>;
export const stateSchema = z.object({
  revision: z.number().int(),
  tasks: z.array(taskSchema),
  arrangements: z.array(arrangementSchema),
  proposals: z.array(proposalSchema),
  sessions: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      draft: z.string(),
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
  z.object({
    type: z.literal("saveTask"),
    task: taskSchema,
    arrangement: z
      .object({ date: z.string(), scope: z.string().trim().min(1) })
      .optional(),
  }),
  z.object({ type: z.literal("deleteTask"), id: z.string() }),
  z.object({
    type: z.literal("schedule"),
    taskId: z.string(),
    date: z.string(),
    scope: z.string().trim().min(1),
  }),
  z.object({
    type: z.literal("unschedule"),
    taskId: z.string(),
    date: z.string(),
  }),
  z.object({
    type: z.literal("stage"),
    taskId: z.string(),
    date: z.string(),
    done: z.boolean(),
  }),
  z.object({
    type: z.literal("move"),
    taskId: z.string(),
    date: z.string(),
    direction: z.enum(["up", "down"]),
  }),
  z.object({ type: z.literal("proposal"), proposal: proposalSchema }),
  z.object({
    type: z.literal("resolve"),
    proposalId: z.string(),
    ids: z.array(z.string()),
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
    goal: "",
    deadline: "",
    plannedDate: "",
    expectedDate: "",
    importance: "待定",
    status: "todo",
    parentId,
    dependencies: [],
    background: "",
    backgroundKind: "用户事实",
    progress: "",
    obstacle: "",
    nextStep: "",
    updatedAt: new Date().toISOString(),
  };
}
export function emptyState(): State {
  const id = crypto.randomUUID();
  return {
    revision: 0,
    tasks: [],
    arrangements: [],
    proposals: [],
    sessions: [{ id, title: "新的对话", draft: "" }],
    activeSessionId: id,
    messages: [],
    energy: { value: null, updatedAt: "", source: "用户设置" },
    preferences: "",
    theme: "system",
  };
}
