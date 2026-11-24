// 手动串行执行语义行为场景，内部读取本地配置并产生模型调用费用。
// node --import tsx tests/agent-behavior.live.ts
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { generateAgentTurn, type TurnTrace } from "../src/agent/runtime";
import { capacitySchema } from "../src/agent/capacity";
import { applyAgentTurn, type AgentTurn } from "../src/agent/turn";
import { applyCommand } from "../src/domain/operations";
import {
  emptyState,
  localDate,
  newTask,
  stateSchema,
  type State,
} from "../src/domain/model";

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
  suggestOnly = false,
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
      suggestOnly,
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
    "理解本会话唯一明确日程建议，接受对应的真实调整卡 ID。",
    "执行一次并反馈生效范围。",
  ],
  (_before, next) => {
    assert.equal(next.arrangements.length, 1);
    assert.equal(next.arrangements[0].scope, "练习自我介绍十分钟");
    assert.equal(next.proposals[0].cards[0].status, "accepted");
  },
);
const today = localDate();
const rangeEnd = new Date(`${today}T12:00:00`);
rangeEnd.setDate(rangeEnd.getDate() + 2);
const end = localDate(rangeEnd);
await run(
  "B09a 创建三种重复规则并设置今天范围",
  emptyState(),
  `帮我设置三个重复任务：每天拉伸，今天做五分钟；每周一、三、五慢跑；从今天到 ${end} 每天复习。`,
  ["按明确授权直接设置规则，区分模板和本次范围，回复说明已保存的频率。"],
  (_before, next) => {
    assert.equal(next.tasks.length, 3);
    const daily = next.tasks.find((task) => task.title.includes("拉伸"));
    const weekly = next.tasks.find((task) => task.title.includes("慢跑"));
    const range = next.tasks.find((task) => task.title.includes("复习"));
    assert.deepEqual(daily?.recurrence, { type: "daily" });
    assert.deepEqual(weekly?.recurrence, {
      type: "weekly",
      weekdays: [1, 3, 5],
    });
    assert.deepEqual(range?.recurrence, {
      type: "range",
      start: today,
      end,
    });
    const occurrence = next.arrangements.find(
      (item) => item.taskId === daily?.id,
    );
    assert.equal(occurrence?.date, today);
    assert.match(occurrence?.scope ?? "", /[五5]\s*分钟/);
    assert.equal(occurrence?.done, false);
  },
);

