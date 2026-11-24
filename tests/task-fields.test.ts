import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { emptyState, newTask } from "../src/domain/model";
import {
  applyCommand,
  isArrangementPending,
  schedulableTodayTasks,
  unscheduledTasksDue,
} from "../src/domain/operations";
import { WorkspaceDatabase } from "../src/persistence/storage";
import { buildContext } from "../src/agent/context";
import { agentTurnSchema, applyAgentTurn } from "../src/agent/turn";

test("移动今日任务组时保持各组内部的安排顺序", () => {
  const date = "2026-11-23";
  const parent = { ...newTask(), title: "父任务" };
  const child = { ...newTask(parent.id), title: "子任务" };
  const other = { ...newTask(), title: "独立任务" };
  let state = emptyState();
  for (const task of [parent, child, other])
    state = applyCommand(state, { type: "saveTask", task }, date);
  for (const task of [parent, child, other])
    state = applyCommand(
      state,
      { type: "schedule", taskId: task.id, date, scope: task.title },
      date,
    );
  const command = {
    type: "moveTodayGroups" as const,
    date,
    taskIds: [parent.id, child.id],
    targetTaskIds: [other.id],
  };
  const movedDown = applyCommand(state, command, date);
  assert.deepEqual(
    movedDown.arrangements.map(({ taskId }) => taskId),
    [other.id, parent.id, child.id],
  );
  const movedBack = applyCommand(movedDown, command, date);
  assert.equal(movedBack.arrangements[0].taskId, parent.id);
  assert.deepEqual(
    movedBack.arrangements
      .filter(({ taskId }) => taskId !== other.id)
      .map(({ taskId }) => taskId),
    [parent.id, child.id],
  );
  const childDone = applyCommand(
    state,
    { type: "stage", taskId: child.id, date, done: true },
    date,
  );
  assert.throws(() => applyCommand(childDone, command, date), /安排已变化/);
  assert.equal(childDone.arrangements[1].done, true);
});

test("两组交错时只交换相邻组，第三组不被越过", () => {
  const date = "2026-11-23";
  const source = { ...newTask(), title: "源" };
  const target = { ...newTask(), title: "目标" };
  const third = { ...newTask(), title: "第三组" };
  const sourceChild = { ...newTask(source.id), title: "源组子任务" };
  const targetChild = { ...newTask(target.id), title: "目标组子任务" };
  let state = emptyState();
  for (const task of [source, target, third, targetChild, sourceChild]) {
    state = applyCommand(state, { type: "saveTask", task }, date);
    state = applyCommand(
      state,
      { type: "schedule", taskId: task.id, date, scope: task.title },
      date,
    );
  }
  const reordered = applyCommand(
    state,
    {
      type: "moveTodayGroups",
      date,
      taskIds: [source.id, sourceChild.id],
      targetTaskIds: [target.id, targetChild.id],
    },
    date,
  );
  assert.deepEqual(
    reordered.arrangements.map(({ taskId }) => taskId),
    [target.id, source.id, third.id, targetChild.id, sourceChild.id],
  );
});

test("预计完成入口以提交时的日期和计划为准，重复点击不覆盖已有进展", () => {
  const today = "2026-11-23";
  const tomorrow = "2026-11-24";
  const task = { ...newTask(), title: "吃牛奶", expectedDate: today };
  const due = applyCommand(emptyState(), { type: "saveTask", task }, today);
  assert.deepEqual(
    unscheduledTasksDue(due, today).map(({ id }) => id),
    [task.id],
  );
  const command = {
    type: "scheduleDueToday" as const,
    taskId: task.id,
    date: today,
  };
  assert.deepEqual(applyCommand(due, command, tomorrow).arrangements, []);
  const rescheduled = applyCommand(
    due,
    { type: "saveTask", task: { ...due.tasks[0], expectedDate: tomorrow } },
    today,
  );
  assert.deepEqual(applyCommand(rescheduled, command, today).arrangements, []);
  const arranged = applyCommand(
    due,
    { type: "schedule", taskId: task.id, date: today, scope: "已确认的范围" },
    today,
  );
  const done = applyCommand(
    arranged,
    { type: "stage", taskId: task.id, date: today, done: true },
    today,
  );
  assert.deepEqual(
    applyCommand(done, command, today).arrangements,
    done.arrangements,
  );
});

