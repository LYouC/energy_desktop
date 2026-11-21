import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { emptyState, newTask } from "../src/domain/model";
import { applyCommand } from "../src/domain/operations";
import { WorkspaceDatabase } from "../src/persistence/storage";
import { buildContext } from "../src/agent/context";
import { agentTurnSchema, applyAgentTurn } from "../src/agent/turn";

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
  previous.proposals.push({
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
  });
  const raw = new DatabaseSync(filename);
  raw.exec(
    "CREATE TABLE workspace(id INTEGER PRIMARY KEY, revision INTEGER, payload TEXT); PRAGMA user_version=1;",
  );
  raw
    .prepare("INSERT INTO workspace VALUES(1, ?, ?)")
    .run(previous.revision, JSON.stringify(previous));
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
  assert.equal(migrated.proposals[0].changes[0].status, "rejected");
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
