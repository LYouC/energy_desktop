import { _electron as electron, expect } from "@playwright/test";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const dataDir = await mkdtemp(path.join(tmpdir(), "xixu-task-fields-"));
await mkdir("test-results", { recursive: true });
const errors = [];
async function launch() {
  const app = await electron.launch({
    args: ["."],
    env: { ...process.env, XIXU_DATA_DIR: dataDir },
  });
  const page = await app.firstWindow();
  page.on("pageerror", (error) => errors.push(error.message));
  await expect(
    page.getByRole("heading", { name: "今天，留一点余地。" }),
  ).toBeVisible();
  return { app, page };
}
let { app, page } = await launch();
try {
  await page
    .getByRole("button", { name: "记下一件事", exact: true })
    .first()
    .click();
  let dialog = page.getByRole("dialog");
  await expect(dialog.locator("input[required]")).toHaveCount(1);
  await expect(dialog.getByText("前置依赖", { exact: true })).toHaveCount(0);
  await expect(
    dialog
      .getByRole("combobox", { name: "重要性", exact: true })
      .locator("option:checked"),
  ).toHaveText("未设置");
  await expect(dialog.getByText("真实截止", { exact: true })).toHaveCount(0);
  await dialog.getByLabel("任务名称").fill("买洗衣液");
  await dialog.getByRole("button", { name: "保存任务", exact: true }).click();
  await page.getByRole("button", { name: /所有任务/ }).click();
  await page.locator(".task-list-row").filter({ hasText: "买洗衣液" }).click();
  await dialog.getByLabel("预计开始日期").fill("2026-11-17");
  await dialog.getByLabel("预计完成日期").fill("2026-11-16");
  await dialog.getByRole("button", { name: "保存任务", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("不能早于");
  await dialog.getByLabel("预计完成日期").fill("2026-11-20");
  await dialog
    .getByRole("combobox", { name: "重要性", exact: true })
    .selectOption("high");
  await dialog
    .getByLabel("说明", { exact: true })
    .fill("购买一瓶\n周五之前必须买到");
  await dialog.getByRole("button", { name: "添加子任务", exact: true }).click();
  await expect(dialog.getByLabel("所属任务")).not.toHaveValue("");
  await dialog.getByLabel("任务名称").fill("选择规格");
  await dialog.getByLabel("预计开始日期").fill("2026-11-18");
  await dialog.getByLabel("预计完成日期").fill("2026-11-19");
  await dialog.getByLabel("说明", { exact: true }).fill("查看容量和香型");
  await page.screenshot({ path: "test-results/task-fields-light.png" });
  await dialog.getByRole("button", { name: "保存任务", exact: true }).click();
  let state = await page.evaluate(() => window.desktop.load());
  expect(state.tasks).toHaveLength(2);
  const parent = state.tasks.find((task) => task.title === "买洗衣液");
  const child = state.tasks.find((task) => task.title === "选择规格");
  expect(child.parentId).toBe(parent.id);
  expect(parent.importance).toBe("high");
  expect(child.importance).toBeNull();
  expect(Object.keys(parent).sort()).toEqual(Object.keys(child).sort());
  const rows = page.locator(".task-list-row");
  const parentRow = rows.filter({ hasText: "买洗衣液" });
  await expect(
    page.getByRole("button", { name: "安排到今天：买洗衣液" }),
  ).toBeVisible();
  await expect(page.locator(".task-list-item").nth(1)).toHaveClass(/is-nested/);
  const importanceFilter = page.getByLabel("按重要性筛选");
  await expect(importanceFilter).toHaveValue("all");
  await expect(parentRow).toContainText("重要性 · 高");
  await importanceFilter.selectOption("high");
  await expect(rows).toHaveCount(1);
  const search = page.getByLabel("搜索任务");
  await search.fill("选择");
  await expect(page.getByText("没有匹配的任务。")).toBeVisible();
  await search.clear();
  await page.getByRole("button", { name: "管理", exact: true }).click();
  await expect(page.getByRole("button", { name: /^安排到今天/ })).toHaveCount(
    0,
  );
  await page.getByRole("button", { name: "全选", exact: true }).click();
  await expect(parentRow).toHaveAttribute("aria-pressed", "true");
  await importanceFilter.selectOption({ label: "未设置重要性" });
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("选择规格");
  await expect(rows.first()).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByRole("button", { name: "删除选中" })).toBeDisabled();
  await importanceFilter.selectOption("all");
  await expect(rows).toHaveCount(2);
  await expect(parentRow).toHaveAttribute("aria-pressed", "false");
  await page.getByRole("button", { name: "完成", exact: true }).click();
  await parentRow.click();
  await expect(dialog.getByLabel("所属任务").locator("option")).toHaveCount(1);
  await expect(dialog.getByText("安排一次推进", { exact: true })).toHaveCount(
    0,
  );
  await expect(dialog.getByLabel("推进日期")).toHaveCount(0);
  await expect(dialog.getByLabel("本次阶段目标")).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: "保存并安排", exact: true }),
  ).toHaveCount(0);
  await dialog.getByRole("button", { name: "保存任务", exact: true }).click();
  state = await page.evaluate(() => window.desktop.load());
  expect(state.tasks.find((task) => task.id === parent.id).startDate).toBe(
    "2026-11-17",
  );
  expect(state.arrangements).toHaveLength(0);
  expect(state.messages).toHaveLength(0);
  await app.close();
  ({ app, page } = await launch());
  await page.getByRole("button", { name: /所有任务/ }).click();
  await expect(
    page.locator(".task-list-row").filter({ hasText: "买洗衣液" }),
  ).toContainText("重要性 · 高");
  await page.locator(".task-list-row").filter({ hasText: "选择规格" }).click();
  dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("预计开始日期")).toHaveValue("2026-11-18");
  await expect(dialog.getByLabel("说明", { exact: true })).toHaveValue(
    "查看容量和香型",
  );
  await dialog.getByLabel("任务状态").selectOption("done");
  await dialog.getByRole("button", { name: "保存任务", exact: true }).click();
  state = await page.evaluate(() => window.desktop.load());
  expect(state.tasks.find((task) => task.id === parent.id).status).toBe("todo");
  const completionFilter = page.getByLabel("按完成状态筛选");
  const typeFilter = page.getByLabel("按任务类型筛选");
  const listRows = page.locator(".task-list-row");
  const listParent = listRows.filter({ hasText: "买洗衣液" });
  const listChild = listRows.filter({ hasText: "选择规格" });
  const listCount = page.locator(".list-heading");
  const listSearch = page.getByLabel("搜索任务");
  async function saveTaskStatus(row, status) {
    await row.click();
    await dialog.getByLabel("任务状态").selectOption(status);
    await dialog.getByRole("button", { name: "保存任务", exact: true }).click();
  }
  await expect(completionFilter.locator("option")).toHaveText([
    "全部状态",
    "已完成",
    "未完成",
  ]);
  await expect(completionFilter).toHaveValue("all");
  await expect(listCount).toContainText("2 项");
  await completionFilter.selectOption("done");
  await expect(listCount).toContainText("0 项");
  await expect(page.getByText("没有匹配的任务。")).toBeVisible();
  await completionFilter.selectOption("incomplete");
  await expect(listCount).toContainText("2 项");
  await expect(page.locator(".task-list-item.is-nested")).toContainText(
    "选择规格",
  );

  await typeFilter.selectOption("single");
  await page.getByLabel("按重要性筛选").selectOption("high");
  await listSearch.fill("洗衣液");
  await expect(listCount).toContainText("1 项");
  await expect(listRows).toContainText(["买洗衣液"]);
  await typeFilter.selectOption("repeated");
  await expect(listCount).toContainText("0 项");
  await typeFilter.selectOption("all");
  await page.getByLabel("按重要性筛选").selectOption("all");
  await listSearch.fill("选择规格");
  await expect(listChild).toBeVisible();
  await completionFilter.selectOption("done");
  await expect(listChild).toHaveCount(0);
  await completionFilter.selectOption("all");
  await listSearch.clear();

  await saveTaskStatus(listParent, "done");
  await listChild.click();
  await expect(dialog.getByLabel("任务状态")).toHaveValue("done");
  await expect(dialog.getByLabel("任务状态")).toBeDisabled();
  await page.keyboard.press("Escape");
  await completionFilter.selectOption("done");
  await expect(listCount).toContainText("2 项");
  await expect(page.locator(".task-list-item.is-nested")).toContainText(
    "选择规格",
  );
  await page.getByRole("button", { name: "管理", exact: true }).click();
  await page.getByRole("button", { name: "全选", exact: true }).click();
  await expect(listParent).toHaveAttribute("aria-pressed", "true");
  await expect(listChild).toHaveAttribute("aria-pressed", "true");
  await completionFilter.selectOption("incomplete");
  await expect(listRows).toHaveCount(0);
  await expect(page.getByRole("button", { name: "删除选中" })).toBeDisabled();
  await completionFilter.selectOption("all");
  await expect(listParent).toHaveAttribute("aria-pressed", "false");
  await page.getByRole("button", { name: "完成", exact: true }).click();
  await saveTaskStatus(listParent, "todo");
  await saveTaskStatus(listChild, "done");

  await page.getByRole("button", { name: "我的空间 本地保存" }).click();
  await page.getByLabel("主题").selectOption("dark");
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await expect(page.getByLabel("按重要性筛选")).toBeVisible();
  await expect(completionFilter).toBeVisible();
  await expect(page.locator(".task-importance")).toBeVisible();
  await page.locator(".task-list-row").filter({ hasText: "买洗衣液" }).click();
  await page.screenshot({ path: "test-results/task-fields-dark.png" });
  await page.setViewportSize({ width: 800, height: 900 });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(800);
  await page.screenshot({ path: "test-results/task-fields-narrow.png" });
  await page.keyboard.press("Escape");
  await expect(completionFilter).toBeInViewport({ ratio: 1 });
  await page.getByRole("button", { name: "添加任务", exact: true }).click();
  const today = await page.evaluate(() =>
    new Date().toLocaleDateString("sv-SE"),
  );
  await dialog.getByLabel("任务名称").fill("吃牛奶");
  await dialog.getByLabel("预计完成日期").fill(today);
  await dialog.getByRole("button", { name: "保存任务", exact: true }).click();
  const beforePlan = await page.evaluate(() => window.desktop.load());
  const dueTask = beforePlan.tasks.find((task) => task.title === "吃牛奶");
  expect(
    beforePlan.arrangements.some((item) => item.taskId === dueTask.id),
  ).toBe(false);
  await page.getByRole("button", { name: /今日安排/ }).click();
  const dueSection = page.getByRole("region", { name: "预计今天完成" });
  await expect(dueSection).toContainText("吃牛奶");
  await dueSection
    .getByRole("button", { name: "安排到今天：吃牛奶" })
    .press("Enter");
  await expect(dueSection).toHaveCount(0);
  await expect(
    page.locator(".task-card").filter({ hasText: "吃牛奶" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "完成任务", exact: true }),
  ).toBeFocused();
  const plan = await page.evaluate(() => window.desktop.load());
  expect(
    plan.arrangements.filter((item) => item.taskId === dueTask.id),
  ).toEqual([
    { date: today, done: false, scope: "吃牛奶", taskId: dueTask.id },
  ]);

  const tomorrow = await page.evaluate(() => {
    const date = new Date();
    date.setDate(date.getDate() + 1);
    return date.toLocaleDateString("sv-SE");
  });
  await page
    .getByRole("button", { name: "记下一件事", exact: true })
    .first()
    .click();
  await dialog.getByLabel("任务名称").fill("整理明天的材料");
  await dialog.getByLabel("所属任务").selectOption(parent.id);
  await dialog.getByLabel("预计开始日期").fill(tomorrow);
  await dialog.getByLabel("预计完成日期").fill(tomorrow);
  await expect(dialog.getByText("安排一次推进", { exact: true })).toHaveCount(
    0,
  );
  await expect(dialog.getByLabel("本次阶段目标")).toHaveCount(0);
  await dialog.getByRole("button", { name: "保存任务", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.evaluate(async (date) => {
    const state = await window.desktop.load();
    const task = state.tasks.find((item) => item.title === "整理明天的材料");
    await window.desktop.execute(state.revision, {
      type: "schedule",
      taskId: task.id,
      date,
      scope: "带齐明天要用的资料",
    });
  }, tomorrow);
  await page.getByRole("button", { name: /所有任务/ }).click();
  const action = page.getByRole("button", {
    name: "安排到今天：整理明天的材料",
  });
  const futureRow = page
    .locator(".task-list-row")
    .filter({ hasText: "整理明天的材料" });
  await expect(
    page.locator(".task-list-item.is-nested").filter({ has: futureRow }),
  ).toBeVisible();
  await expect(futureRow).toContainText(`${tomorrow} → ${tomorrow}`);
  await expect(action).toBeVisible();
  await expect(
    page.getByRole("button", { name: "安排到今天：选择规格" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "安排到今天：吃牛奶" }),
  ).toHaveCount(0);
  await expect
    .poll(() =>
      page
        .locator(".main-scroll")
        .evaluate(
          (workspace) => workspace.scrollWidth <= workspace.clientWidth,
        ),
    )
    .toBe(true);
  await page.evaluate(async () => {
    const state = await window.desktop.load();
    await window.desktop.execute(state.revision, {
      type: "energy",
      value: "状态平稳",
    });
  });
  await action.press("Enter");
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(action).toBeFocused();
  await expect(action).toBeEnabled();
  await action.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect(action).toHaveCount(0);
  await expect(futureRow).toBeFocused();
  await expect(futureRow).toContainText("今日");
  await page.getByRole("button", { name: /今日安排/ }).click();
  await expect(page.locator(".today-plan .task-name")).toHaveText([
    "吃牛奶",
    "整理明天的材料",
  ]);
  const scheduled = await page.evaluate(() => window.desktop.load());
  const futureTask = scheduled.tasks.find(
    (task) => task.title === "整理明天的材料",
  );
  expect(futureTask).toMatchObject({
    startDate: tomorrow,
    expectedDate: tomorrow,
  });
  expect(
    scheduled.arrangements.filter((item) => item.taskId === futureTask.id),
  ).toEqual([
    {
      taskId: futureTask.id,
      date: tomorrow,
      scope: "带齐明天要用的资料",
      done: false,
    },
    {
      taskId: futureTask.id,
      date: today,
      scope: "整理明天的材料",
      done: false,
    },
  ]);
  expect(scheduled.messages).toHaveLength(0);

  const currentTime = Date.now();
  const yesterday = new Date(currentTime);
  yesterday.setDate(yesterday.getDate() - 1);
  await page.clock.setSystemTime(yesterday);
  await page.reload();
  await page.getByRole("button", { name: /所有任务/ }).click();
  const afterMidnight = page.getByRole("button", {
    name: "安排到今天：买洗衣液",
  });
  await expect(afterMidnight).toBeVisible();
  await page.clock.setSystemTime(currentTime);
  await afterMidnight.click();
  await expect(afterMidnight).toHaveCount(0);
  const refreshed = await page.evaluate(() => window.desktop.load());
  expect(refreshed.arrangements.at(-1)).toEqual({
    taskId: parent.id,
    date: today,
    scope: "买洗衣液",
    done: false,
  });
  expect(errors).toEqual([]);
  console.log(
    "PASS: task fields, shared child editor, filters, both schedule-to-today entries, SQLite restart, themes and narrow layout; no model calls",
  );
} finally {
  await app.close();
}
