import { test } from "node:test";
import assert from "node:assert/strict";
import {
  emptyState,
  newTask,
  localDate,
  type State,
  type Proposal,
  type Command,
} from "../src/domain/model";
import { applyCommand } from "../src/domain/operations";
import { WorkspaceDatabase } from "../src/persistence/storage";
import { buildContext } from "../src/agent/context";

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
    cards: state.tasks.map((task) => ({
      id: crypto.randomUUID(),
      taskId: task.id,
      title: task.title,
      reason: "试用",
      status: "pending",
      changes: [
        {
          id: crypto.randomUUID(),
          taskId: task.id,
          taskVersion: task.version,
          type: "schedule",
          date: localDate(),
          scope: "完成初步产出",
          label: task.title,
          children: [],
        },
      ],
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
    cardIds: [proposal.cards[0].id],
    accept: true,
  } as const;
  state = applyCommand(state, { ...command, cardIds: [...command.cardIds] });
  state = applyCommand(state, { ...command, cardIds: [...command.cardIds] });
  assert.equal(state.arrangements.length, 1);
  state = applyCommand(state, {
    type: "resolve",
    proposalId: proposal.id,
    cardIds: [proposal.cards[1].id],
    accept: false,
  });
  assert.equal(state.arrangements.length, 1);
  assert.equal(state.proposals[0].cards[1].status, "rejected");
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
        cardIds: proposal.cards.map((change) => change.id),
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
test("拒绝循环父子关系", () => {
  const state = fixture();
  assert.throws(
    () =>
      applyCommand(state, {
        type: "saveTask",
        task: { ...state.tasks[0], parentId: state.tasks[0].id },
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

test("旧复合保存被拒绝，任务保存不修改已有安排", () => {
  let state = fixture();
  state = applyCommand(state, {
    type: "schedule",
    taskId: state.tasks[0].id,
    date: localDate(),
    scope: state.tasks[0].title,
  });
  const legacy = {
    type: "saveTask",
    task: { ...newTask(), title: "新任务" },
    arrangement: { date: localDate(), scope: "阶段目标" },
  };
  assert.throws(() => applyCommand(state, legacy as unknown as Command));
  const saved = applyCommand(state, {
    type: "saveTask",
    task: { ...state.tasks[0], title: "已改名", expectedDate: localDate() },
  });
  assert.deepEqual(saved.arrangements, state.arrangements);
  assert.equal(saved.tasks.length, 2);
});

test("重复调整卡 ID 不会重复创建子任务", () => {
  let state = fixture();
  const proposal = propose(state);
  proposal.cards.length = 1;
  const [card] = proposal.cards;
  card.changes[0] = {
    ...card.changes[0],
    type: "split",
    children: [{ title: "子任务", description: "完成条件" }],
  };
  state = applyCommand(state, { type: "proposal", proposal });
  state = applyCommand(state, {
    type: "resolve",
    proposalId: proposal.id,
    cardIds: [proposal.cards[0].id, proposal.cards[0].id],
    accept: true,
  });
  assert.equal(state.tasks.filter((task) => task.parentId).length, 1);
});

test("取消安排只生效一次，不存在的安排被拒绝", () => {
  let state = fixture();
  const taskId = state.tasks[0].id;
  state = applyCommand(state, {
    type: "schedule",
    taskId,
    date: localDate(),
    scope: "初稿",
  });
  const version = state.tasks[0].version;
  state = applyCommand(state, {
    type: "unschedule",
    taskId,
    date: localDate(),
  });
  assert.equal(state.arrangements.length, 0);
  assert.equal(state.tasks[0].version, version + 1);
  assert.throws(
    () =>
      applyCommand(state, {
        type: "unschedule",
        taskId,
        date: localDate(),
      }),
    /已变化/,
  );
});
test("最近结果按更新时间降序保留十条", () => {
  let state = emptyState();
  for (let index = 0; index < 12; index++)
    state = applyCommand(state, {
      type: "saveTask",
      task: { ...newTask(), title: `任务${index}`, status: "done" },
    });
  state.tasks.forEach((task, index) => {
    task.updatedAt = `2026-01-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`;
  });
  const results = buildContext(state, state.activeSessionId).recentResults;
  assert.equal(results.length, 10);
  assert.equal(results[0].title, "任务11");
  assert.equal(results[9].title, "任务2");
});
test("拒绝旧方案的一部分不能恢复另一部分的有效性", () => {
  let state = fixture();
  const proposal = propose(state);
  proposal.legacy = true;
  proposal.cards[1] = { ...proposal.cards[0], id: crypto.randomUUID() };
  state = applyCommand(state, { type: "proposal", proposal });
  state = applyCommand(state, {
    type: "saveTask",
    task: { ...state.tasks[0], description: "修改目标" },
  });
  state = applyCommand(state, {
    type: "resolve",
    proposalId: proposal.id,
    cardIds: [proposal.cards[0].id],
    accept: false,
  });
  assert.throws(
    () =>
      applyCommand(state, {
        type: "resolve",
        proposalId: proposal.id,
        cardIds: [proposal.cards[1].id],
        accept: true,
      }),
    /重新分析/,
  );
});
