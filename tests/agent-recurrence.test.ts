import assert from "node:assert/strict";
import { test } from "node:test";
import { applyAgentTurn, type AgentTurn } from "../src/agent/turn";
import { emptyState, newTask, type State } from "../src/domain/model";
import { applyCommand } from "../src/domain/operations";
import { WorkspaceDatabase } from "../src/persistence/storage";

const today = "2026-11-23";
const tomorrow = "2026-11-24";
const direct = "direct" as const;
const proposal = "proposal" as const;

function turn(state: State, actions: AgentTurn["actions"], date = today) {
  return applyAgentTurn(
    state,
    state.activeSessionId,
    "按本轮讨论处理",
    { text: "已核对变更", actions },
    undefined,
    date,
  );
}

function withDailyTask() {
  return turn(emptyState(), [
    {
      type: "createTask",
      mode: direct,
      title: "拉伸",
      patch: {},
      recurrence: { type: "daily" },
    },
  ]);
}

test("Agent 的直接操作和待接受建议都不能完成未来轮次", () => {
  const state = turn(emptyState(), [
    {
      type: "createTask",
      mode: direct,
      title: "拉伸",
      patch: {},
      recurrence: { type: "weekly", weekdays: [2, 4] },
    },
  ]);
  const taskId = state.tasks[0].id;
  const complete = {
    type: "setOccurrenceDone",
    mode: direct,
    taskId,
    date: tomorrow,
    done: true,
  } as const;
  assert.deepEqual(state.arrangements, []);
  for (const mode of [direct, proposal])
    assert.throws(() => turn(state, [{ ...complete, mode }]), /还没到应做日期/);
  assert.deepEqual(state.repeatCompletions, []);
  const finished = turn(state, [complete], tomorrow);
  assert.equal(finished.arrangements[0].done, true);
  assert.deepEqual(finished.repeatCompletions, [
    { taskId, date: tomorrow, completedOn: tomorrow },
  ]);
  assert.throws(
    () => turn(finished, [{ ...complete, date: "2026-11-26" }], tomorrow),
    /还没到应做日期/,
  );
  assert.deepEqual(
    turn(finished, [{ ...complete, done: false }], tomorrow).repeatCompletions,
    [],
  );
});

test("编辑任务同步今日内容，父项完成方案复核当天子任务范围", () => {
  const original = withDailyTask();
  const parent = original.tasks[0];
  const updated = turn(original, [
    {
      type: "updateTask",
      mode: direct,
      taskId: parent.id,
      patch: { title: "新名称" },
    },
  ]);
  assert.equal(updated.arrangements[0].scope, "新名称");
  const doneProposal = turn(updated, [
    {
      type: "setOccurrenceDone",
      mode: proposal,
      taskId: parent.id,
      date: today,
      done: true,
    },
  ]);
  const added = applyCommand(
    doneProposal,
    { type: "saveTask", task: { ...newTask(parent.id), title: "新增子项" } },
    today,
  );
  const completion = added.proposals.at(-1)!;
  assert.throws(
    () =>
      turn(added, [
        {
          type: "resolve",
          mode: direct,
          accept: true,
          proposalId: completion.id,
          cardIds: [completion.cards[0].id],
        },
      ]),
    /子任务的今日完成范围已变化/,
  );
  const completed = turn(added, [
    {
      type: "setOccurrenceDone",
      mode: direct,
      taskId: parent.id,
      date: today,
      done: true,
    },
  ]);
  assert.deepEqual(
    completed.arrangements.map(({ done }) => done),
    [true, true],
  );
});

test("Agent 可创建每天、每周和含首尾的日期范围任务，同轮编辑任务本身", () => {
  const state = turn(emptyState(), [
    {
      type: "createTask",
      mode: direct,
      title: "拉伸",
      ref: "stretch",
      patch: {},
      recurrence: { type: "daily" },
    },
    {
      type: "updateTask",
      mode: direct,
      taskId: "stretch",
      patch: { title: "拉伸五分钟" },
    },
    {
      type: "createTask",
      mode: direct,
      title: "慢跑",
      patch: {},
      recurrence: { type: "weekly", weekdays: [5, 1, 3] },
    },
    {
      type: "createTask",
      mode: direct,
      title: "复习",
      patch: {},
      recurrence: { type: "range", start: tomorrow, end: "2026-11-25" },
    },
  ]);
  const [daily, weekly, range] = state.tasks;
  assert.deepEqual(weekly.recurrence, { type: "weekly", weekdays: [1, 3, 5] });
  assert.deepEqual(
    state.arrangements.map((item) => [item.taskId, item.scope]),
    [
      [daily.id, "拉伸五分钟"],
      [weekly.id, "慢跑"],
    ],
  );
  const middle = turn(state, [], "2026-11-25");
  assert.deepEqual(
    middle.arrangements.map((item) => item.taskId),
    [daily.id, weekly.id, range.id],
  );
  const later = turn(middle, [], "2026-11-26");
  assert.deepEqual(
    later.arrangements.map((item) => item.taskId),
    [daily.id],
  );
});

