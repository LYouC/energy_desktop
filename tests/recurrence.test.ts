import { strict as assert } from "node:assert";
import { test } from "node:test";
import { emptyState, newTask } from "../src/domain/model";
import { applyCommand } from "../src/domain/operations";
import {
  nextRecurrenceDate,
  repeatTaskStatuses,
  synchronizeRecurrence,
} from "../src/domain/recurrence";

const monday = "2026-11-23";
const tuesday = "2026-11-24";
const wednesday = "2026-11-25";
const thursday = "2026-11-26";
const friday = "2026-11-27";

function repeatingTask(
  recurrence: NonNullable<ReturnType<typeof newTask>["recurrence"]>,
) {
  const task = { ...newTask(), title: "练琴", recurrence };
  let state = applyCommand(emptyState(), { type: "saveTask", task }, monday);
  let today = monday;
  return {
    task,
    get state() {
      return state;
    },
    get progress() {
      return repeatTaskStatuses(state, today).get(task.id)!;
    },
    at(date: string) {
      today = date;
      synchronizeRecurrence(state, today);
    },
    complete(date: string, done = true) {
      state = applyCommand(
        state,
        { type: "setOccurrenceDone", taskId: task.id, date, done },
        today,
      );
    },
    edit(recurrence: NonNullable<typeof task.recurrence>) {
      state = applyCommand(
        state,
        { type: "saveTask", task: { ...state.tasks[0], recurrence } },
        today,
      );
    },
    apply(command: Parameters<typeof applyCommand>[1]) {
      state = applyCommand(state, command, today);
    },
  };
}

test("只有最近错过的一轮逾期，补完成与撤销都不会在今日增加安排", () => {
  const repeat = repeatingTask({ type: "weekly", weekdays: [1, 4] });
  repeat.at(wednesday);
  assert.equal(repeat.progress.target, monday);
  assert.equal(repeat.progress.overdue, true);
  assert.equal(repeat.state.arrangements.length, 0);
  repeat.complete(monday);
  assert.deepEqual(repeat.state.repeatCompletions, [
    { taskId: repeat.task.id, date: monday, completedOn: wednesday },
  ]);
  assert.equal(repeat.progress.target, thursday);
  assert.equal(repeat.progress.overdue, false);
  assert.equal(repeat.state.arrangements.length, 0);
  repeat.complete(monday, false);
  assert.equal(repeat.progress.target, monday);
  assert.equal(repeat.progress.overdue, true);
  assert.equal(repeat.progress.completionCount, 0);
  repeat.at(thursday);
  assert.equal(repeat.progress.target, thursday);
  assert.equal(repeat.progress.overdue, false);
  assert.throws(() => repeat.complete(monday), /无法完成/);
  assert.deepEqual(
    repeat.state.arrangements.map(({ date }) => date),
    [thursday],
  );
});

test("第一轮到期才可勾选，完成后一直保持到下一轮到来", () => {
  const repeat = repeatingTask({ type: "weekly", weekdays: [2, 4] });
  assert.equal(repeat.progress.target, tuesday);
  assert.equal(repeat.progress.canComplete, false);
  assert.equal(repeat.progress.undo, null);
  assert.throws(() => repeat.complete(tuesday), /还没到应做日期/);
  repeat.at(tuesday);
  repeat.complete(tuesday);
  repeat.complete(tuesday);
  for (const date of [tuesday, wednesday]) {
    repeat.at(date);
    assert.equal(repeat.progress.target, thursday);
    assert.equal(repeat.progress.canComplete, false);
    assert.equal(repeat.progress.undo, tuesday);
    assert.equal(repeat.progress.completionCount, 1);
    assert.throws(() => repeat.complete(thursday), /还没到应做日期/);
  }
  repeat.at(thursday);
  assert.equal(repeat.progress.canComplete, true);
  assert.equal(repeat.progress.undo, null);
  assert.equal(repeat.state.arrangements[0].done, false);
  assert.throws(() => repeat.complete(tuesday, false), /无法撤销/);
});

