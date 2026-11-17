// 手动串行执行语义行为场景，内部读取本地配置并产生模型调用费用。
// node --import tsx tests/agent-behavior.live.ts
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { generateAgentTurn, type TurnTrace } from "../electron/agent/runtime";
import { applyAgentTurn, type AgentTurn } from "../shared/agent";
import { applyCommand } from "../shared/operations";
import {
  emptyState,
  localDate,
  newTask,
  stateSchema,
  type State,
} from "../shared/model";

process.loadEnvFile(".env.agent.local");
const connection = {
  apiKey: process.env.XIXU_API_KEY || "",
  baseURL: process.env.XIXU_BASE_URL || "",
  model: process.env.XIXU_MODEL || "",
};
assert(
  connection.apiKey && connection.baseURL && connection.model,
  "缺少本地模型配置",
);
mkdirSync("test-results", { recursive: true });
const results: unknown[] = [];
const filters = (process.env.XIXU_BEHAVIOR_FILTER || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
function save() {
  const report = {
    createdAt: new Date().toISOString(),
    model: connection.model,
    localDate: localDate(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    filters,
    reviewInstruction:
      "programChecks仅判断状态与动作结果。请独立审阅完整上下文、回复、动作和工具轨迹，判断语义理解、确认对象、事实来源与帮助质量。未审阅语义项保留pending。",
    results,
  };
  writeFileSync(
    "test-results/agent-behavior.json",
    JSON.stringify(report, null, 2).split(connection.apiKey).join("[redacted]"),
  );
}
function message(state: State, role: "user" | "assistant", text: string) {
  return applyCommand(state, {
    type: "message",
    message: {
      id: crypto.randomUUID(),
      sessionId: state.activeSessionId,
      role,
      text,
      createdAt: new Date().toISOString(),
    },
  });
}
async function run(
  name: string,
  initial: State,
  user: string,
  reviewCriteria: string[],
  check: (
    before: State,
    next: State,
    turn: AgentTurn,
    trace: TurnTrace,
  ) => void,
) {
  if (filters.length && !filters.some((filter) => name.includes(filter)))
    return initial;
  let next = initial;
  let observation: object = { user, initialState: initial };
  try {
    const state = message(initial, "user", user);
    const { turn, trace } = await generateAgentTurn({
      state,
      sessionId: state.activeSessionId,
      focusedId: null,
      userText: user,
      connection,
      signal: AbortSignal.timeout(120000),
      emit: () => {},
    });
    next = applyAgentTurn(state, state.activeSessionId, user, turn);
    observation = { ...observation, turn, trace, finalState: next };
    check(initial, next, turn, trace);
    results.push({
      name,
      programChecks: "passed",
      semanticReview: "pending",
      reviewCriteria,
      ...observation,
    });
    console.log(`${name} PASS`);
  } catch (error) {
    results.push({
      name,
      programChecks: "failed",
      semanticReview: "pending",
      reviewCriteria,
      ...observation,
      error: error instanceof Error ? error.message : "执行失败",
      validationErrors: (error as { validationErrors?: string[] })
        .validationErrors,
    });
    console.log(`${name} FAIL`);
    process.exitCode = 1;
  }
  save();
  return next;
}

await run(
  "B01 纯讨论",
  emptyState(),
  "我最近总觉得每天安排得很满，可能只是没想清楚优先级。先陪我分析一下，不用替我记任务。",
  [
    "理解用户在讨论安排过满的处境，给出有依据的分析或关键追问。",
    "把试探想法与正式任务区分，回复与实际动作一致。",
  ],
  (before, next) => {
    assert.deepEqual(next.tasks, before.tasks);
    assert.deepEqual(next.arrangements, before.arrangements);
  },
);

await run(
  "B02 明确否定创建",
  emptyState(),
  "之前想学摄影，但我已经决定这阵子不启动。别把学习摄影建成任务，也不用安排今天，先聊聊我为什么总想开新坑。",
  [
    "理解明确否定，围绕用户提出的讨论展开。",
    "不把摄影学习或分析开新坑创建为任务。",
  ],
  (_before, next) => {
    assert.equal(next.tasks.length, 0);
    assert.equal(next.arrangements.length, 0);
  },
);

await run(
  "B03 明确记录并自主整理标题",
  emptyState(),
  "帮我把这件事放进任务里：把上季度几个项目的报销票据找齐，整理成财务可以核对的一包材料。名字你帮我概括一下，先不安排日期。",
  [
    "从长句提炼可理解的任务标题，保留票据收集和财务核对的实际目标。",
    "按语义理解记录请求，标题不需要照抄整句。",
  ],
  (_before, next) => {
    assert.equal(next.tasks.length, 1);
    assert(next.tasks[0].title.length < 100);
    assert(next.tasks[0].description.length > 0);
    assert.equal(next.arrangements.length, 0);
  },
);

let drafted = await run(
  "B04a 草拟任务等待确认",
  emptyState(),
  "我准备把过去几个月散落的会议笔记整理到一起，方便以后查决定和待办。你先帮我草拟成一件任务，暂时先别建立，等我点头。",
  [
    "整理任务标题和目标供用户确认，保存可用于下一轮的草拟上下文。",
    "草拟期间工作区任务数量保持为零。",
  ],
  (_before, next, turn) => {
    assert.equal(next.tasks.length, 0);
    const draft = next.sessions[0].agentMemory?.taskDraft;
    // 可见草稿随消息持久化即可承接，memory由模型按需要使用。
    // 回复是否完整展示标题和目标交由独立语义评审核对。
    if (draft)
      assert(turn.text.includes(draft.title), "待确认的草拟标题需要向用户展示");
    assert.equal(next.messages.at(-1)?.role, "assistant");
    assert.equal(next.messages.at(-1)?.text, turn.text);
    assert(turn.text.trim().length > 0);
  },
);
drafted = stateSchema.parse(JSON.parse(JSON.stringify(drafted)));
await run(
  "B04b 短答确认跨序列化草稿",
  drafted,
  "好，就建这个。",
  [
    "结合本会话草稿理解短答指向，建立用户已确认的会议笔记整理任务。",
    "已使用记忆草稿时创建后清除taskDraft，任务目标包含此前用户表达的用途。",
  ],
  (before, next) => {
    assert.equal(next.tasks.length, 1);
    const draft = before.sessions[0].agentMemory?.taskDraft;
    if (draft) assert.equal(next.tasks[0].title, draft.title);
    if (draft) assert.equal(next.sessions[0].agentMemory?.taskDraft, null);
    assert(next.tasks[0].description.trim().length > 0);
    assert(
      before.messages.some(
        (message) =>
          message.role === "assistant" && message.text.trim().length > 0,
      ),
    );
    assert.equal(next.arrangements.length, 0);
  },
);

let ambiguous = emptyState();
for (const title of ["英语面试练习", "项目报告"]) {
  ambiguous = applyCommand(ambiguous, {
    type: "saveTask",
    task: { ...newTask(), title },
    arrangement: { date: localDate(), scope: "推进一小段" },
  });
}
ambiguous = message(
  ambiguous,
  "assistant",
  "今天有英语面试练习和项目报告两项安排，你想先讨论哪项？",
);
await run(
  "B05 两个对象的含糊指代",
  ambiguous,
  "那个挪到明天吧。",
  ["识别两项都可能被指代，询问具体对象。", "保持现有安排，直到对象明确。"],
  (before, next) => {
    assert.deepEqual(next.tasks, before.tasks);
    assert.deepEqual(next.arrangements, before.arrangements);
  },
);

let corrected = emptyState();
corrected = applyCommand(corrected, {
  type: "saveTask",
  task: {
    ...newTask(),
    title: "客户方案演示",
    description: "准备方案演示，硬截止为2026-12-04，面向内部同事",
  },
});
await run(
  "B06 纠正已有任务",
  corrected,
  "客户方案演示的截止改为2026-12-03，受众是客户，不是内部同事。更新这项就好。",
  [
    "关联已有任务，修正截止与受众，不重复创建。",
    "后续理解采用新事实，旧受众只能作为被纠正的历史。",
  ],
  (before, next) => {
    assert.equal(next.tasks.length, 1);
    assert.equal(next.tasks[0].id, before.tasks[0].id);
    assert.match(next.tasks[0].description, /2026-12-03/);
    assert.match(next.tasks[0].description, /客户/);
    assert(!next.tasks[0].description.includes("2026-12-04"));
    assert.equal(next.arrangements.length, 0);
  },
);

let history = emptyState();
history = applyCommand(history, {
  type: "saveTask",
  task: {
    ...newTask(),
    title: "团队周会总结",
    description: "形成团队周会总结",
  },
});
history = message(
  history,
  "user",
  "这份周会总结发给跨部门新人。固定格式是“背景、影响、下一步”，不要使用没有解释的缩写。这个要求先留在聊天里，不必改任务。",
);
history = message(history, "assistant", "了解，这条写作要求先保留在交流中。");
for (let i = 1; i <= 8; i++) {
  history = message(
    history,
    "user",
    `补充第${i}次交流：目前没有新增进展，先继续讨论整理过程。`,
  );
  history = message(history, "assistant", "可以，等你提供新的具体信息再继续。");
}
await run(
  "B07 长会话读取早期约束",
  history,
  "继续团队周会总结。最早说过受众和固定格式，你先查一下早期对话，告诉我应该按什么要求整理，先不要修改任务。",
  [
    "调用readConversation取回近期上下文之外的最初用户要求。",
    "准确承接受众、固定格式和缩写约束，依据工具结果回答。",
    "工具轨迹应能证明历史读取，不将评审者可见的完整fixture视为模型已知。",
  ],
  (before, next, _turn, trace) => {
    assert(
      trace.tools?.includes("readConversation"),
      "需要实际调用历史读取工具",
    );
    assert.deepEqual(next.tasks, before.tasks);
    assert.deepEqual(next.arrangements, before.arrangements);
  },
);

let accepted = emptyState();
accepted = applyCommand(accepted, {
  type: "saveTask",
  task: { ...newTask(), title: "英语", description: "面试练习" },
});
accepted = applyAgentTurn(
  accepted,
  accepted.activeSessionId,
  "今天怎么安排英语",
  {
    text: "建议今天先练习自我介绍十分钟，等你确认再安排。",
    actions: [
      {
        type: "schedule",
        taskId: accepted.tasks[0].id,
        date: localDate(),
        scope: "练习自我介绍十分钟",
        quote: "今天怎么安排英语",
        mode: "proposal",
      },
    ],
  },
);
await run(
  "B08 自然确认接受已展示安排",
  accepted,
  "按你的建议来吧。",
  [
    "理解本会话唯一明确日程建议，接受对应的真实变更ID。",
    "执行一次并反馈生效范围。",
  ],
  (_before, next) => {
    assert.equal(next.arrangements.length, 1);
    assert.equal(next.arrangements[0].scope, "练习自我介绍十分钟");
    assert.equal(next.proposals[0].changes[0].status, "accepted");
  },
);
save();
