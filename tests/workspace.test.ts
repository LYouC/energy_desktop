import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  emptyState,
  newTask,
  type State,
  type Proposal,
} from "../shared/model";
import { applyCommand } from "../shared/operations";
import { buildContext } from "../shared/context";
import { WorkspaceDatabase } from "../electron/storage";
import { simulateReply } from "../src/features/mock";

function taskState() {
  return applyCommand(emptyState(), {
    type: "saveTask",
    task: { ...newTask(), title: "报告" },
  });
}
function proposalFor(state: State): Proposal {
  const task = state.tasks[0];
  return {
    id: crypto.randomUUID(),
    sessionId: state.activeSessionId,
    createdAt: new Date().toISOString(),
    changes: [
      {
        id: crypto.randomUUID(),
        taskId: task.id,
        taskVersion: task.version,
        type: "schedule",
        date: "2026-11-16",
        scope: "初稿",
        children: [],
        label: "安排",
        reason: "测试",
        status: "pending",
      },
    ],
  };
}

test("修改任务保留 ID，旧版本表单被拒绝", () => {
  let state = taskState();
  const old = structuredClone(state.tasks[0]);
  state = applyCommand(state, {
    type: "saveTask",
    task: { ...old, title: "新标题", description: "纠正后的事实" },
  });
  assert.equal(state.tasks.length, 1);
  assert.equal(state.tasks[0].id, old.id);
  assert.throws(
    () => applyCommand(state, { type: "saveTask", task: old }),
    /重新打开/,
  );
});

test("子任务完成不自动完成父任务，关联循环和缺失目标被拒绝", () => {
  let state = taskState();
  const parent = state.tasks[0];
  state = applyCommand(state, {
    type: "saveTask",
    task: { ...newTask(parent.id), title: "子任务", status: "done" },
  });
  assert.equal(state.tasks[0].status, "todo");
  assert.throws(
    () =>
      applyCommand(state, {
        type: "saveTask",
        task: { ...state.tasks[0], parentId: state.tasks[1].id },
      }),
    /循环/,
  );
  assert.throws(
    () =>
      applyCommand(state, {
        type: "saveTask",
        task: { ...newTask("missing"), title: "缺失父任务" },
      }),
    /不存在/,
  );
});

test("删除父任务清理后代、安排与待处理方案", () => {
  let state = taskState();
  const parent = state.tasks[0];
  const child = { ...newTask(parent.id), title: "子任务" };
  const grandchild = { ...newTask(child.id), title: "孙任务" };
  for (const task of [child, grandchild, { ...newTask(), title: "相关工作" }])
    state = applyCommand(state, { type: "saveTask", task });
  for (const task of state.tasks)
    state = applyCommand(state, {
      type: "schedule",
      taskId: task.id,
      date: "2026-11-16",
      scope: "一个阶段",
    });
  const proposal = proposalFor(state);
  state = applyCommand(state, { type: "proposal", proposal });
  state = applyCommand(state, { type: "deleteTask", id: parent.id });
  assert.deepEqual(
    state.tasks.map((task) => task.title),
    ["相关工作"],
  );
  assert.equal(state.arrangements.length, 1);
  assert.equal(state.proposals[0].changes[0].status, "rejected");
});

test("按日安排与移动只影响对应日期，同日更新保持唯一", () => {
  let state = taskState();
  state = applyCommand(state, {
    type: "saveTask",
    task: { ...newTask(), title: "英语" },
  });
  const [a, b] = state.tasks;
  for (const task of [a, b])
    for (const date of ["2026-11-16", "2026-11-17"])
      state = applyCommand(state, {
        type: "schedule",
        taskId: task.id,
        date,
        scope: "阶段一",
      });
  state = applyCommand(state, {
    type: "schedule",
    taskId: a.id,
    date: "2026-11-16",
    scope: "阶段二",
  });
  assert.equal(state.arrangements.length, 4);
  state = applyCommand(state, {
    type: "move",
    taskId: b.id,
    date: "2026-11-16",
    targetTaskId: a.id,
  });
  assert.deepEqual(
    state.arrangements
      .filter((item) => item.date === "2026-11-16")
      .map((item) => item.taskId),
    [b.id, a.id],
  );
  assert.deepEqual(
    state.arrangements
      .filter((item) => item.date === "2026-11-17")
      .map((item) => item.taskId),
    [a.id, b.id],
  );
  state = applyCommand(state, {
    type: "unschedule",
    taskId: a.id,
    date: "2026-11-16",
  });
  assert.equal(state.tasks[0].startDate, "");
});

