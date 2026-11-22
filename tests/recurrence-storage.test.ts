import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildContext } from "../src/agent/context";
import { applyAgentTurn } from "../src/agent/turn";
import { emptyState, newTask } from "../src/domain/model";
import { applyCommand } from "../src/domain/operations";
import { WorkspaceDatabase } from "../src/persistence/storage";

test("关闭期间的重复安排在重开时持久化，跳过一天不补回", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "xixu-repeat-storage-"));
  const filename = path.join(directory, "workspace.db");
  let date = "2026-11-16";
  let database = new WorkspaceDatabase(filename, () => date);
  t.after(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const task = {
    ...newTask(),
    title: "练英语",
    recurrence: { type: "daily" as const },
  };
  const created = database.execute(database.load().revision, {
    type: "saveTask",
    task,
  });
  assert.deepEqual(
    created.arrangements.map((item) => item.date),
    ["2026-11-16"],
  );
  const skipped = database.execute(created.revision, {
    type: "skipOccurrence",
    taskId: task.id,
    date,
  });
  assert.equal(skipped.arrangements.length, 0);
  database.close();

  date = "2026-11-19";
  database = new WorkspaceDatabase(filename, () => date);
  const reconciled = database.load();
  assert.deepEqual(
    reconciled.arrangements.map((item) => [
      item.date,
      item.done,
      item.recurrence?.title,
    ]),
    [
      ["2026-11-17", false, "练英语"],
      ["2026-11-18", false, "练英语"],
      ["2026-11-19", false, "练英语"],
    ],
  );
  assert.ok(reconciled.revision > skipped.revision);
  assert.deepEqual(database.load(), reconciled);

  const deleted = database.execute(reconciled.revision, {
    type: "deleteTask",
    id: task.id,
  });
  database.close();
  date = "2026-11-23";
  database = new WorkspaceDatabase(filename, () => date);
  const reopened = database.load();
  assert.equal(reopened.tasks.length, 0);
  assert.deepEqual(reopened.arrangements, deleted.arrangements);
});

test("跨日时使用旧工作区版本操作会刷新安排并提示重试", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "xixu-repeat-conflict-"));
  let date = "2026-11-20";
  const database = new WorkspaceDatabase(
    path.join(directory, "workspace.db"),
    () => date,
  );
  t.after(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const task = {
    ...newTask(),
    title: "晨跑",
    recurrence: { type: "daily" as const },
  };
  const before = database.execute(database.load().revision, {
    type: "saveTask",
    task,
  });
  date = "2026-11-21";
  assert.throws(
    () =>
      database.execute(before.revision, { type: "deleteTask", id: task.id }),
    /数据已更新/,
  );
  const refreshed = database.load();
  assert.equal(refreshed.tasks.length, 1);
  assert.deepEqual(
    refreshed.arrangements.map((item) => item.date),
    ["2026-11-20", "2026-11-21"],
  );
});

test("Agent 不会用普通安排动作覆盖重复实例", () => {
  const task = {
    ...newTask(),
    title: "复习",
    recurrence: { type: "daily" as const },
  };
  const state = applyCommand(
    emptyState(),
    { type: "saveTask", task },
    "2026-11-20",
  );
  assert.throws(
    () =>
      applyAgentTurn(state, state.activeSessionId, "重新安排这项重复任务", {
        text: "建议调整",
        actions: [
          {
            type: "schedule",
            taskId: task.id,
            mode: "proposal",
            date: "2026-11-20",
            scope: "复习第二章",
          },
        ],
      }),
    /请选择对应的重复任务操作/,
  );
});

test("规划上下文显示当天重复实例，历史错过不进入未完成推进记录", () => {
  const task = {
    ...newTask(),
    title: "记单词",
    recurrence: { type: "daily" as const },
  };
  const first = applyCommand(
    emptyState(),
    { type: "saveTask", task },
    "2026-11-20",
  );
  const state = applyCommand(
    first,
    { type: "energy", value: "有些疲惫" },
    "2026-11-21",
  );
  const context = buildContext(state, state.activeSessionId, "2026-11-21");
  assert.deepEqual(
    context.today.map((item) => item.recurrence?.title),
    ["记单词"],
  );
  assert.deepEqual(context.unfinishedTasks[0].previousArrangements, []);
});