test("A22 所有任务可安排未来子任务，保留原日程、预计日期和今天的顺序", () => {
  const date = "2026-11-24";
  const future = "2026-11-25";
  const parent = { ...newTask(), title: "准备早餐" };
  const task = {
    ...newTask(parent.id),
    title: "吃牛奶",
    startDate: future,
    expectedDate: future,
  };
  const repeating = {
    ...newTask(),
    title: "阅读",
    recurrence: { type: "weekly" as const, weekdays: [3] },
  };
  let state = emptyState();
  for (const entry of [
    parent,
    task,
    repeating,
    { ...newTask(repeating.id), title: "选一篇文章" },
    { ...newTask(), title: "已完成的任务", status: "done" as const },
    { ...newTask(), title: "已放弃的任务", status: "abandoned" as const },
  ])
    state = applyCommand(state, { type: "saveTask", task: entry }, date);
  state = applyCommand(
    state,
    { type: "schedule", taskId: parent.id, date, scope: parent.title },
    date,
  );
  state = applyCommand(
    state,
    {
      type: "schedule",
      taskId: task.id,
      date: future,
      scope: "准备明天的早餐",
    },
    date,
  );
  assert.deepEqual(
    schedulableTodayTasks(state, date).map(({ id }) => id),
    [task.id],
  );
  const command = { type: "scheduleToday", taskId: task.id, date } as const;
  assert.deepEqual(
    applyCommand(state, command, "2026-11-26").arrangements.filter(
      (item) => item.taskId === task.id,
    ),
    [{ taskId: task.id, date: future, scope: "准备明天的早餐", done: false }],
  );
  const next = applyCommand(state, command, date);
  assert.deepEqual(next.arrangements, [
    ...state.arrangements,
    { taskId: task.id, date, scope: task.title, done: false },
  ]);
  const updated = next.tasks.find(({ id }) => id === task.id);
  assert.equal(updated?.startDate, future);
  assert.equal(updated?.expectedDate, future);
  const completed = applyCommand(
    next,
    { type: "stage", taskId: task.id, date, done: true },
    date,
  );
  assert.deepEqual(
    applyCommand(completed, command, date).arrangements,
    completed.arrangements,
  );
});

test("仍有当天移除记录的子任务不会从今日或所有任务入口重复安排", () => {
  const date = "2026-11-23";
  const parent = {
    ...newTask(),
    title: "每日计划",
    recurrence: { type: "daily" as const },
  };
  const task = { ...newTask(parent.id), title: "复习", expectedDate: date };
  let state = applyCommand(
    emptyState(),
    { type: "saveTask", task: parent },
    date,
  );
  state = applyCommand(state, { type: "saveTask", task }, date);
  state = applyCommand(
    state,
    { type: "skipOccurrence", taskId: task.id, date },
    date,
  );
  state = applyCommand(
    state,
    { type: "saveTask", task: { ...state.tasks[1], parentId: null } },
    date,
  );
  assert.deepEqual(unscheduledTasksDue(state, date), []);
  assert.deepEqual(schedulableTodayTasks(state, date), []);
  for (const type of ["scheduleDueToday", "scheduleToday"] as const) {
    const next = applyCommand(state, { type, taskId: task.id, date }, date);
    assert.deepEqual(next.arrangements, state.arrangements);
    assert.deepEqual(next.skippedOccurrences, state.skippedOccurrences);
  }
});