test("最后一轮一直逾期，完成后结束，撤销回到最后一轮", () => {
  const repeat = repeatingTask({ type: "range", start: monday, end: tuesday });
  repeat.at(friday);
  assert.equal(repeat.progress.target, tuesday);
  assert.equal(repeat.progress.overdue, true);
  repeat.complete(tuesday);
  assert.equal(repeat.progress.target, null);
  assert.equal(repeat.progress.undo, tuesday);
  repeat.complete(tuesday, false);
  assert.equal(repeat.progress.target, tuesday);
  assert.equal(repeat.progress.overdue, true);
});

test("改规则立即投影今天，保留已完成记录且不补排过去", () => {
  const repeat = repeatingTask({ type: "daily" });
  repeat.complete(monday);
  repeat.edit({ type: "weekly", weekdays: [4] });
  assert.equal(repeat.state.arrangements.length, 0);
  assert.equal(repeat.progress.undo, null);
  assert.equal(repeat.progress.completionCount, 1);
  assert.throws(() => repeat.complete(monday, false), /无法撤销/);
  repeat.edit({ type: "daily" });
  assert.equal(repeat.state.arrangements[0].done, true);
  repeat.complete(monday, false);
  assert.equal(repeat.state.arrangements[0].done, false);
  repeat.edit({ type: "weekly", weekdays: [1, 5] });
  repeat.at(wednesday);
  assert.equal(repeat.progress.target, monday);
  repeat.edit({ type: "weekly", weekdays: [1, 4] });
  assert.equal(repeat.progress.overdue, true);
  repeat.edit({ type: "weekly", weekdays: [2, 5] });
  assert.equal(repeat.progress.target, friday);
  assert.equal(repeat.progress.overdue, false);
  assert.equal(repeat.state.arrangements.length, 0);
});

test("跳过不逾期，停止移除今日未完成整组，恢复当天即可继续", () => {
  const repeat = repeatingTask({ type: "weekly", weekdays: [1, 4] });
  const taskId = repeat.task.id;
  const child = { ...newTask(taskId), title: "热身" };
  repeat.apply({ type: "saveTask", task: child });
  repeat.apply({
    type: "setOccurrenceDone",
    taskId: child.id,
    date: monday,
    done: true,
  });
  assert.equal(repeat.progress.completionCount, 0);
  repeat.apply({ type: "skipOccurrence", taskId, date: monday });
  assert.equal(repeat.state.arrangements.length, 0);
  repeat.edit({ type: "weekly", weekdays: [1, 3, 4] });
  assert.equal(repeat.state.arrangements.length, 0);
  repeat.apply({ type: "restoreOccurrence", taskId, date: monday });
  assert.equal(
    repeat.state.arrangements.find((item) => item.taskId === child.id)?.done,
    true,
  );
  repeat.apply({ type: "skipOccurrence", taskId, date: monday });
  repeat.at(tuesday);
  assert.equal(repeat.progress.overdue, false);
  repeat.at(wednesday);
  repeat.apply({ type: "stopRecurrence", taskId });
  assert.equal(repeat.state.arrangements.length, 0);
  repeat.at(thursday);
  assert.equal(repeat.state.arrangements.length, 0);
  repeat.apply({ type: "resumeRecurrence", taskId });
  assert.equal(repeat.state.arrangements.length, 2);
  repeat.complete(thursday);
  repeat.apply({ type: "stopRecurrence", taskId });
  assert.equal(
    repeat.state.arrangements.find((item) => item.taskId === taskId)?.done,
    true,
  );
  assert.equal(repeat.progress.completionCount, 1);
  repeat.at(friday);
  assert.equal(repeat.state.arrangements.length, 0);
  repeat.apply({ type: "resumeRecurrence", taskId });
  assert.equal(repeat.progress.overdue, false);
  assert.equal(repeat.progress.completionCount, 1);
});

