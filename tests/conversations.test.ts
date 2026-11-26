import { test } from "node:test";
import assert from "node:assert/strict";
import {
  conversationHistory,
  conversationLimit,
} from "../src/domain/conversations";
import { emptyState, newTask } from "../src/domain/model";
import { applyCommand } from "../src/domain/operations";
import { WorkspaceDatabase } from "../src/persistence/storage";

test("删除当前会话只清理会话数据，选中最近会话并在删空时补一条", (context) => {
  const db = new WorkspaceDatabase(":memory:");
  context.after(() => db.close());
  let state = db.load();
  const first = state.activeSessionId;
  state = db.execute(state.revision, { type: "session", id: "second" });
  state = db.execute(state.revision, {
    type: "saveTask",
    task: { ...newTask(), title: "已保存" },
  });
  state = db.execute(state.revision, {
    type: "reply",
    message: {
      id: "reply",
      sessionId: "second",
      role: "assistant",
      text: "方案",
      createdAt: "2026-11-18T02:00:00.000Z",
      proposalId: "proposal",
    },
    proposal: {
      id: "proposal",
      sessionId: "second",
      createdAt: "2026-11-18T02:00:00.000Z",
      cards: [],
    },
  });
  state = db.execute(state.revision, {
    type: "draft",
    sessionId: "second",
    text: "草稿",
  });
  state = db.execute(state.revision, { type: "deleteSession", id: "second" });
  assert.equal(state.activeSessionId, first);
  assert.equal(state.messages.length, 0);
  assert.equal(state.proposals.length, 0);
  assert.equal(state.tasks[0].title, "已保存");
  state = db.execute(state.revision, { type: "deleteSession", id: first });
  assert.notEqual(state.activeSessionId, first);
  assert.deepEqual(
    db.load().sessions.map(({ id }) => id),
    [state.activeSessionId],
  );
});

test("历史使用最后一条消息时间排序，满额后淘汰最旧会话及其消息", () => {
  const state = emptyState();
  const oldTimestamp = "2000-01-01T00:00:00.000Z";
  const recentTimestamp = "2010-01-01T00:00:00.000Z";
  state.sessions = Array.from({ length: conversationLimit }, (_, index) => ({
    id: `old-${index}`,
    title: "旧会话",
    draft: "",
    createdAt: oldTimestamp,
  }));
  state.activeSessionId = state.sessions[0].id;
  state.messages = [
    {
      id: "recent",
      sessionId: "old-0",
      role: "assistant",
      text: "最近的回复",
      createdAt: recentTimestamp,
    },
    {
      id: "old",
      sessionId: "old-1",
      role: "user",
      text: "旧消息",
      createdAt: oldTimestamp,
    },
  ];
  assert.equal(conversationHistory(state)[0].lastActivity, recentTimestamp);
  state.sessions.slice(2).forEach((session) => {
    session.createdAt = recentTimestamp;
  });
  const next = applyCommand(state, { type: "session", id: "new" });
  assert.equal(next.sessions.length, conversationLimit);
  assert.equal(next.activeSessionId, "new");
  assert.ok(!next.sessions.some(({ id }) => id === "old-1"));
  assert.deepEqual(
    next.messages.map(({ id }) => id),
    ["recent"],
  );
});