test("A21 整体完成覆盖各层一次性子任务，保留旧阶段与重复实例", () => {
  const date = "2026-11-23";
  const parent = { ...newTask(), title: "准备行程" };
  const child = { ...newTask(parent.id), title: "订票", expectedDate: date };
  const grandchild = { ...newTask(child.id), title: "核对目的地" };
  const repeat = {
    ...newTask(parent.id),
    title: "每日查票",
    recurrence: { type: "daily" as const },
  };
  let state = emptyState();
  for (const task of [parent, child, grandchild, repeat])
    state = applyCommand(state, { type: "saveTask", task }, date);
  for (const task of [parent, child])
    state = applyCommand(
      state,
      { type: "schedule", taskId: task.id, date, scope: task.title },
      date,
    );
  const complete = {
    type: "setTaskDone",
    taskId: parent.id,
    done: true,
  } as const;
  const completed = applyCommand(state, complete, date);
  assert.deepEqual(
    completed.tasks.map((task) => task.status),
    ["done", "done", "done", "todo"],
  );
  assert.deepEqual(completed.arrangements, state.arrangements);
  assert.deepEqual(unscheduledTasksDue(completed, date), []);
  const context = buildContext(completed, state.activeSessionId, date);
  assert.deepEqual(
    context.today.map((item) => [item.done, "taskDone" in item]),
    [
      [false, false],
      [false, true],
      [false, true],
    ],
  );
  const restored = applyCommand(completed, { ...complete, done: false }, date);
  assert.deepEqual(
    restored.tasks.map((task) => task.status),
    ["todo", "done", "done", "todo"],
  );
  assert.deepEqual(restored.arrangements, state.arrangements);
});

test("普通任务继承未来重复后，今天的临时安排仍可独立完成和恢复", () => {
  const date = "2026-11-23";
  const parent = { ...newTask(), title: "练习" };
  const child = { ...newTask(parent.id), title: "朗读" };
  let state = emptyState();
  for (const task of [parent, child])
    state = applyCommand(state, { type: "saveTask", task }, date);
  state = applyCommand(
    state,
    { type: "schedule", taskId: child.id, date, scope: child.title },
    date,
  );
  state = applyCommand(
    state,
    { type: "setTaskDone", taskId: child.id, done: true },
    date,
  );
  state = applyCommand(
    state,
    {
      type: "saveTask",
      task: {
        ...state.tasks[0],
        recurrence: { type: "weekly", weekdays: [2] },
      },
    },
    date,
  );
  assert.equal(state.arrangements[0].recurrence, undefined);
  assert.equal(
    isArrangementPending(state.arrangements[0], state.tasks[1], true),
    true,
  );
  const stage = { type: "stage", taskId: child.id, date, done: true } as const;
  const finished = applyCommand(state, stage, date);
  assert.equal(
    isArrangementPending(finished.arrangements[0], finished.tasks[1], true),
    false,
  );
  const restored = applyCommand(finished, { ...stage, done: false }, date);
  assert.equal(
    isArrangementPending(restored.arrangements[0], restored.tasks[1], true),
    true,
  );
  assert.equal(restored.tasks[1].status, "done");
});

test("普通任务与子任务共用最小字段，名称以外可以留空", () => {
  let state = applyCommand(emptyState(), {
    type: "saveTask",
    task: { ...newTask(), title: "买洗衣液" },
  });
  state = applyCommand(state, {
    type: "saveTask",
    task: { ...newTask(state.tasks[0].id), title: "挑选规格" },
  });
  assert.deepEqual(
    Object.keys(state.tasks[0]).sort(),
    Object.keys(state.tasks[1]).sort(),
  );
  assert.deepEqual(
    Object.keys(state.tasks[0]).sort(),
    [
      "id",
      "version",
      "title",
      "description",
      "startDate",
      "expectedDate",
      "status",
      "importance",
      "parentId",
      "updatedAt",
    ].sort(),
  );
});

