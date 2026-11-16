import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AgentRuntime,
  planningSnapshot,
  type Connection,
  type generateAgentTurn,
} from "../electron/agent/runtime";
import { WorkspaceDatabase } from "../electron/storage";

const connection = (): Connection => ({
  baseURL: "https://example.invalid/v1",
  model: "test",
  apiKey: "test-placeholder",
});
const result = {
  turn: { text: "已理解", actions: [] },
  trace: { steps: 1, inputTokens: 1, outputTokens: 1, actions: 0 },
};
function request(text = "你好") {
  return { runId: crypto.randomUUID(), sessionId: "", text, focusedId: null };
}
function deferred() {
  let resolve!: (value: typeof result) => void;
  const promise = new Promise<typeof result>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
test("成功runId跨runtime重建仍幂等，复用ID改消息会失败", async () => {
  const db = new WorkspaceDatabase(":memory:");
  const input = { ...request(), sessionId: db.load().activeSessionId };
  let calls = 0;
  const generate: typeof generateAgentTurn = async () => {
    calls++;
    return result;
  };
  const first = new AgentRuntime(db, connection, generate);
  await first.send(input, () => {});
  const restarted = new AgentRuntime(db, connection, generate);
  await restarted.send(input, () => {});
  assert.equal(calls, 1);
  assert.equal(db.load().messages.length, 2);
  await assert.rejects(
    restarted.send({ ...input, text: "换个请求" }, () => {}),
    /标识/,
  );
  db.close();
});
test("并发被拒绝，取消后不提交业务结果且后续可继续", async () => {
  const db = new WorkspaceDatabase(":memory:");
  const input = { ...request(), sessionId: db.load().activeSessionId };
  const held = deferred();
  const runtime = new AgentRuntime(db, connection, async () => held.promise);
  const running = runtime.send(input, () => {});
  await assert.rejects(
    runtime.send({ ...input, runId: crypto.randomUUID() }, () => {}),
    /正在进行/,
  );
  runtime.cancel(input.runId);
  held.resolve(result);
  await assert.rejects(running, /取消或超时/);
  assert.equal(
    db.load().messages.filter((m) => m.role === "assistant").length,
    0,
  );
  const resumed = new AgentRuntime(db, connection, async () => result);
  await resumed.send(input, () => {});
  assert.equal(db.load().messages.filter((m) => m.role === "user").length, 1);
  assert.equal(
    db.load().messages.filter((m) => m.role === "assistant").length,
    1,
  );
  db.close();
});
test("运行期间改草稿或主题可提交，改能量阻止过期结果", async () => {
  const db = new WorkspaceDatabase(":memory:");
  const input = { ...request(), sessionId: db.load().activeSessionId };
  let held = deferred();
  const runtime = new AgentRuntime(db, connection, async () => held.promise);
  let pending = runtime.send(input, () => {});
  db.execute(db.load().revision, {
    type: "draft",
    sessionId: input.sessionId,
    text: "下一句草稿",
  });
  db.execute(db.load().revision, {
    type: "settings",
    preferences: "",
    theme: "dark",
  });
  held.resolve(result);
  await pending;
  assert.equal(db.load().theme, "dark");
  held = deferred();
  pending = runtime.send({ ...input, runId: crypto.randomUUID() }, () => {});
  db.execute(db.load().revision, { type: "energy", value: "需要恢复" });
  held.resolve(result);
  await assert.rejects(pending, /分析期间/);
  assert.equal(
    db.load().messages.filter((m) => m.role === "assistant").length,
    1,
  );
  db.close();
});
test("provider异常原文被脱敏，失败后释放并发锁", async () => {
  const db = new WorkspaceDatabase(":memory:");
  const input = { ...request(), sessionId: db.load().activeSessionId };
  let fail = true;
  const runtime = new AgentRuntime(db, connection, async () => {
    if (fail) throw new Error("Bearer private-placeholder response body");
    return result;
  });
  await assert.rejects(
    runtime.send(input, () => {}),
    (error) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message.includes("private-placeholder"), false);
      return true;
    },
  );
  fail = false;
  await runtime.send(input, () => {});
  assert.equal(db.load().messages.length, 2);
  db.close();
});
test("规划快照忽略展示状态而保留用户明确偏好", () => {
  const db = new WorkspaceDatabase(":memory:");
  const state = db.load();
  const changed = structuredClone(state);
  changed.theme = "dark";
  changed.sessions[0].draft = "草稿";
  assert.equal(planningSnapshot(state), planningSnapshot(changed));
  changed.preferences = "先做报告";
  assert.notEqual(planningSnapshot(state), planningSnapshot(changed));
  db.close();
});