for (const status of ["done", "abandoned"] as const)
  test(`${status} 任务需要恢复后安排`, () => {
    let state = taskState();
    state = applyCommand(state, {
      type: "saveTask",
      task: { ...state.tasks[0], status },
    });
    assert.throws(
      () =>
        applyCommand(state, {
          type: "schedule",
          taskId: state.tasks[0].id,
          date: "2026-11-16",
          scope: "阶段",
        }),
      /恢复/,
    );
  });

for (const date of ["2026-02-30", "2026-13-01", "2026-00-01"])
  test(`拒绝不存在的安排日期 ${date}`, () => {
    const state = taskState();
    assert.throws(
      () =>
        applyCommand(state, {
          type: "schedule",
          taskId: state.tasks[0].id,
          date,
          scope: "阶段",
        }),
      /日期/,
    );
  });

test("方案变更 ID 唯一，所属会话必须存在", () => {
  const state = taskState();
  const proposal = proposalFor(state);
  proposal.changes.push(structuredClone(proposal.changes[0]));
  assert.throws(() => applyCommand(state, { type: "proposal", proposal }));
  const foreign = { ...proposalFor(state), sessionId: "missing" };
  assert.throws(() =>
    applyCommand(state, { type: "proposal", proposal: foreign }),
  );
});

test("同任务方案分批接受及无效接受范围", () => {
  let state = taskState();
  const proposal = proposalFor(state);
  proposal.changes.push({
    ...proposal.changes[0],
    id: crypto.randomUUID(),
    type: "split",
    children: [{ title: "第一步", description: "产出" }],
  });
  state = applyCommand(state, { type: "proposal", proposal });
  assert.throws(
    () =>
      applyCommand(state, {
        type: "resolve",
        proposalId: proposal.id,
        ids: ["missing"],
        accept: true,
      }),
    /范围/,
  );
  for (const change of proposal.changes)
    state = applyCommand(state, {
      type: "resolve",
      proposalId: proposal.id,
      ids: [change.id],
      accept: true,
    });
  assert.equal(state.arrangements.length, 1);
  assert.equal(state.tasks.length, 2);
});

test("回复与方案原子保存，失败不会留下孤立回复", () => {
  const state = taskState();
  const proposal = proposalFor(state);
  const message = {
    id: crypto.randomUUID(),
    sessionId: state.activeSessionId,
    role: "assistant" as const,
    text: "方案",
    createdAt: new Date().toISOString(),
    proposalId: proposal.id,
  };
  const valid = applyCommand(state, { type: "reply", message, proposal });
  assert.equal(valid.messages.length, 1);
  assert.equal(valid.proposals.length, 1);
  proposal.changes[0].taskVersion++;
  assert.throws(
    () => applyCommand(state, { type: "reply", message, proposal }),
    /变化/,
  );
  assert.equal(state.messages.length, 0);
  assert.equal(state.proposals.length, 0);
});

test("会话草稿隔离，跨日上下文保留历史停点和已纠正事实", () => {
  let state = taskState();
  const first = state.activeSessionId;
  state = applyCommand(state, {
    type: "draft",
    sessionId: first,
    text: "原草稿",
  });
  state = applyCommand(state, { type: "session", id: "second" });
  state = applyCommand(state, {
    type: "draft",
    sessionId: "second",
    text: "新草稿",
  });
  state = applyCommand(state, {
    type: "saveTask",
    task: {
      ...state.tasks[0],
      description: "已纠正事实；停在初稿；11月18日14点前必须完成",
    },
  });
  state = applyCommand(state, {
    type: "schedule",
    taskId: state.tasks[0].id,
    date: "2026-11-15",
    scope: "初稿",
  });
  state = applyCommand(state, { type: "energy", value: "需要恢复" });
  state = applyCommand(state, { type: "energy", value: "状态平稳" });
  const context = buildContext(state, "second", "2026-11-16");
  assert.equal(context.energy.value, "状态平稳");
  assert.equal(context.today.length, 0);
  assert.equal(context.unfinishedTasks[0].previousArrangements.length, 1);
  assert.equal(
    context.unfinishedTasks[0].description,
    "已纠正事实；停在初稿；11月18日14点前必须完成",
  );
  assert.equal(
    state.sessions.find((item) => item.id === first)?.draft,
    "原草稿",
  );
});