test("旧版任务和保存命令兼容用户标注，重开保留标注且允许清空", () => {
  const filename = path.join(
    mkdtempSync(path.join(tmpdir(), "xixu-importance-")),
    "workspace.db",
  );
  const { importance, ...task } = { ...newTask(), title: "旧任务", version: 1 };
  const previous = { ...emptyState(), tasks: [task] };
  const raw = new DatabaseSync(filename);
  raw.exec(
    "CREATE TABLE workspace(id INTEGER PRIMARY KEY, revision INTEGER, payload TEXT); PRAGMA user_version=2;",
  );
  raw
    .prepare("INSERT INTO workspace VALUES(1, ?, ?)")
    .run(previous.revision, JSON.stringify(previous));
  raw.close();

  const db = new WorkspaceDatabase(filename);
  const original = db.load();
  assert.equal(original.tasks[0].importance, null);
  const marked = db.execute(original.revision, {
    type: "saveTask",
    task: { ...original.tasks[0], importance: "high" },
  });
  assert.equal(marked.tasks[0].importance, "high");
  db.close();

  const reopened = new WorkspaceDatabase(filename);
  const saved = reopened.load();
  assert.equal(saved.tasks[0].importance, "high");
  const updated = reopened.execute(saved.revision, {
    type: "saveTask",
    task: { ...task, version: saved.tasks[0].version, title: "修改旧任务" },
  });
  assert.equal(updated.tasks[0].importance, "high");
  const cleared = reopened.execute(updated.revision, {
    type: "saveTask",
    task: { ...updated.tasks[0], importance },
  });
  assert.equal(cleared.tasks[0].importance, null);
  reopened.close();
});

test("Agent 从上下文读取用户标注，工具写入和草稿不能更改重要性", () => {
  const marked = applyCommand(emptyState(), {
    type: "saveTask",
    task: { ...newTask(), title: "报告", importance: "high" },
  });
  const taskId = marked.tasks[0].id;
  const sessionId = marked.activeSessionId;
  assert.equal(
    buildContext(marked, sessionId).unfinishedTasks[0].importance,
    "high",
  );
  const action = {
    type: "updateTask",
    mode: "direct",
    taskId,
    patch: { title: "进展报告" },
  };
  const updated = applyAgentTurn(marked, sessionId, "把报告改名为进展报告", {
    text: "已更名",
    actions: [action],
  });
  assert.equal(updated.tasks[0].title, "进展报告");
  assert.equal(updated.tasks[0].importance, "high");

  for (const input of [
    { actions: [{ ...action, patch: { importance: "low" } }] },
    {
      actions: [
        {
          type: "split",
          mode: "proposal",
          taskId,
          children: [{ title: "初稿", importance: "low" }],
        },
      ],
    },
    {
      actions: [],
      memory: {
        summary: "",
        taskDraft: { title: "周报", patch: { importance: "low" } },
      },
    },
  ]) {
    assert.equal(
      agentTurnSchema.safeParse({ text: "变更", ...input }).success,
      false,
    );
  }
});

test("安排、取消与阶段完成不改预计起止日期", () => {
  let state = applyCommand(emptyState(), {
    type: "saveTask",
    task: {
      ...newTask(),
      title: "报告",
      startDate: "2026-11-17",
      expectedDate: "2026-11-20",
    },
  });
  const id = state.tasks[0].id;
  for (const date of ["2026-11-18", "2026-11-19"])
    state = applyCommand(state, {
      type: "schedule",
      taskId: id,
      date,
      scope: "写一部分",
    });
  state = applyCommand(state, {
    type: "stage",
    taskId: id,
    date: "2026-11-18",
    done: true,
  });
  state = applyCommand(state, {
    type: "unschedule",
    taskId: id,
    date: "2026-11-19",
  });
  assert.equal(state.tasks[0].startDate, "2026-11-17");
  assert.equal(state.tasks[0].expectedDate, "2026-11-20");
  assert.equal(state.tasks[0].status, "todo");
});

test("非法日期与完成早于开始被拒绝，允许同日及单独填写", () => {
  const initial = emptyState();
  for (const patch of [
    { startDate: "2026-02-30" },
    { expectedDate: "not-a-date" },
    { startDate: "2026-11-20", expectedDate: "2026-11-19" },
  ])
    assert.throws(
      () =>
        applyCommand(initial, {
          type: "saveTask",
          task: { ...newTask(), title: "任务", ...patch },
        }),
      /日期/,
    );
  for (const patch of [
    { startDate: "2026-11-20" },
    { expectedDate: "2026-11-20" },
    { startDate: "2026-11-20", expectedDate: "2026-11-20" },
  ])
    assert.doesNotThrow(() =>
      applyCommand(initial, {
        type: "saveTask",
        task: { ...newTask(), title: "任务", ...patch },
      }),
    );
  assert.equal(initial.tasks.length, 0);
});