test("主任务完成覆盖当天仍有安排的后代，恢复父项保留子项结果", () => {
  const parent = {
    ...newTask(),
    title: "日常",
    recurrence: { type: "daily" as const },
  };
  const child = { ...newTask(parent.id), title: "读书" };
  const grandchild = { ...newTask(child.id), title: "摘录" };
  const skipped = { ...newTask(parent.id), title: "运动" };
  let state = emptyState();
  for (const task of [parent, child, grandchild, skipped])
    state = applyCommand(state, { type: "saveTask", task }, monday);
  state = applyCommand(
    state,
    { type: "skipOccurrence", taskId: skipped.id, date: monday },
    monday,
  );
  const templates = state.tasks;
  state = applyCommand(
    state,
    { type: "setOccurrenceDone", taskId: parent.id, date: monday, done: true },
    monday,
  );
  assert.deepEqual(
    state.arrangements.map(({ done }) => done),
    [true, true, true],
  );
  assert.equal(state.skippedOccurrences?.[0].arrangement.done, false);
  assert.deepEqual(state.tasks, templates);
  state = applyCommand(
    state,
    { type: "setOccurrenceDone", taskId: parent.id, date: monday, done: false },
    monday,
  );
  assert.deepEqual(
    state.arrangements.map(({ done }) => done),
    [false, true, true],
  );
  synchronizeRecurrence(state, "2026-11-24");
  assert.deepEqual(
    state.arrangements
      .filter(({ date }) => date === "2026-11-24")
      .map(({ done }) => done),
    [false, false, false, false],
  );
});

test("本轮完成后新增子任务直接完成，下轮恢复待做", () => {
  const repeat = repeatingTask({ type: "daily" });
  repeat.complete(monday);
  const child = { ...newTask(repeat.task.id), title: "新增子任务" };
  repeat.apply({ type: "saveTask", task: child });
  assert.equal(
    repeat.state.arrangements.find(({ taskId }) => taskId === child.id)?.done,
    true,
  );
  assert.equal(repeat.progress.completionCount, 1);
  assert.throws(
    () =>
      repeat.apply({
        type: "setOccurrenceDone",
        taskId: child.id,
        date: monday,
        done: false,
      }),
    /先撤销.*上级/,
  );
  repeat.apply({ type: "stopRecurrence", taskId: repeat.task.id });
  assert.deepEqual(
    repeat.state.arrangements.map(({ taskId, done }) => [taskId, done]),
    [
      [repeat.task.id, true],
      [child.id, true],
    ],
  );
  repeat.apply({ type: "resumeRecurrence", taskId: repeat.task.id });
  assert.deepEqual(
    repeat.state.arrangements.map(({ taskId, done }) => [taskId, done]),
    [
      [repeat.task.id, true],
      [child.id, true],
    ],
  );
  repeat.at(tuesday);
  assert.deepEqual(
    repeat.state.arrangements.map(({ done }) => done),
    [false, false],
  );
});

test("顶层任务归入父任务后随新父项排期，并保留此前的完成记录", () => {
  const repeat = repeatingTask({ type: "daily" });
  repeat.complete(monday);
  const parent = {
    ...newTask(),
    title: "每周计划",
    recurrence: { type: "weekly", weekdays: [1, 3] },
  } satisfies ReturnType<typeof newTask>;
  repeat.apply({
    type: "saveTask",
    task: parent,
  });
  const child = repeat.state.tasks.find(({ id }) => id === repeat.task.id)!;
  repeat.apply({
    type: "saveTask",
    task: { ...child, parentId: parent.id, recurrence: undefined },
  });
  assert.deepEqual(
    repeat.state.repeatSchedules.map(({ taskId }) => taskId),
    [parent.id],
  );
  assert.equal(
    repeat.state.arrangements.find(({ taskId }) => taskId === child.id)?.done,
    false,
  );
  assert.deepEqual(
    repeat.state.repeatCompletions.map(({ taskId }) => taskId),
    [child.id],
  );
  repeat.at(tuesday);
  assert.deepEqual(repeat.state.arrangements, []);
});