test("磁盘重开、多个连接版本冲突与失败事务回滚", () => {
  const filename = path.join(
    mkdtempSync(path.join(tmpdir(), "xixu-db-test-")),
    "workspace.db",
  );
  const a = new WorkspaceDatabase(filename),
    b = new WorkspaceDatabase(filename);
  try {
    const initial = a.load();
    const saved = a.execute(initial.revision, {
      type: "saveTask",
      task: { ...newTask(), title: "磁盘任务" },
    });
    assert.throws(
      () => b.execute(initial.revision, { type: "energy", value: "需要恢复" }),
      /重试/,
    );
    assert.throws(() =>
      b.execute(saved.revision, {
        type: "saveTask",
        task: { ...newTask(), title: "应回滚" },
        arrangement: { date: "bad", scope: "阶段" },
      }),
    );
    assert.deepEqual(b.load(), saved);
  } finally {
    a.close();
    b.close();
  }
  const restored = new WorkspaceDatabase(filename);
  try {
    assert.equal(restored.load().tasks[0].title, "磁盘任务");
  } finally {
    restored.close();
  }
});

test("拒绝未来数据库版本，保留原数据", () => {
  const filename = path.join(
    mkdtempSync(path.join(tmpdir(), "xixu-version-test-")),
    "workspace.db",
  );
  const db = new DatabaseSync(filename);
  db.exec("PRAGMA user_version=3");
  db.close();
  assert.throws(() => new WorkspaceDatabase(filename), /更新版本/);
  const inspect = new DatabaseSync(filename);
  assert.equal(inspect.prepare("PRAGMA user_version").get()?.user_version, 3);
  inspect.close();
});

test("损坏的工作区打开失败，原始内容仍可检查", () => {
  const filename = path.join(
    mkdtempSync(path.join(tmpdir(), "xixu-corrupt-test-")),
    "workspace.db",
  );
  const initial = new WorkspaceDatabase(filename);
  initial.close();
  const raw = new DatabaseSync(filename);
  raw
    .prepare("UPDATE workspace SET payload=? WHERE id=1")
    .run('{"broken":true}');
  raw.close();
  assert.throws(() => new WorkspaceDatabase(filename));
  const inspect = new DatabaseSync(filename);
  assert.equal(
    inspect.prepare("SELECT payload FROM workspace").get()?.payload,
    '{"broken":true}',
  );
  inspect.close();
});

test("选择子任务后启动协助与拆分使用该子任务", () => {
  let state = taskState();
  const child = {
    ...newTask(state.tasks[0].id),
    title: "查找两份资料",
    description: "保存两个来源，下一步打开资料目录",
  };
  state = applyCommand(state, { type: "saveTask", task: child });
  const start = simulateReply(
    state,
    state.activeSessionId,
    "帮我开始",
    child.id,
  );
  assert.match(start.text, /查找两份资料/);
  assert.match(start.text, /打开资料目录/);
  const split = simulateReply(
    state,
    state.activeSessionId,
    "拆分当前任务",
    child.id,
  );
  assert.equal(split.proposal?.changes[0].taskId, child.id);
  assert.equal(state.tasks.length, 2);
});

test("模拟规划保持任务原状，空工作区返回可操作引导", () => {
  const empty = emptyState();
  assert.equal(
    simulateReply(empty, empty.activeSessionId, "规划今天", null).proposal,
    null,
  );
  const state = taskState(),
    before = structuredClone(state);
  const result = simulateReply(state, state.activeSessionId, "规划今天", null);
  assert.equal(result.proposal?.changes[0].status, "pending");
  assert.deepEqual(state, before);
});
