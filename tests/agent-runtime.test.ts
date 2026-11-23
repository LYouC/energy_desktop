import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AgentRuntime,
  planningSnapshot,
  type Connection,
  type generateAgentTurn,
} from "../src/agent/runtime";
import { WorkspaceDatabase } from "../src/persistence/storage";
import { mkdtempSync, rmSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

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
test("会话草拟经SQLite重开恢复，确认后创建并清空草拟", async (context) => {
  const directory = mkdtempSync(path.join(tmpdir(), "xixu-agent-memory-"));
  const filename = path.join(directory, "workspace.db");
  let db = new WorkspaceDatabase(filename);
  context.after(() => {
    db.close();
    for (const suffix of ["", "-wal", "-shm"])
      rmSync(filename + suffix, { force: true });
    rmdirSync(directory);
  });
  const sessionId = db.load().activeSessionId;
  const draft = {
    title: "整理会议笔记",
    patch: { description: "便于检索决定和待办" },
  };
  await new AgentRuntime(db, connection, async () => ({
    ...result,
    turn: {
      text: "草拟任务为整理会议笔记",
      actions: [],
      memory: { summary: "用户正在确认会议笔记整理任务", taskDraft: draft },
    },
  })).send({ ...request("先草拟一下"), sessionId }, () => {});
  db.close();
  db = new WorkspaceDatabase(filename);
  assert.deepEqual(db.load().sessions[0].agentMemory?.taskDraft, draft);
  await new AgentRuntime(db, connection, async (options) => {
    assert.deepEqual(options.state.sessions[0].agentMemory?.taskDraft, draft);
    return {
      ...result,
      turn: {
        text: "已创建整理会议笔记",
        actions: [
          {
            type: "createTask",
            ...draft,
            mode: "direct",
            quote: "好，就这样",
          },
        ],
        memory: { summary: "会议笔记任务已记录", taskDraft: null },
      },
    };
  }).send({ ...request("好，就这样"), sessionId }, () => {});
  assert.equal(db.load().tasks.length, 1);
  assert.equal(db.load().sessions[0].agentMemory?.taskDraft, null);
});
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
test("失败的一键优化保留草稿，重试不能省略来源扩大权限", async (context) => {
  const db = new WorkspaceDatabase(":memory:");
  context.after(() => db.close());
  const input = {
    ...request("请优化今日安排"),
    sessionId: db.load().activeSessionId,
  };
  const optimization = { ...input, source: "optimizeToday" };
  db.execute(db.load().revision, {
    type: "draft",
    sessionId: input.sessionId,
    text: "未发送草稿",
  });
  const failed = new AgentRuntime(db, connection, async () => {
    throw new Error("模拟模型错误");
  });
  await assert.rejects(
    failed.send(optimization, () => {}),
    /模型调用/,
  );
  assert.equal(db.load().sessions[0].draft, "未发送草稿");
  let calls = 0;
  const restarted = new AgentRuntime(db, connection, async () => {
    calls++;
    return result;
  });
  await assert.rejects(
    restarted.send(input, () => {}),
    /标识/,
  );
  assert.equal(calls, 0);
  const retried = await restarted.send(optimization, () => {});
  assert.equal(retried.messages.length, 2);
  assert.equal(retried.sessions[0].draft, "未发送草稿");
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
  let calls = 0;
  const runtime = new AgentRuntime(db, connection, async () => {
    calls++;
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
  assert.equal(calls, 1);
  fail = false;
  await runtime.send(input, () => {});
  assert.equal(db.load().messages.length, 2);
  db.close();
});
test("网络失败最多自动重试三次，手动重试仍只保存一次用户消息和任务", async (context) => {
  const db = new WorkspaceDatabase(":memory:");
  context.after(() => db.close());
  const input = {
    ...request("记录整理报告"),
    sessionId: db.load().activeSessionId,
  };
  let calls = 0;
  const retries: string[] = [];
  const runtime = new AgentRuntime(db, connection, async () => {
    if (++calls <= 4) throw new TypeError("terminated");
    return {
      ...result,
      turn: {
        text: "已记录",
        actions: [
          {
            type: "createTask",
            title: "整理报告",
            patch: {},
            mode: "direct",
            quote: input.text,
          },
        ],
      },
    };
  });
  await assert.rejects(
    runtime.send(input, (event) => {
      if (event.type === "retry") retries.push(event.text);
    }),
    /自动重试 3 次/,
  );
  assert.equal(calls, 4);
  assert.equal(retries.length, 3);
  assert.equal(db.load().messages.length, 1);
  assert.equal(db.load().tasks.length, 0);
  await runtime.send(input, () => {});
  await runtime.send(input, () => {});
  assert.equal(calls, 5);
  assert.deepEqual(
    db.load().messages.map(({ role }) => role),
    ["user", "assistant"],
  );
  assert.equal(db.load().tasks.length, 1);
});

test("取消自动重试等待后不再请求模型", async (context) => {
  const db = new WorkspaceDatabase(":memory:");
  context.after(() => db.close());
  const input = { ...request(), sessionId: db.load().activeSessionId };
  let calls = 0;
  const runtime = new AgentRuntime(db, connection, async () => {
    calls++;
    throw new TypeError("fetch failed");
  });
  await assert.rejects(
    runtime.send(input, (event) => {
      if (event.type === "retry") runtime.cancel(input.runId);
    }),
    /取消或超时/,
  );
  assert.equal(calls, 1);
  assert.equal(db.load().messages.length, 1);
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
  changed.preferences = state.preferences;
  changed.sessions[0].agentMemory = { summary: "草拟报告", taskDraft: null };
  assert.notEqual(planningSnapshot(state), planningSnapshot(changed));
  db.close();
});
