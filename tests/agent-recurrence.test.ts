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

test("Agent 可创建每天、每周和含首尾的日期范围任务，同轮调整当次范围", () => {
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
      type: "updateOccurrenceScope",
      mode: direct,
      taskId: "stretch",
      date: today,
      scope: "拉伸五分钟",
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
  const later = turn(state, [], "2026-11-26");
  assert.deepEqual(
    later.arrangements
      .filter((item) => item.taskId === range.id)
      .map((item) => item.date),
    [tomorrow, "2026-11-25"],
  );
  assert.deepEqual(
    later.arrangements
      .filter((item) => item.taskId === weekly.id)
      .map((item) => item.date),
    [today, "2026-11-25"],
  );
});

test("现有普通任务首次设重复复用同日安排，改规则时今日实例保持不变", () => {
  const task = { ...newTask(), title: "练琴" };
  const state = applyCommand(
    emptyState(),
    {
      type: "saveTask",
      task,
      arrangement: { date: today, scope: "练第一段" },
    },
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
  assert.deepEqual(weekly.arrangements, [
    {
      taskId,
      date: today,
      scope: "练第一段",
      done: true,
      recurrence: { title: "练琴" },
    },
  ]);
  assert.equal(weekly.tasks[0].status, "todo");
  assert.deepEqual(
    turn(weekly, [], "2026-11-25").arrangements.map((item) => item.date),
    [today, "2026-11-25"],
  );
});

test("删除模板保留历史及今天实例，且仍可调整、完成、移除和恢复", () => {
  const original = withDailyTask();
  const taskId = original.tasks[0].id;
  const state = turn(
    original,
    [
      { type: "deleteRecurringTask", mode: direct, taskId },
      {
        type: "updateOccurrenceScope",
        mode: direct,
        taskId,
        date: tomorrow,
        scope: "拉伸肩颈",
      },
      {
        type: "setOccurrenceDone",
        mode: direct,
        taskId,
        date: tomorrow,
        done: true,
      },
    ],
    tomorrow,
  );
  assert.deepEqual(state.tasks, []);
  assert.deepEqual(
    state.arrangements.map((item) => [item.date, item.scope, item.done]),
    [
      [today, "拉伸", false],
      [tomorrow, "拉伸肩颈", true],
    ],
  );
  const skipped = turn(
    state,
    [
      {
        type: "setOccurrenceDone",
        mode: direct,
        taskId,
        date: tomorrow,
        done: false,
      },
      { type: "skipOccurrence", mode: direct, taskId, date: tomorrow },
    ],
    tomorrow,
  );
  assert.deepEqual(
    skipped.arrangements.map((item) => item.date),
    [today],
  );
  const proposed = turn(
    skipped,
    [{ type: "restoreOccurrence", mode: proposal, taskId, date: tomorrow }],
    tomorrow,
  );
  assert.deepEqual(proposed.arrangements, skipped.arrangements);
  const plan = proposed.proposals.at(-1)!;
  const restored = turn(
    proposed,
    [
      {
        type: "resolve",
        mode: direct,
        proposalId: plan.id,
        ids: [plan.changes[0].id],
        accept: true,
      },
    ],
    tomorrow,
  );
  assert.deepEqual(restored.skippedOccurrences, []);
  assert.equal(restored.arrangements.at(-1)?.scope, "拉伸肩颈");
  assert.deepEqual(
    turn(restored, [], "2026-11-25").arrangements.map((item) => item.date),
    [today, tomorrow],
  );
});

test("待接受方案可部分接受，过期或同日手动变更后旧实例方案不生效", () => {
  const original = withDailyTask();
  const taskId = original.tasks[0].id;
  const suggested = turn(original, [
    {
      type: "updateRecurrence",
      mode: proposal,
      taskId,
      recurrence: { type: "weekly", weekdays: [5] },
    },
    { type: "skipOccurrence", mode: proposal, taskId, date: today },
  ]);
  assert.deepEqual(suggested.tasks, original.tasks);
  assert.deepEqual(suggested.arrangements, original.arrangements);
  const plan = suggested.proposals.at(-1)!;
  const [changeRule, skip] = plan.changes;
  const accepted = turn(suggested, [
    {
      type: "resolve",
      mode: direct,
      proposalId: plan.id,
      ids: [changeRule.id],
      accept: true,
    },
  ]);
  assert.deepEqual(accepted.tasks[0].recurrence, {
    type: "weekly",
    weekdays: [5],
  });
  assert.equal(accepted.arrangements.length, 1);
  const acceptSkip = {
    type: "resolve" as const,
    mode: direct,
    proposalId: plan.id,
    ids: [skip.id],
    accept: true,
  };
  assert.throws(() => turn(accepted, [acceptSkip], tomorrow), /日期已变化/);
  const edited = applyCommand(
    accepted,
    {
      type: "updateOccurrenceScope",
      taskId,
      date: today,
      scope: "拉伸十分钟",
    },
    today,
  );
  assert.throws(() => turn(edited, [acceptSkip]), /任务已变化/);
  assert.equal(edited.proposals.at(-1)?.changes[1].status, "pending");
  assert.equal(edited.arrangements[0].scope, "拉伸十分钟");
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
      ids: [plan.changes[0].id],
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
  assert.equal(deleted.arrangements.length, 1);
});

test("只接受模板删除时，当天实例建议仍待接受并可单独执行", () => {
  const original = withDailyTask();
  const taskId = original.tasks[0].id;
  const child = {
    ...newTask(taskId),
    title: "肩部活动",
    recurrence: { type: "daily" as const },
  };
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
      type: "updateOccurrenceScope",
      mode: proposal,
      taskId,
      date: today,
      scope: "拉伸十分钟",
    },
    {
      type: "updateOccurrenceScope",
      mode: proposal,
      taskId: child.id,
      date: today,
      scope: "肩部活动三分钟",
    },
  ]);
  const plan = suggested.proposals.at(-1)!;
  const resolve = (index: number): AgentTurn["actions"][number] => ({
    type: "resolve",
    mode: direct,
    proposalId: plan.id,
    ids: [plan.changes[index].id],
    accept: true,
  });
  const deleted = turn(suggested, [resolve(0)]);
  assert.deepEqual(deleted.tasks, []);
  assert.equal(deleted.arrangements[0].scope, "拉伸");
  assert.deepEqual(
    deleted.proposals.at(-1)?.changes.map((change) => change.status),
    ["accepted", "pending", "pending"],
  );
  const updated = turn(deleted, [resolve(1)]);
  assert.equal(updated.arrangements[0].scope, "拉伸十分钟");
  assert.equal(
    turn(updated, [resolve(2)]).arrangements[1].scope,
    "肩部活动三分钟",
  );

  const manuallyDeleted = applyCommand(
    suggested,
    { type: "deleteTask", id: taskId },
    today,
  );
  assert.equal(manuallyDeleted.proposals.at(-1)?.changes[1].status, "pending");
  assert.throws(() => turn(manuallyDeleted, [resolve(1)]), /任务已变化/);
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
  const accept = (ids: string[]): AgentTurn["actions"][number] => ({
    type: "resolve",
    mode: direct,
    proposalId: plan.id,
    ids,
    accept: true,
  });
  const [rule, date] = plan.changes;
  assert.throws(
    () => turn(suggested, [accept([rule.id, date.id])]),
    /重复任务使用规则表达起止日期/,
  );
  assert.equal(suggested.tasks[0].recurrence, undefined);
  const repeating = turn(suggested, [accept([rule.id])]);
  assert.throws(
    () => turn(repeating, [accept([date.id])]),
    /重复任务使用规则表达起止日期/,
  );
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
    /重复模板不设置整体状态/,
  );
  const startingLater = {
    type: "updateTask",
    mode: direct,
    taskId: task.id,
    patch: { startDate: tomorrow },
  } satisfies AgentTurn["actions"][number];
  assert.throws(
    () => turn(state, [startingLater, { ...ruleAction, mode: direct }]),
    /规则会在预计开始日期前生成实例/,
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