test("现有普通任务首次设重复复用同日安排，改规则排除今天时仍保留完成记录", () => {
  const task = { ...newTask(), title: "练琴" };
  let state = applyCommand(emptyState(), { type: "saveTask", task }, today);
  state = applyCommand(
    state,
    { type: "schedule", taskId: task.id, date: today, scope: "练第一段" },
    today,
  );
  const taskId = task.id;
  const daily = turn(state, [
    {
      type: "updateRecurrence",
      mode: direct,
      taskId,
      recurrence: { type: "daily" },
    },
    {
      type: "setOccurrenceDone",
      mode: direct,
      taskId,
      date: today,
      done: true,
    },
  ]);
  const weekly = turn(daily, [
    {
      type: "updateRecurrence",
      mode: direct,
      taskId,
      recurrence: { type: "weekly", weekdays: [3] },
    },
  ]);
  assert.deepEqual(weekly.arrangements, []);
  assert.deepEqual(weekly.repeatCompletions, [
    { taskId, date: today, completedOn: today },
  ]);
  assert.equal(weekly.tasks[0].status, "todo");
  assert.deepEqual(
    turn(weekly, [], "2026-11-25").arrangements.map((item) => item.date),
    ["2026-11-25"],
  );
});

test("Agent 停止或恢复重复保留完成记录，删除清除全部记录", () => {
  const original = withDailyTask();
  const taskId = original.tasks[0].id;
  const completed = turn(original, [
    {
      type: "setOccurrenceDone",
      mode: direct,
      taskId,
      date: today,
      done: true,
    },
  ]);
  const stopped = turn(completed, [
    { type: "stopRecurrence", mode: direct, taskId },
  ]);
  assert.equal(stopped.arrangements[0].done, true);
  const later = turn(stopped, [], tomorrow);
  assert.deepEqual(later.arrangements, []);
  const resumed = turn(
    later,
    [{ type: "resumeRecurrence", mode: direct, taskId }],
    tomorrow,
  );
  assert.equal(resumed.arrangements[0].done, false);
  assert.deepEqual(resumed.repeatCompletions, completed.repeatCompletions);
  const deleted = turn(
    resumed,
    [{ type: "deleteRecurringTask", mode: direct, taskId }],
    tomorrow,
  );
  assert.deepEqual(deleted.tasks, []);
  assert.deepEqual(deleted.arrangements, []);
  assert.deepEqual(deleted.repeatCompletions, []);
});

test("规则和当天实例同卡生效，实例过期时整卡失败", () => {
  const original = withDailyTask();
  const taskId = original.tasks[0].id;
  const suggested = turn(original, [
    { type: "skipOccurrence", mode: proposal, taskId, date: today },
    {
      type: "updateRecurrence",
      mode: proposal,
      taskId,
      recurrence: { type: "weekly", weekdays: [5] },
    },
  ]);
  assert.deepEqual(suggested.tasks, original.tasks);
  assert.deepEqual(suggested.arrangements, original.arrangements);
  const plan = suggested.proposals.at(-1)!;
  assert.equal(plan.cards.length, 1);
  const accept = {
    type: "resolve" as const,
    mode: direct,
    proposalId: plan.id,
    cardIds: [plan.cards[0].id],
    accept: true,
  };
  const accepted = turn(suggested, [accept]);
  assert.deepEqual(accepted.tasks[0].recurrence, {
    type: "weekly",
    weekdays: [5],
  });
  assert.equal(accepted.arrangements.length, 0);
  assert.throws(
    () => turn(suggested, [accept], tomorrow),
    /日期已变化|当天安排/,
  );
  const edited = applyCommand(
    suggested,
    {
      type: "saveTask",
      task: { ...suggested.tasks[0], title: "拉伸十分钟" },
    },
    today,
  );
  assert.throws(() => turn(edited, [accept]), /任务已变化/);
  assert.equal(edited.proposals.at(-1)?.cards[0].status, "pending");
  assert.deepEqual(edited.tasks[0].recurrence, original.tasks[0].recurrence);
});