const stretch = {
  ...newTask(),
  title: "拉伸",
  recurrence: { type: "daily" as const },
};
const repeating = applyCommand(
  emptyState(),
  { type: "saveTask", task: stretch },
  today,
);
await run(
  "B09b 跳过今天并调整后续规律",
  repeating,
  "今天的拉伸跳过，以后改成每周一、三、五。",
  ["按明确授权移出今天并更新模板，说明新规则从次日生效。"],
  (_before, next) => {
    assert.deepEqual(next.tasks[0].recurrence, {
      type: "weekly",
      weekdays: [1, 3, 5],
    });
    assert.deepEqual(next.arrangements, []);
    assert.equal(next.skippedOccurrences?.[0].arrangement.date, today);
  },
);
await run(
  "B09c 只提重复变更建议",
  repeating,
  "帮我把拉伸改为每周一、三、五的想法列成待接受方案，先别应用，今天照旧。",
  ["提供可接受的规则变更，说明今日不变和待接受状态。"],
  (before, next) => {
    assert.deepEqual(next.tasks, before.tasks);
    assert.deepEqual(next.arrangements, before.arrangements);
    const card = next.proposals.at(-1)?.cards[0];
    const change = card?.changes[0];
    assert.equal(change?.type, "updateRecurrence");
    assert.equal(card?.status, "pending");
    assert.deepEqual(change?.recurrence, {
      type: "weekly",
      weekdays: [1, 3, 5],
    });
  },
);
const recurringProposal = applyAgentTurn(
  repeating,
  repeating.activeSessionId,
  "先给我一个减轻重复负担的方案。",
  {
    text: "建议以后每周一、三、五拉伸，今天这次保留。",
    actions: [
      {
        type: "updateRecurrence",
        mode: "proposal",
        taskId: stretch.id,
        recurrence: { type: "weekly", weekdays: [1, 3, 5] },
      },
    ],
  },
  undefined,
  today,
);
await run(
  "B09d 接受已展示的重复规则",
  recurringProposal,
  "可以，就按这条新规则执行。",
  ["通过原方案生效，只接受明确同意的规则。"],
  (before, next) => {
    assert.deepEqual(next.tasks[0].recurrence, {
      type: "weekly",
      weekdays: [1, 3, 5],
    });
    assert.deepEqual(next.arrangements, before.arrangements);
    assert.equal(next.proposals.at(-1)?.cards[0].status, "accepted");
  },
);
const deleted = applyCommand(
  repeating,
  { type: "deleteTask", id: stretch.id },
  today,
);
await run(
  "B09e 已删除模板不作为当前计划",
  deleted,
  "今天那次拉伸我已经做完了，帮我标记一下。",
  ["说明当前计划没有该任务，可以从工作台查看或处理已保留的执行记录。"],
  (_before, next) => {
    assert.deepEqual(next.tasks, []);
    assert.equal(next.arrangements.length, 1);
    assert.equal(next.arrangements[0].done, false);
  },
);
const clockCheckStarted = Date.now();
await run(
  "B10 以系统本地时钟回答当前时间",
  emptyState(),
  "每天晚上 11:30 睡，早上 7:30 起。只告诉我现在的系统本地时间，用 YYYY-MM-DD HH:mm 格式，不用记录或安排。",
  ["准确复述系统本地日期和时分，区分当前时间与作息钟点。"],
  (_before, _next, turn) => {
    const reported = turn.text.trim();
    const formatter = new Intl.DateTimeFormat("sv-SE", {
      dateStyle: "short",
      timeStyle: "short",
    });
    const firstMinute = Math.floor(clockCheckStarted / 60_000);
    const lastMinute = Math.floor(Date.now() / 60_000);
    const expected = [];
    for (let minute = firstMinute; minute <= lastMinute; minute++) {
      expected.push(formatter.format(minute * 60_000));
    }
    assert(
      expected.includes(reported),
      `系统本地时间应为 ${expected.join(" 或 ")}`,
    );
    assert.deepEqual(turn.actions, []);
  },
);
const nextDay = new Date(`${today}T12:00:00`);
nextDay.setDate(nextDay.getDate() + 1);
const tomorrow = localDate(nextDay);
const invoice = { ...newTask(), title: "整理发票", expectedDate: today };
const invoiceState = applyCommand(emptyState(), {
  type: "saveTask",
  task: invoice,
  arrangement: { date: today, scope: "核对发票" },
});
const invoiceProposal = await run(
  "B11a 改期和预计完成日期组成一张调整卡",
  invoiceState,
  "今天要先交报告。请给我一个调整建议，把整理发票从今天推到明天，预计完成日期也推到明天，先别应用。",
  ["说明改期理由，保留原安排的推进范围，清楚表达建议未生效。"],
  (before, next, turn) => {
    assert.deepEqual(next.tasks, before.tasks);
    assert.deepEqual(next.arrangements, before.arrangements);
    const cards = next.proposals.at(-1)?.cards ?? [];
    assert.equal(cards.length, 1);
    assert.equal(cards[0].taskId, invoice.id);
    assert.equal(cards[0].status, "pending");
    assert(turn.actions.some((action) => "reason" in action && action.reason));
    assert(
      cards[0].changes.some(
        (change) => change.type === "schedule" && change.date === tomorrow,
      ),
    );
    assert(
      cards[0].changes.some(
        (change) => change.patch?.expectedDate === tomorrow,
      ),
    );
  },
);
await run(
  "B11b 自然确认后整卡生效",
  invoiceProposal,
  "好，就按这张调整卡来。",
  ["确认范围覆盖原建议的安排和预计完成日期，回复以实际回执为准。"],
  (before, next, turn) => {
    const originalCard = before.proposals.at(-1)?.cards[0];
    assert(
      turn.actions.some(
        (action) =>
          action.type === "resolve" &&
          action.cardIds.includes(originalCard?.id ?? "") &&
          action.accept,
      ),
    );
    assert.equal(next.proposals.at(-1)?.cards[0].status, "accepted");
    assert.equal(next.tasks[0].expectedDate, tomorrow);
    assert.deepEqual(
      next.arrangements.map(({ date, scope }) => [date, scope]),
      [[tomorrow, "核对发票"]],
    );
  },
);
function daysFromToday(days: number) {
  const date = new Date(`${today}T12:00:00`);
  date.setDate(date.getDate() + days);
  return localDate(date);
}

const reviewList = {
  ...newTask(),
  title: "核对评审清单",
  importance: "high" as const,
  description: "清单已齐，核对所有条目约 15 分钟，可以提前做完。",
  expectedDate: tomorrow,
};
const pendingMaterials = {
  ...newTask(),
  title: "整理供应商回执",
  description: "回执明天签发，今天拿不到。收到后约 10 分钟能整理完。",
  expectedDate: tomorrow,
};
const distantTask = {
  ...newTask(),
  title: "汇总远期记录",
  expectedDate: daysFromToday(8),
  description: "约 5 分钟。",
};
const todayTask = { ...newTask(), title: "提交费用报表", expectedDate: today };
let upcomingState = applyCommand(emptyState(), {
  type: "saveTask",
  task: reviewList,
  arrangement: { date: tomorrow, scope: "核对清单所有条目" },
});
for (const task of [pendingMaterials, distantTask])
  upcomingState = applyCommand(upcomingState, { type: "saveTask", task });