test("v1 数据库迁移保留任务、安排和会话，旧文本合入说明且仅迁移一次", () => {
  const filename = path.join(
    mkdtempSync(path.join(tmpdir(), "xixu-migrate-")),
    "workspace.db",
  );
  const previous = {
    ...emptyState(),
    tasks: [
      {
        id: "parent",
        version: 1,
        title: "报告",
        goal: "交付初稿",
        deadline: "2026-11-20T14:00",
        plannedDate: "2026-11-18",
        expectedDate: "2026-11-19",
        importance: "高",
        status: "todo",
        parentId: null,
        dependencies: [],
        background: "可能缺材料",
        backgroundKind: "推测",
        progress: "完成提纲",
        obstacle: "",
        nextStep: "写第一节",
        updatedAt: new Date().toISOString(),
      },
    ],
  };
  previous.arrangements.push({
    taskId: "parent",
    date: "2026-11-18",
    scope: "写第一节",
    done: false,
  });
  previous.sessions[0].draft = "未发送输入";
  const previousProposal = {
    id: "old",
    sessionId: previous.activeSessionId,
    createdAt: new Date().toISOString(),
    changes: [
      {
        id: "change",
        taskId: "parent",
        taskVersion: 1,
        label: "旧方案",
        reason: "试用",
        type: "update",
        date: "",
        scope: "",
        children: [],
        status: "pending",
      },
    ],
  };
  const raw = new DatabaseSync(filename);
  raw.exec(
    "CREATE TABLE workspace(id INTEGER PRIMARY KEY, revision INTEGER, payload TEXT); PRAGMA user_version=1;",
  );
  raw
    .prepare("INSERT INTO workspace VALUES(1, ?, ?)")
    .run(
      previous.revision,
      JSON.stringify({ ...previous, proposals: [previousProposal] }),
    );
  raw.close();
  const db = new WorkspaceDatabase(filename);
  const migrated = db.load();
  assert.equal(migrated.tasks[0].startDate, "");
  assert.equal(migrated.tasks[0].importance, null);
  assert.equal(migrated.tasks[0].expectedDate, "2026-11-19");
  assert.match(migrated.tasks[0].description, /交付初稿/);
  assert.match(migrated.tasks[0].description, /背景（推测）：可能缺材料/);
  assert.match(migrated.tasks[0].description, /截止要求：2026-11-20T14:00/);
  assert.equal("deadline" in migrated.tasks[0], false);
  assert.equal("plannedDate" in migrated.tasks[0], false);
  assert.deepEqual(migrated.arrangements, previous.arrangements);
  assert.equal(migrated.sessions[0].draft, "未发送输入");
  assert.equal(migrated.proposals[0].cards[0].status, "rejected");
  db.close();
  const reopened = new WorkspaceDatabase(filename);
  assert.deepEqual(reopened.load(), migrated);
  reopened.close();
});

test("迁移失败回滚版本与原记录", () => {
  const filename = path.join(
    mkdtempSync(path.join(tmpdir(), "xixu-migrate-invalid-")),
    "workspace.db",
  );
  const raw = new DatabaseSync(filename);
  raw.exec(
    "CREATE TABLE workspace(id INTEGER PRIMARY KEY, revision INTEGER, payload TEXT); PRAGMA user_version=1;",
  );
  raw.prepare("INSERT INTO workspace VALUES(1, 0, ?)").run('{"broken":true}');
  raw.close();
  assert.throws(() => new WorkspaceDatabase(filename));
  const inspect = new DatabaseSync(filename);
  assert.equal(inspect.prepare("PRAGMA user_version").get()?.user_version, 1);
  assert.equal(
    inspect.prepare("SELECT payload FROM workspace").get()?.payload,
    '{"broken":true}',
  );
  inspect.close();
});