test("离开重复父任务后，父任务的整组跳过记录不再约束原子任务", () => {
  const repeat = repeatingTask({ type: "daily" });
  const child = { ...newTask(repeat.task.id), title: "读书" };
  repeat.apply({ type: "saveTask", task: child });
  repeat.apply({
    type: "skipOccurrence",
    taskId: repeat.task.id,
    date: monday,
  });
  repeat.apply({
    type: "saveTask",
    task: { ...repeat.state.tasks[1], parentId: null },
  });
  assert.deepEqual(
    repeat.state.skippedOccurrences.map(
      ({ arrangement }) => arrangement.taskId,
    ),
    [repeat.task.id],
  );
  repeat.apply({ type: "scheduleToday", taskId: child.id, date: monday });
  assert.deepEqual(
    repeat.state.arrangements.map(({ taskId }) => taskId),
    [child.id],
  );
});

test("移动子任务后今日安排同步名称与归属", () => {
  const first = {
    ...newTask(),
    title: "旧父任务",
    recurrence: { type: "daily" as const },
  };
  const second = {
    ...newTask(),
    title: "新父任务",
    recurrence: { type: "daily" as const },
  };
  const child = { ...newTask(first.id), title: "原名称" };
  let state = emptyState();
  for (const task of [first, second, child])
    state = applyCommand(state, { type: "saveTask", task }, monday);
  state = applyCommand(
    state,
    {
      type: "saveTask",
      task: { ...state.tasks[2], parentId: second.id, title: "新名称" },
    },
    monday,
  );
  const renamed = state.arrangements.find((item) => item.taskId === child.id)!;
  assert.equal(renamed.scope, "新名称");
  assert.equal(
    state.tasks.find(({ id }) => id === child.id)?.parentId,
    second.id,
  );
  assert.deepEqual(renamed.recurrence, { version: 1 });
  state = applyCommand(
    state,
    { type: "setOccurrenceDone", taskId: first.id, date: monday, done: true },
    monday,
  );
  assert.equal(
    state.arrangements.find((item) => item.taskId === child.id)?.done,
    false,
  );
  const tomorrow = "2026-11-24";
  synchronizeRecurrence(state, tomorrow);
  assert.deepEqual(
    state.arrangements.find(
      (item) => item.taskId === child.id && item.date === tomorrow,
    )?.recurrence,
    { version: 0 },
  );
});

test("新建每日重复任务时，今天一轮排在已有安排后并独立完成", () => {
  const ordinary = { ...newTask(), title: "整理会议纪要" };
  const english = {
    ...newTask(),
    title: "练英语",
    recurrence: { type: "daily" as const },
  };
  let state = applyCommand(
    emptyState(),
    { type: "saveTask", task: ordinary },
    monday,
  );
  state = applyCommand(
    state,
    {
      type: "schedule",
      taskId: ordinary.id,
      date: monday,
      scope: "明确待办",
    },
    monday,
  );
  state = applyCommand(state, { type: "saveTask", task: english }, monday);
  assert.deepEqual(
    state.arrangements.map((item) => item.taskId),
    [ordinary.id, english.id],
  );
  assert.deepEqual(state.arrangements[1].recurrence, {
    version: 0,
  });
  state = applyCommand(
    state,
    { type: "setOccurrenceDone", taskId: english.id, date: monday, done: true },
    monday,
  );
  assert.equal(state.arrangements[1].done, true);
  assert.equal(state.tasks[1].status, "todo");
  assert.equal(state.tasks[1].version, 1);
});

