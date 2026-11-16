import { test } from "node:test";
import assert from "node:assert/strict";
import {
  emptyState,
  newTask,
  localDate,
  type State,
  type Proposal,
} from "../shared/model";
import { applyCommand } from "../shared/operations";
import { WorkspaceDatabase } from "../electron/storage";
import { buildContext } from "../shared/context";

function fixture() {
  let state = emptyState();
  for (const title of ["报告", "英语"])
    state = applyCommand(state, {
      type: "saveTask",
      task: { ...newTask(), title },
    });
  return state;
}
function propose(state: State): Proposal {
  return {
    id: crypto.randomUUID(),
    sessionId: state.activeSessionId,
    createdAt: new Date().toISOString(),
    changes: state.tasks.map((task) => ({
      id: crypto.randomUUID(),
      taskId: task.id,
      taskVersion: task.version,
      type: "schedule",
      date: localDate(),
      scope: "完成初步产出",
      label: task.title,
      reason: "试用",
      children: [],
      status: "pending",
    })),
  };
}
test("部分接受、拒绝和重复接受保持范围正确", () => {
  let state = fixture();
  const proposal = propose(state);
  state = applyCommand(state, { type: "proposal", proposal });
  const command = {
    type: "resolve",
    proposalId: proposal.id,
    ids: [proposal.changes[0].id],
    accept: true,
  } as const;
  state = applyCommand(state, { ...command, ids: [...command.ids] });
  state = applyCommand(state, { ...command, ids: [...command.ids] });
  assert.equal(state.arrangements.length, 1);
  state = applyCommand(state, {
    type: "resolve",
    proposalId: proposal.id,
    ids: [proposal.changes[1].id],
    accept: false,
  });
  assert.equal(state.arrangements.length, 1);
  assert.equal(state.proposals[0].changes[1].status, "rejected");
});
test("旧方案被阻止，失败前后原状态一致", () => {
  let state = fixture();
  const proposal = propose(state);
  state = applyCommand(state, { type: "proposal", proposal });
  state = applyCommand(state, {
    type: "saveTask",
    task: { ...state.tasks[1], title: "已修改" },
  });
  const before = structuredClone(state);
  assert.throws(
    () =>
      applyCommand(state, {
        type: "resolve",
        proposalId: proposal.id,
        ids: proposal.changes.map((change) => change.id),
        accept: true,
      }),
    /重新分析/,
  );
  assert.deepEqual(state, before);
});
test("能量更新与阶段完成各自独立", () => {
  let state = fixture();
  state = applyCommand(state, {
    type: "schedule",
    taskId: state.tasks[0].id,
    date: localDate(),
    scope: "初稿",
  });
  const arrangements = structuredClone(state.arrangements);
  state = applyCommand(state, { type: "energy", value: "需要恢复" });
  assert.deepEqual(state.arrangements, arrangements);
  assert.equal(state.messages.length, 0);
  state = applyCommand(state, {
    type: "stage",
    taskId: state.tasks[0].id,
    date: localDate(),
    done: true,
  });
  assert.equal(state.tasks[0].status, "todo");
  assert.equal(
    buildContext(state, state.activeSessionId).energy.value,
    "需要恢复",
  );
});
test("拒绝循环父子关系和依赖", () => {
  const state = fixture();
  assert.throws(
    () =>
      applyCommand(state, {
        type: "saveTask",
        task: { ...state.tasks[0], parentId: state.tasks[0].id },
      }),
    /循环/,
  );
  assert.throws(
    () =>
      applyCommand(state, {
        type: "saveTask",
        task: { ...state.tasks[0], dependencies: [state.tasks[0].id] },
      }),
    /循环/,
  );
});
test("SQLite 事务、版本冲突与恢复", () => {
  const db = new WorkspaceDatabase(":memory:");
  const initial = db.load();
  const state = db.execute(initial.revision, {
    type: "saveTask",
    task: { ...newTask(), title: "持久化任务" },
  });
  assert.equal(db.load().tasks[0].title, "持久化任务");
  assert.throws(
    () => db.execute(initial.revision, { type: "energy", value: "精力充足" }),
    /重试/,
  );
  assert.deepEqual(db.load(), state);
  db.close();
});

test("保存并安排作为一次操作失败时不留半成品", () => {
  const state = fixture();
  assert.throws(
    () =>
      applyCommand(state, {
        type: "saveTask",
        task: { ...newTask(), title: "新任务" },
        arrangement: { date: "invalid", scope: "阶段目标" },
      }),
    /日期/,
  );
  assert.equal(state.tasks.length, 2);
});

test("重复变更 ID 不会重复创建子任务", () => {
  let state = fixture();
  const proposal = propose(state);
  proposal.changes = [
    {
      ...proposal.changes[0],
      type: "split",
      children: [{ title: "子任务", goal: "完成条件" }],
    },
  ];
  state = applyCommand(state, { type: "proposal", proposal });
  state = applyCommand(state, {
    type: "resolve",
    proposalId: proposal.id,
    ids: [proposal.changes[0].id, proposal.changes[0].id],
    accept: true,
  });
  assert.equal(state.tasks.filter((task) => task.parentId).length, 1);
});

test("拒绝旧方案的一部分不能恢复另一部分的有效性", () => {
  let state = fixture();
  const proposal = propose(state);
  proposal.changes[1] = { ...proposal.changes[0], id: crypto.randomUUID() };
  state = applyCommand(state, { type: "proposal", proposal });
  state = applyCommand(state, {
    type: "saveTask",
    task: { ...state.tasks[0], goal: "修改目标" },
  });
  state = applyCommand(state, {
    type: "resolve",
    proposalId: proposal.id,
    ids: [proposal.changes[0].id],
    accept: false,
  });
  assert.throws(
    () =>
      applyCommand(state, {
        type: "resolve",
        proposalId: proposal.id,
        ids: [proposal.changes[1].id],
        accept: true,
      }),
    /重新分析/,
  );
});