test("删除模板需要覆盖子任务的明确范围，新增后代使旧建议失效", () => {
  const original = withDailyTask();
  const taskId = original.tasks[0].id;
  const child = { ...newTask(taskId), title: "活动肩颈" };
  const withChild = applyCommand(
    original,
    { type: "saveTask", task: child },
    today,
  );
  assert.throws(
    () =>
      turn(withChild, [{ type: "deleteRecurringTask", mode: direct, taskId }]),
    /核实删除范围/,
  );
  const suggested = turn(withChild, [
    {
      type: "deleteRecurringTask",
      mode: proposal,
      taskId,
      includeChildren: true,
    },
  ]);
  const plan = suggested.proposals.at(-1)!;
  const changes = [
    {
      type: "resolve",
      mode: direct,
      proposalId: plan.id,
      cardIds: [plan.cards[0].id],
      accept: true,
    },
  ] satisfies AgentTurn["actions"];
  const updated = applyCommand(
    suggested,
    {
      type: "saveTask",
      task: { ...newTask(child.id), title: "准备弹力带" },
    },
    today,
  );
  assert.throws(() => turn(updated, changes), /子任务范围已变化/);
  assert.equal(updated.tasks.length, 3);
  const deleted = turn(suggested, changes);
  assert.deepEqual(deleted.tasks, []);
  assert.deepEqual(deleted.arrangements, []);
});

test("Agent 拆分重复父任务时，子任务在本轮按同一规则生成实例", () => {
  const original = withDailyTask();
  const next = turn(original, [
    {
      type: "split",
      mode: direct,
      taskId: original.tasks[0].id,
      children: [
        { title: "热身", description: "" },
        { title: "收尾", description: "" },
      ],
    },
  ]);
  assert.deepEqual(
    next.arrangements.map((item) => item.scope),
    [original.tasks[0].title, "热身", "收尾"],
  );
});

test("停止并恢复当天安排后，旧的子任务确认卡不能作用于重新排入的轮次", () => {
  const original = withDailyTask();
  const parent = original.tasks[0];
  const child = { ...newTask(parent.id), title: "准备弹力带" };
  const withChild = applyCommand(
    original,
    { type: "saveTask", task: child },
    today,
  );
  const suggested = turn(withChild, [
    {
      type: "setOccurrenceDone",
      mode: proposal,
      taskId: child.id,
      date: today,
      done: true,
    },
  ]);
  const changed = turn(suggested, [
    { type: "stopRecurrence", mode: direct, taskId: parent.id },
    { type: "resumeRecurrence", mode: direct, taskId: parent.id },
  ]);
  const plan = suggested.proposals.at(-1)!;
  assert.throws(
    () =>
      turn(changed, [
        {
          type: "resolve",
          mode: direct,
          proposalId: plan.id,
          cardIds: [plan.cards[0].id],
          accept: true,
        },
      ]),
    /任务已变化/,
  );
  assert.equal(
    changed.arrangements.find((item) => item.taskId === child.id)?.done,
    false,
  );
});

test("同一重复规则下移动祖先仍会使后代的当天方案过期", () => {
  const original = withDailyTask();
  const root = original.tasks[0];
  const section = { ...newTask(root.id), title: "检查动作" };
  const other = { ...newTask(root.id), title: "热身" };
  const child = { ...newTask(section.id), title: "伸展肩颈" };
  let state = original;
  for (const task of [section, other, child])
    state = applyCommand(state, { type: "saveTask", task }, today);
  const proposed = turn(state, [
    {
      type: "setOccurrenceDone",
      taskId: child.id,
      mode: proposal,
      date: today,
      done: true,
    },
  ]);
  const card = proposed.proposals.at(-1)!;
  const moved = applyCommand(
    proposed,
    {
      type: "saveTask",
      task: {
        ...proposed.tasks.find(({ id }) => id === section.id)!,
        parentId: other.id,
      },
    },
    today,
  );
  assert.throws(
    () =>
      turn(moved, [
        {
          type: "resolve",
          mode: direct,
          proposalId: card.id,
          cardIds: [card.cards[0].id],
          accept: true,
        },
      ]),
    /任务已变化/,
  );
});

test("父任务删除后，原子任务的完成建议无法再执行", () => {
  const original = withDailyTask();
  const taskId = original.tasks[0].id;
  const child = { ...newTask(taskId), title: "肩部活动" };
  const withChild = applyCommand(
    original,
    { type: "saveTask", task: child },
    today,
  );
  const suggested = turn(withChild, [
    {
      type: "deleteRecurringTask",
      mode: proposal,
      taskId,
      includeChildren: true,
    },
    {
      type: "setOccurrenceDone",
      mode: proposal,
      taskId: child.id,
      date: today,
      done: true,
    },
  ]);
  const plan = suggested.proposals.at(-1)!;
  const resolve = (index: number): AgentTurn["actions"][number] => ({
    type: "resolve",
    mode: direct,
    proposalId: plan.id,
    cardIds: [plan.cards[index].id],
    accept: true,
  });
  const deleted = turn(suggested, [resolve(0)]);
  assert.deepEqual(deleted.tasks, []);
  assert.deepEqual(deleted.arrangements, []);
  assert.equal(deleted.proposals.at(-1)?.cards[1].status, "pending");
  assert.throws(() => turn(deleted, [resolve(1)]), /任务已被删除/);
});

