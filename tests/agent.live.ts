// 手动执行的真实模型场景，读取本地忽略文件，仅输出脱敏后的结果。
// node --import tsx tests/agent.live.ts；会调用已配置服务并产生费用。
import { mkdirSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import { generateAgentTurn } from "../electron/agent/runtime";
import { applyAgentTurn } from "../shared/agent";
import { applyCommand } from "../shared/operations";
import { emptyState, newTask, localDate, type State } from "../shared/model";
process.loadEnvFile(".env.agent.local");
const connection = {
  apiKey: process.env.XIXU_API_KEY!,
  baseURL: process.env.XIXU_BASE_URL!,
  model: process.env.XIXU_MODEL!,
};
assert(
  connection.apiKey && connection.baseURL && connection.model,
  "请提供本地模型配置",
);
mkdirSync("test-results", { recursive: true });
const results: unknown[] = [];
async function run(
  name: string,
  state: State,
  text: string,
  check: (next: State) => void,
) {
  if (
    process.env.XIXU_LIVE_FILTER &&
    !name.includes(process.env.XIXU_LIVE_FILTER)
  )
    return state;
  let observed: unknown;
  let nextState = state;
  try {
    const sessionId = state.activeSessionId;
    state = applyCommand(state, {
      type: "message",
      message: {
        id: crypto.randomUUID(),
        sessionId,
        role: "user",
        text,
        createdAt: new Date().toISOString(),
      },
    });
    const { turn, trace } = await generateAgentTurn({
      state,
      sessionId,
      focusedId: null,
      userText: text,
      connection,
      signal: AbortSignal.timeout(120000),
      emit: () => {},
    });
    const next = applyAgentTurn(state, sessionId, text, turn);
    nextState = next;
    observed = { user: text, turn, trace };
    check(next);
    results.push({ name, passed: true, ...(observed as object) });
    writeFileSync(
      "test-results/agent-live.json",
      JSON.stringify({ model: connection.model, results }, null, 2),
    );
    console.log(name + ": PASS (" + trace.steps + " steps)");
    return next;
  } catch (error) {
    results.push({
      name,
      passed: false,
      ...(observed as object),
      error: error instanceof Error ? error.message : "error",
      validationErrors: (error as { validationErrors?: string[] })
        .validationErrors,
    });
    writeFileSync(
      "test-results/agent-live.json",
      JSON.stringify({ model: connection.model, results }, null, 2),
    );
    console.log(name + ": FAIL");
    return nextState;
  }
}
let state = await run(
  "S01 建任务与待接受拆分",
  emptyState(),
  "帮我记下一个任务，完成项目复盘报告，下周五交，材料有了还没有提纲，今天只有一小时。给我拆分建议和今天做什么的建议，先别替我应用建议。",
  (next) => {
    assert.equal(next.tasks.length, 1);
    assert.equal(next.arrangements.length, 0);
    assert(
      next.proposals.some((p) => p.changes.some((c) => c.status === "pending")),
    );
  },
);
state = await run(
  "S01 接受拆分",
  state,
  "接受刚才这份方案中的拆分，建好子任务，今天先不安排。",
  (next) => {
    assert(next.tasks.some((t) => t.parentId));
    assert.equal(next.arrangements.length, 0);
  },
);
const basic = emptyState();
const task = { ...newTask(), title: "英语", goal: "完成面试英语练习" };
let planned = applyCommand(basic, {
  type: "saveTask",
  task,
  arrangement: { date: localDate(), scope: "练习二十分钟" },
});
await run("S08 明确改期", planned, "把英语移到明天，今天不做了。", (next) => {
  assert(!next.arrangements.some((a) => a.date === localDate()));
  assert.equal(next.arrangements.length, 1);
});
await run(
  "S04 挫败不自动改期",
  planned,
  "英语好烦，成本中心这个词看不懂，先帮我理解一下。",
  (next) => {
    assert.deepEqual(next.arrangements, planned.arrangements);
    assert.equal(next.tasks[0].status, "todo");
  },
);
await run(
  "S03 容量冲突",
  emptyState(),
  "今天只剩三小时，两件任务今晚硬截止，报告我估计还要四小时，演示要两小时。帮我分析取舍，不要创建任务。",
  (next) => {
    assert.equal(next.tasks.length, 0);
    assert.equal(next.arrangements.length, 0);
  },
);
await run(
  "S06 疲惫仍挑战",
  emptyState(),
  "我有些疲惫，休息没有恢复，但刚发现代数题移项漏改符号反而有精神了。我想继续这道题，帮我想想下一步。",
  (next) => {
    assert.equal(next.tasks.length, 0);
  },
);
writeFileSync(
  "test-results/agent-live.json",
  JSON.stringify(
    { model: connection.model, createdAt: new Date().toISOString(), results },
    null,
    2,
  ),
);
if (results.some((r: any) => !r.passed)) process.exitCode = 1;