const withTodayTask = applyCommand(upcomingState, {
  type: "saveTask",
  task: todayTask,
  arrangement: { date: today, scope: "核对金额并提交报表" },
});

function checkEarlierProposal(
  before: State,
  next: State,
  turn: AgentTurn,
  trace: TurnTrace,
) {
  assert(trace.tools?.includes("readUpcomingTasks"));
  assert.deepEqual(next.tasks, before.tasks);
  assert.deepEqual(next.arrangements, before.arrangements);
  assert.equal(turn.actions.length, 1);
  const [action] = turn.actions;
  assert(action.type === "advanceTask" && action.mode === "proposal");
  assert.equal(action.taskId, reviewList.id);
  const cards = next.proposals.at(-1)?.cards;
  assert.equal(cards?.length, 1);
  assert.equal(cards?.[0].status, "pending");
  assert.equal(cards?.[0].changes[0].date, today);
  assert.equal(cards?.[0].changes[0].fromDate, undefined);
}

const earlier = await run(
  "B12a 明确请求提前推进",
  upcomingState,
  "今天没有其他安排，精力还够，留完休息和缓冲之后还有 25 分钟。未来一周有没有一件可以提前做完？给我一个待接受方案，原安排先保留。",
  ["查询近期候选，跳过依赖未满足的回执；说明今日范围、理由和原安排保留。"],
  checkEarlierProposal,
);
await run(
  "B12b 接受提前推进卡",
  earlier,
  "好，接受这张提前推进的调整卡。",
  ["确认的是对应调整卡，回执准确说明今天的新增安排和保留的原计划。"],
  (before, next, turn) => {
    const proposal = before.proposals.at(-1);
    assert(proposal);
    assert(
      turn.actions.some(
        (action) =>
          action.type === "resolve" &&
          action.accept &&
          action.cardIds.includes(proposal.cards[0].id),
      ),
    );
    assert.equal(next.proposals.at(-1)?.cards[0].status, "accepted");
    assert.deepEqual(next.arrangements.slice(0, -1), before.arrangements);
    assert.equal(next.arrangements.at(-1)?.taskId, reviewList.id);
    assert.equal(next.arrangements.at(-1)?.date, today);
    assert.equal(
      next.tasks.find((task) => task.id === reviewList.id)?.expectedDate,
      tomorrow,
    );
  },
);
await run(
  "B12c 今日优化有余量",
  withTodayTask,
  "今天总共还有一小时，精力也足够。今天必须先交费用报表，约 20 分钟。帮我优化今天的安排，有合适的调整请给我待接受方案。",
  [
    "先保住报表并考虑缓冲，确认有余量后按需查询。给出的提前范围能在余量内完成。",
  ],
  (before, next, turn, trace) => {
    checkEarlierProposal(before, next, turn, trace);
    const capacity = trace.tools?.indexOf("calculateCapacity") ?? -1;
    const query = trace.tools?.indexOf("readUpcomingTasks") ?? -1;
    assert(capacity >= 0 && capacity < query);
    const input = capacitySchema.parse(trace.calls?.[capacity]?.input);
    assert.equal(input.availableMinutes, 60);
    assert.deepEqual(
      input.tasks.map(({ estimatedMinutes }) => estimatedMinutes),
      [20],
    );
  },
  true,
);
await run(
  "B12d 今日容量不足",
  withTodayTask,
  "今天总共只剩 25 分钟，费用报表必须今天提交，完整做完至少要 35 分钟。帮我看看今天怎么排，先跟我商量。",
  ["指出今天至少缺 10 分钟，优先协商当前交付条件，未加未来工作。"],
  (before, next, turn, trace) => {
    assert(trace.tools?.includes("calculateCapacity"));
    assert(!trace.tools?.includes("readUpcomingTasks"));
    const input = capacitySchema.parse(
      trace.calls?.find(({ name }) => name === "calculateCapacity")?.input,
    );
    assert.equal(input.availableMinutes, 25);
    assert.deepEqual(
      input.tasks.map(({ estimatedMinutes }) => estimatedMinutes),
      [35],
    );
    assert(turn.actions.every((action) => action.mode === "proposal"));
    assert.deepEqual(next.tasks, before.tasks);
    assert.deepEqual(next.arrangements, before.arrangements);
    assert(
      !next.proposals
        .flatMap((proposal) => proposal.cards)
        .some(({ taskId }) => taskId !== todayTask.id),
    );
  },
  true,
);
save();