test("重复规则拒绝无法执行的字段，避免把有起始日的每天规则直接生效", () => {
  const state = emptyState();
  assert.throws(
    () =>
      applyAgentTurn(
        state,
        state.activeSessionId,
        "从明天开始每天拉伸",
        {
          text: "回复",
          actions: [
            {
              type: "createTask",
              mode: direct,
              title: "拉伸",
              patch: {},
              recurrence: { type: "daily", start: tomorrow },
            },
          ],
        },
        undefined,
        today,
      ),
    /Unrecognized key/,
  );
  assert.throws(
    () =>
      turn(state, [
        {
          type: "createTask",
          mode: direct,
          title: "拉伸",
          patch: { startDate: tomorrow },
          recurrence: { type: "daily" },
        },
      ]),
    /重复任务使用规则表达起止日期/,
  );
  assert.deepEqual(state.tasks, []);
});

test("方案转为重复模板后，旧预计日期变更无法写入", () => {
  const task = { ...newTask(), title: "写日记" };
  const state = applyCommand(emptyState(), { type: "saveTask", task }, today);
  const ruleAction = {
    type: "updateRecurrence",
    mode: proposal,
    taskId: task.id,
    recurrence: { type: "daily" },
  } satisfies AgentTurn["actions"][number];
  const suggested = turn(state, [
    ruleAction,
    {
      type: "updateTask",
      mode: proposal,
      taskId: task.id,
      patch: { expectedDate: tomorrow },
    },
  ]);
  const plan = suggested.proposals.at(-1)!;
  const accept: AgentTurn["actions"][number] = {
    type: "resolve",
    mode: direct,
    proposalId: plan.id,
    cardIds: [plan.cards[0].id],
    accept: true,
  };
  assert.throws(
    () => turn(suggested, [accept]),
    /重复任务使用规则表达起止日期/,
  );
  assert.equal(suggested.tasks[0].recurrence, undefined);
  const repeating = turn(state, [{ ...ruleAction, mode: direct }]);
  assert.throws(
    () =>
      turn(repeating, [
        {
          type: "updateTask",
          mode: direct,
          taskId: task.id,
          patch: { status: "waiting" },
        },
      ]),
    /重复任务按轮次记录完成/,
  );
  const startingLater = {
    type: "updateTask",
    mode: direct,
    taskId: task.id,
    patch: { startDate: tomorrow },
  } satisfies AgentTurn["actions"][number];
  assert.throws(
    () => turn(state, [startingLater, { ...ruleAction, mode: direct }]),
    /首轮早于预计开始日期/,
  );
  const weeklyFromTomorrow = turn(state, [
    startingLater,
    {
      ...ruleAction,
      mode: direct,
      recurrence: { type: "weekly", weekdays: [2] },
    },
  ]);
  assert.deepEqual(weeklyFromTomorrow.arrangements, []);
});

test("混合普通与重复操作在 SQLite 中整轮回滚，跨日提交也不会把规则错用到新日期", (t) => {
  let date = today;
  const db = new WorkspaceDatabase(":memory:", () => date);
  t.after(() => db.close());
  const original = db.load();
  const newTasks = [
    { type: "createTask", mode: direct, title: "整理文稿", patch: {} },
    {
      type: "createTask",
      mode: direct,
      title: "拉伸",
      patch: {},
      ref: "stretch",
      recurrence: { type: "daily" },
    },
  ] satisfies AgentTurn["actions"];
  assert.throws(
    () =>
      db.commitAgentTurn(
        original.revision,
        original.activeSessionId,
        "记任务",
        {
          text: "回复",
          actions: [
            ...newTasks,
            {
              type: "skipOccurrence",
              mode: direct,
              taskId: "stretch",
              date: tomorrow,
            },
          ],
        },
      ),
    /日期已变化/,
  );
  assert.deepEqual(db.load(), original);
  date = tomorrow;
  assert.throws(
    () =>
      db.commitAgentTurn(
        original.revision,
        original.activeSessionId,
        "记任务",
        {
          text: "回复",
          actions: newTasks,
        },
        undefined,
        today,
      ),
    /分析期间本地日期已变化/,
  );
  assert.deepEqual(db.load(), original);
});