test("每周错过的轮次不补排，完结的轮次只留完成记录", () => {
  const task = { ...newTask(), title: "练英语" };
  const other = { ...newTask(), title: "整理会议纪要" };
  let state = applyCommand(emptyState(), { type: "saveTask", task }, monday);
  state = applyCommand(
    state,
    { type: "schedule", taskId: task.id, date: monday, scope: "五分钟跟读" },
    monday,
  );
  state = applyCommand(state, { type: "saveTask", task: other }, monday);
  state = applyCommand(
    state,
    {
      type: "schedule",
      taskId: other.id,
      date: monday,
      scope: "记录会议行动",
    },
    monday,
  );
  state = applyCommand(
    state,
    {
      type: "saveTask",
      task: {
        ...state.tasks[0],
        recurrence: { type: "weekly", weekdays: [5, 1, 3] },
      },
    },
    monday,
  );
  state = applyCommand(
    state,
    { type: "setOccurrenceDone", taskId: task.id, date: monday, done: true },
    monday,
  );
  assert.deepEqual(
    state.arrangements.map((item) => [item.date, item.scope, item.done]),
    [
      [monday, task.title, true],
      [monday, "记录会议行动", false],
    ],
  );
  const version = state.tasks[0].version;
  const friday = "2026-11-27";
  assert.equal(synchronizeRecurrence(state, friday), true);
  assert.equal(synchronizeRecurrence(state, friday), false);
  assert.deepEqual(
    state.arrangements
      .filter((item) => item.recurrence)
      .map((item) => [item.date, item.done]),
    [[friday, false]],
  );
  assert.equal(state.tasks[0].version, version);
  assert.deepEqual(state.repeatCompletions, [
    { taskId: task.id, date: monday, completedOn: monday },
  ]);
});

test("指定日期含首尾，编辑过期规则当天立即生效", () => {
  const task = { ...newTask(), title: "散步" };
  const range = {
    type: "range" as const,
    start: "2026-11-27",
    end: "2026-11-30",
  };
  assert.equal(nextRecurrenceDate(range, monday), "2026-11-27");
  assert.equal(nextRecurrenceDate(range, "2026-12-01"), null);
  assert.equal(
    nextRecurrenceDate({ type: "weekly", weekdays: [0] }, "2026-11-30"),
    "2026-12-06",
  );
  assert.throws(
    () =>
      applyCommand(
        emptyState(),
        {
          type: "saveTask",
          task: { ...task, recurrence: { ...range, start: "2026-11-22" } },
        },
        monday,
      ),
    /早于今天/,
  );
  let state = applyCommand(
    emptyState(),
    { type: "saveTask", task: { ...task, recurrence: range } },
    monday,
  );
  assert.deepEqual(state.arrangements, []);
  state = applyCommand(
    state,
    {
      type: "saveTask",
      task: { ...state.tasks[0], title: "快走", recurrence: { type: "daily" } },
    },
    "2026-12-02",
  );
  assert.deepEqual(
    state.arrangements.map((item) => [item.date, item.scope]),
    [["2026-12-02", "快走"]],
  );
  synchronizeRecurrence(state, "2026-12-03");
  assert.deepEqual(state.arrangements.at(-1), {
    taskId: task.id,
    date: "2026-12-03",
    recurrence: { version: 0 },
    scope: "快走",
    done: false,
  });
});

test("从今天移除会在当天保存选择，批量撤销能恢复原位置与范围", () => {
  const tasks = ["练英语", "跑步", "读书"].map((title) => ({
    ...newTask(),
    title,
    recurrence: { type: "daily" as const },
  }));
  let state = emptyState();
  for (const task of tasks)
    state = applyCommand(state, { type: "saveTask", task }, monday);
  const visibleArrangements = (items: typeof state.arrangements) =>
    items.map(({ recurrence, ...item }) => ({
      ...item,
      recurrence: Boolean(recurrence),
    }));
  const before = visibleArrangements(state.arrangements);
  for (const task of tasks.slice(0, 2)) {
    state = applyCommand(
      state,
      { type: "skipOccurrence", taskId: task.id, date: monday },
      monday,
    );
  }
  assert.equal(synchronizeRecurrence(state, monday), false);
  assert.deepEqual(
    state.arrangements.map((item) => item.taskId),
    [tasks[2].id],
  );

  for (const task of tasks.slice(0, 2)) {
    state = applyCommand(
      state,
      { type: "restoreOccurrence", taskId: task.id, date: monday },
      monday,
    );
  }
  assert.deepEqual(visibleArrangements(state.arrangements), before);

  const reverse = state.tasks.slice(0, 2).reverse();
  for (const task of reverse) {
    state = applyCommand(
      state,
      { type: "skipOccurrence", taskId: task.id, date: monday },
      monday,
    );
  }
  for (const task of reverse) {
    state = applyCommand(
      state,
      { type: "restoreOccurrence", taskId: task.id, date: monday },
      monday,
    );
  }
  assert.deepEqual(visibleArrangements(state.arrangements), before);

  state = applyCommand(
    state,
    { type: "skipOccurrence", taskId: tasks[0].id, date: monday },
    monday,
  );
  synchronizeRecurrence(state, "2026-11-24");
  assert.deepEqual(
    state.arrangements
      .filter((item) => item.taskId === tasks[0].id)
      .map((item) => item.date),
    ["2026-11-24"],
  );
  assert.throws(
    () =>
      applyCommand(
        state,
        { type: "restoreOccurrence", taskId: tasks[0].id, date: monday },
        "2026-11-24",
      ),
    /当天/,
  );
});

