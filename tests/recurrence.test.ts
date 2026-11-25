import { strict as assert } from "node:assert";
import { test } from "node:test";
import { emptyState, newTask } from "../src/domain/model";
import { applyCommand } from "../src/domain/operations";
import {
  nextRecurrenceDate,
  synchronizeRecurrence,
} from "../src/domain/recurrence";

const monday = "2026-11-23";

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
    { type: "stage", taskId: parent.id, date: monday, done: true },
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
    { type: "stage", taskId: parent.id, date: monday, done: false },
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

test("旧数据在模板重挂之前补齐当天快照，次日才按新归属生成", () => {
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
  const instance = state.arrangements.find((item) => item.taskId === child.id)!;
  instance.recurrence = { title: "原名称" };
  state = applyCommand(
    state,
    {
      type: "saveTask",
      task: { ...state.tasks[2], parentId: second.id, title: "新名称" },
    },
    monday,
  );
  const snapshot = state.arrangements.find((item) => item.taskId === child.id)!;
  assert.deepEqual(snapshot.recurrence, {
    title: "原名称",
    ancestorIds: [first.id],
  });
  state = applyCommand(
    state,
    { type: "stage", taskId: first.id, date: monday, done: true },
    monday,
  );
  assert.equal(
    state.arrangements.find((item) => item.taskId === child.id)?.done,
    true,
  );
  const tomorrow = "2026-11-24";
  synchronizeRecurrence(state, tomorrow);
  assert.deepEqual(
    state.arrangements.find(
      (item) => item.taskId === child.id && item.date === tomorrow,
    )?.recurrence,
    { title: "新名称", ancestorIds: [second.id] },
  );
});

test("新建每日模板时，今天实例排在已有安排后并独立完成", () => {
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
    title: "练英语",
    ancestorIds: [],
  });
  state = applyCommand(
    state,
    { type: "stage", taskId: english.id, date: monday, done: true },
    monday,
  );
  assert.equal(state.arrangements[1].done, true);
  assert.equal(state.tasks[1].status, "todo");
  assert.equal(state.tasks[1].version, 1);
});

test("每周后续未打开仍按星期补齐；已有安排原地保留完成情况和范围", () => {
  const task = { ...newTask(), title: "练英语" };
  const other = { ...newTask(), title: "整理会议纪要" };
  let state = applyCommand(emptyState(), { type: "saveTask", task }, monday);
  state = applyCommand(
    state,
    { type: "schedule", taskId: task.id, date: monday, scope: "五分钟跟读" },
    monday,
  );
  state = applyCommand(
    state,
    { type: "stage", taskId: task.id, date: monday, done: true },
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
  assert.deepEqual(
    state.arrangements.map((item) => [item.date, item.scope, item.done]),
    [
      [monday, "五分钟跟读", true],
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
    [
      [monday, true],
      ["2026-11-25", false],
      [friday, false],
    ],
  );
  assert.equal(state.tasks[0].version, version);
});

test("指定日期含首尾，编辑过期规则从次日执行，旧实例快照保持原样", () => {
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
    state.arrangements.map((item) => [item.date, item.recurrence?.title]),
    [
      ["2026-11-27", "散步"],
      ["2026-11-28", "散步"],
      ["2026-11-29", "散步"],
      ["2026-11-30", "散步"],
    ],
  );
  synchronizeRecurrence(state, "2026-12-03");
  assert.deepEqual(state.arrangements.at(-1), {
    taskId: task.id,
    date: "2026-12-03",
    recurrence: { title: "快走", ancestorIds: [] },
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
  state = applyCommand(
    state,
    {
      type: "updateOccurrenceScope",
      taskId: tasks[0].id,
      date: monday,
      scope: "跟读五分钟",
    },
    monday,
  );
  const visibleArrangements = (items: typeof state.arrangements) =>
    items.map(({ occurrenceVersion, ...item }) => item);
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

test("删除父任务停止重复子任务，历史和今天已生成的实例仍可处理", () => {
  const parent = { ...newTask(), title: "学习规划" };
  const child = {
    ...newTask(parent.id),
    title: "练英语",
    recurrence: { type: "daily" as const },
  };
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
    state.arrangements
      .filter((item) => item.taskId === child.id)
      .map((item) => item.date),
    [monday, "2026-11-24", today],
  );
  state = applyCommand(
    state,
    { type: "move", taskId: child.id, targetTaskId: other.id, date: today },
    today,
  );
  assert.deepEqual(
    state.arrangements
      .filter((item) => item.date === today)
      .map((item) => item.taskId),
    [other.id, child.id],
  );
  state = applyCommand(
    state,
    { type: "skipOccurrence", taskId: child.id, date: today },
    today,
  );
  state = applyCommand(
    state,
    { type: "restoreOccurrence", taskId: child.id, date: today },
    today,
  );
  state = applyCommand(
    state,
    { type: "stage", taskId: child.id, date: today, done: true },
    today,
  );
  state = applyCommand(
    state,
    {
      type: "updateOccurrenceScope",
      taskId: child.id,
      date: today,
      scope: "跟读五分钟",
    },
    today,
  );
  assert.deepEqual(state.arrangements.at(-1), {
    taskId: child.id,
    date: today,
    recurrence: { title: "练英语", ancestorIds: [parent.id] },
    occurrenceVersion: 5,
    scope: "跟读五分钟",
    done: true,
  });
  assert.equal(synchronizeRecurrence(state, "2026-11-26"), false);
});
