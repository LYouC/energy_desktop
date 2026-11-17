// 手动串行验证 S01，需要本地配置并会调用模型服务。
// node --import tsx tests/agent-journey.live.ts
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { generateAgentTurn } from "../electron/agent/runtime";
import { applyAgentTurn, type AgentTurn } from "../shared/agent";
import { applyCommand } from "../shared/operations";
import {
  emptyState,
  localDate,
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
let state = emptyState();
let parentId = "";
let originalExpectedDate = "";
const rounds: unknown[] = [];

function save() {
  const output = {
    model: connection.model,
    createdAt: new Date().toISOString(),
    localDate: localDate(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    scope: "S01连续七轮，序列化重读后同日继续，未模拟跨日或桌面重启",
    rounds,
    finalState: state,
  };
  // 结果只含虚构任务及模型回复，再按实际凭据值做最终脱敏。
  writeFileSync(
    "test-results/agent-journey.json",
    JSON.stringify(output, null, 2).split(connection.apiKey).join("[redacted]"),
  );
}
async function run(
  name: string,
  user: string,
  check: (before: State, next: State, turn: AgentTurn) => void,
) {
  const before = structuredClone(state);
  const sessionId = state.activeSessionId;
  state = applyCommand(state, {
    type: "message",
    message: {
      id: crypto.randomUUID(),
      sessionId,
      role: "user",
      text: user,
      createdAt: new Date().toISOString(),
    },
  });
  let observed: unknown = { user };
  try {
    const { turn, trace } = await generateAgentTurn({
      state,
      sessionId,
      focusedId: parentId || null,
      userText: user,
      connection,
      signal: AbortSignal.timeout(120000),
      emit: () => {},
    });
    state = applyAgentTurn(state, sessionId, user, turn);
    observed = { user, turn, trace };
    check(before, state, turn);
    rounds.push({ name, passed: true, ...(observed as object) });
    console.log(`${name} PASS (${trace.steps} steps)`);
    save();
    return true;
  } catch (error) {
    rounds.push({
      name,
      passed: false,
      ...(observed as object),
      error: error instanceof Error ? error.message : "执行失败",
      validationErrors: (error as { validationErrors?: string[] })
        .validationErrors,
    });
    console.log(`${name} FAIL`);
    process.exitCode = 1;
    save();
    return false;
  }
}

await run(
  "S01-1 模糊想法先澄清",
  "我想把报告往前推一点，但不知道从哪开始。",
  (_before, next, turn) => {
    assert.equal(next.tasks.length, 0);
    assert.equal(next.arrangements.length, 0);
    assert.equal(turn.actions.length, 0);
    assert.match(turn.text, /什么|哪|吗|？|\?/);
  },
);
await run(
  "S01-2 记录任务与待接受方案",
  "是给组内讨论的项目复盘，周五下午交。材料有了，还没提纲。今天只有一小时。帮我记下来，给个拆分建议，再建议今天做什么。",
  (_before, next) => {
    const parents = next.tasks.filter((t) => t.parentId === null);
    assert.equal(parents.length, 1);
    parentId = parents[0].id;
    originalExpectedDate = parents[0].expectedDate;
    assert.match(parents[0].description, /复盘/);
    assert.match(parents[0].description, /周五|星期五|2026-\d{2}-\d{2}/);
    assert.equal(next.tasks.length, 1, "建议尚未接受，不能提前建立子任务");
    assert.equal(next.arrangements.length, 0, "建议尚未接受，不能提前安排");
    assert(
      next.proposals.some((p) =>
        p.changes.some((c) => c.type === "split" && c.status === "pending"),
      ),
    );
    assert(
      next.proposals.some((p) =>
        p.changes.some((c) => c.type === "schedule" && c.status === "pending"),
      ),
    );
  },
);
if (parentId) {
  await run(
    "S01-3 接受拆分并只安排提纲",
    "就按你这份拆分建子任务；今天只安排整理提纲，其他步骤先不安排。",
    (_before, next) => {
      assert(next.tasks.some((t) => t.parentId === parentId));
      // 原建议若正好匹配用户要求，可以被接受。是否超出范围依据实际内容评审。
      const today = next.arrangements.filter((a) => a.date === localDate());
      assert.equal(today.length, 1);
      const task = next.tasks.find((t) => t.id === today[0].taskId)!;
      assert(task.id === parentId || task.parentId === parentId);
      assert.match(today[0].scope + task.title, /提纲|大纲/);
    },
  );
  await run(
    "S01-4 卡住时帮助启动",
    "打开材料还是不知道怎么组织，我已经在这儿看了二十分钟。",
    (before, next, turn) => {
      assert.deepEqual(
        next.arrangements,
        before.arrangements,
        "求助没有授权修改安排",
      );
      assert.equal(next.tasks.length, before.tasks.length);
      assert.notEqual(
        next.tasks.find((t) => t.id === parentId)?.status,
        "done",
      );
      assert(turn.text.length > 30, "应给出可讨论的具体入口");
    },
  );
  await run(
    "S01-5 明确缩小今日范围",
    "这个可以。我先列三个讨论问题，今天的范围就改成这个。",
    (_before, next) => {
      const today = next.arrangements.filter((a) => a.date === localDate());
      assert.equal(today.length, 1);
      assert.match(today[0].scope, /三个|3个|3 个/);
      assert.match(today[0].scope, /问题/);
      const parent = next.tasks.find((t) => t.id === parentId)!;
      assert.match(parent.description, /复盘/);
      assert.match(parent.description, /周五|星期五|2026-\d{2}-\d{2}/);
      assert.equal(parent.expectedDate, originalExpectedDate);
      assert.notEqual(parent.status, "done");
    },
  );
  await run(
    "S01-6 记录停点及阶段完成",
    "三个问题列出来了，今天先到这里，完整提纲还没做。记一下停点，下次继续。",
    (before, next) => {
      assert.notEqual(
        next.tasks.find((t) => t.id === parentId)?.status,
        "done",
      );
      const previousToday = before.arrangements.filter(
        (a) => a.date === localDate(),
      );
      assert.equal(
        previousToday.length,
        1,
        "阶段结束应关联唯一已接受的今日范围",
      );
      assert.match(
        previousToday[0].scope,
        /三个|3个|3 个/,
        "前轮应已将今日范围改为三个问题",
      );
      assert(
        next.arrangements.some((a) => a.date === localDate() && a.done),
        "本轮三个问题阶段应标记完成",
      );
      const recorded = next.tasks.map((t) => t.description).join(" ");
      assert.match(recorded, /问题/);
      assert.match(recorded, /提纲/);
    },
  );
  state = stateSchema.parse(JSON.parse(JSON.stringify(state)));
  await run(
    "S01-7 序列化重读后继续",
    "继续刚才的报告。",
    (before, next, turn) => {
      assert.equal(next.tasks.length, before.tasks.length);
      assert.notEqual(
        next.tasks.find((t) => t.id === parentId)?.status,
        "done",
      );
      assert.match(turn.text, /问题|提纲/);
      assert.deepEqual(
        next.arrangements,
        before.arrangements,
        "继续交流不应自动修改已接受安排",
      );
    },
  );
}
save();