test("撤销移除时，前一个事项已移除仍能回到后一个事项之前", () => {
  const first = { ...newTask(), title: "准备材料" };
  const repeat = {
    ...newTask(),
    title: "练英语",
    recurrence: { type: "daily" as const },
  };
  const last = { ...newTask(), title: "整理材料" };
  let state = applyCommand(
    emptyState(),
    { type: "saveTask", task: first },
    monday,
  );
  state = applyCommand(
    state,
    {
      type: "schedule",
      taskId: first.id,
      date: monday,
      scope: first.title,
    },
    monday,
  );
  state = applyCommand(state, { type: "saveTask", task: repeat }, monday);
  state = applyCommand(state, { type: "saveTask", task: last }, monday);
  state = applyCommand(
    state,
    {
      type: "schedule",
      taskId: last.id,
      date: monday,
      scope: last.title,
    },
    monday,
  );
  state = applyCommand(
    state,
    { type: "skipOccurrence", taskId: repeat.id, date: monday },
    monday,
  );
  state = applyCommand(
    state,
    { type: "unschedule", taskId: first.id, date: monday },
    monday,
  );
  state = applyCommand(
    state,
    { type: "restoreOccurrence", taskId: repeat.id, date: monday },
    monday,
  );
  assert.deepEqual(
    state.arrangements.map((item) => item.taskId),
    [repeat.id, last.id],
  );
});

test("删除重复父任务会清理整组安排及轮次记录", () => {
  const parent = {
    ...newTask(),
    title: "学习规划",
    recurrence: { type: "daily" as const },
  };
  const child = { ...newTask(parent.id), title: "练英语" };
  const other = { ...newTask(), title: "整理会议纪要" };
  const today = "2026-11-25";
  let state = applyCommand(
    emptyState(),
    { type: "saveTask", task: parent },
    monday,
  );
  state = applyCommand(state, { type: "saveTask", task: child }, monday);
  state = applyCommand(state, { type: "saveTask", task: other }, today);
  state = applyCommand(
    state,
    { type: "schedule", taskId: other.id, date: today, scope: "核对待办" },
    today,
  );
  state = applyCommand(
    state,
    { type: "setOccurrenceDone", taskId: parent.id, date: today, done: true },
    today,
  );
  assert.equal(state.repeatCompletions.length, 1);
  const stale = state.tasks.find((task) => task.id === child.id)!;
  state = applyCommand(state, { type: "deleteTask", id: parent.id }, today);
  assert.deepEqual(
    state.tasks.map((task) => task.id),
    [other.id],
  );
  assert.throws(
    () =>
      applyCommand(
        state,
        { type: "saveTask", task: { ...stale, parentId: null } },
        today,
      ),
    /任务已被删除/,
  );
  assert.deepEqual(
    state.arrangements.map((item) => item.taskId),
    [other.id],
  );
  assert.deepEqual(state.repeatCompletions, []);
  assert.deepEqual(state.repeatSchedules, []);
  assert.equal(synchronizeRecurrence(state, "2026-11-26"), false);
});
