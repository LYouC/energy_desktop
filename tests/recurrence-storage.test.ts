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

test("重复父任务的两个子任务跟随结算，次日重新开始", (t) => {
  let date = "2026-11-23";
  const db = new WorkspaceDatabase(":memory:", () => date);
  t.after(() => db.close());
  const parent = {
    ...newTask(),
    title: "工作日日常",
    recurrence: { type: "weekly" as const, weekdays: [1, 2] },
  };
  const children = ["早睡早起", "读书"].map((title) => ({
    ...newTask(parent.id),
    title,
  }));
  for (const task of [parent, ...children])
    db.execute(db.load().revision, { type: "saveTask", task });
  const day = () => db.load().arrangements.filter((item) => item.date === date);
  assert.deepEqual(
    day().map((item) => item.recurrence?.title),
    ["工作日日常", "早睡早起", "读书"],
  );
  db.execute(db.load().revision, {
    type: "stage",
    taskId: children[0].id,
    date,
    done: true,
  });
  assert.deepEqual(
    day().map((item) => item.done),
    [false, true, false],
  );
  date = "2026-11-24";
  assert.deepEqual(
    day().map((item) => item.done),
    [false, false, false],
  );
  date = "2026-11-25";
  assert.deepEqual(day(), []);
});

test("删除模板后保留本地执行记录，Agent 的今日计划只包含现存任务", (t) => {
  const date = "2026-11-23";
  const db = new WorkspaceDatabase(":memory:", () => date);
  t.after(() => db.close());
  const removed = {
    ...newTask(),
    title: "已删除的模板",
    recurrence: { type: "daily" as const },
  };
  const skipped = {
    ...newTask(),
    title: "已移除后删除的模板",
    recurrence: { type: "daily" as const },
  };
  const active = {
    ...newTask(),
    title: "继续执行",
    recurrence: { type: "daily" as const },
  };
  for (const task of [removed, skipped, active])
    db.execute(db.load().revision, { type: "saveTask", task });
  const execute = (command: Parameters<typeof db.execute>[1]) =>
    db.execute(db.load().revision, command);
  execute({ type: "skipOccurrence", taskId: skipped.id, date });
  execute({ type: "deleteTask", id: skipped.id });
  const state = execute({ type: "deleteTask", id: removed.id });
  assert.ok(state.arrangements.some((item) => item.taskId === removed.id));
  const context = buildContext(state, state.activeSessionId, date);
  assert.deepEqual(
    context.today.map((item) => item.taskId),
    [active.id],
  );
  assert.deepEqual(context.skippedToday, []);
});

test("已有子任务获得父规则，父规则更新保留当天，独立规则继续生效", (t) => {
  let date = "2026-11-23";
  const db = new WorkspaceDatabase(":memory:", () => date);
  t.after(() => db.close());
  const parent = { ...newTask(), title: "工作计划" };
  const child = { ...newTask(parent.id), title: "练习" };
  const grandchild = { ...newTask(child.id), title: "热身" };
  const independent = {
    ...newTask(parent.id),
    title: "独立周三计划",
    recurrence: { type: "weekly" as const, weekdays: [3] },
  };
  const execute = (command: Parameters<typeof db.execute>[1]) =>
    db.execute(db.load().revision, command);
  for (const task of [parent, child, grandchild, independent])
    execute({ type: "saveTask", task });
  execute({ type: "schedule", taskId: child.id, date, scope: "保留既有范围" });
  execute({ type: "stage", taskId: child.id, date, done: true });
  const setParentRule = (weekdays: number[]) =>
    execute({
      type: "saveTask",
      task: {
        ...db.load().tasks.find((task) => task.id === parent.id)!,
        recurrence: { type: "weekly", weekdays },
      },
    });
  setParentRule([1, 2]);
  const first = db.load().arrangements;
  assert.equal(first.length, 3);
  assert.deepEqual(
    first.find((item) => item.taskId === child.id),
    {
      taskId: child.id,
      date,
      scope: "保留既有范围",
      done: true,
      recurrence: { title: "练习", ancestorIds: [parent.id] },
    },
  );
  setParentRule([3]);
  assert.deepEqual(db.load().arrangements, first);
  date = "2026-11-24";
  assert.equal(
    db.load().arrangements.some((item) => item.date === date),
    false,
  );
  date = "2026-11-25";
  assert.equal(
    db.load().arrangements.filter((item) => item.date === date).length,
    4,
  );
});

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
