import { _electron as electron, expect } from "@playwright/test";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const directory = await mkdtemp(path.join(tmpdir(), "xixu-today-"));
await mkdir("test-results", { recursive: true });
const app = await electron.launch({
  args: ["."],
  env: { ...process.env, XIXU_DATA_DIR: directory, XIXU_API_KEY: "" },
});
try {
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1280, height: 950 });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await expect(page.locator(".empty-state")).toContainText("给今天一个开始");
  await page.evaluate(async () => {
    const state = await window.desktop.load();
    const now = new Date();
    await window.desktop.execute(state.revision, {
      type: "saveTask",
      task: {
        id: "last-due",
        title: "今天唯一的预计任务",
        description: "",
        status: "todo",
        parentId: null,
        startDate: "",
        expectedDate: now.toLocaleDateString("sv-SE"),
        updatedAt: now.toISOString(),
        version: 0,
      },
    });
  });
  await page.reload();
  await page
    .getByRole("button", { name: "完成任务：今天唯一的预计任务" })
    .press("Space");
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const state = await window.desktop.load();
        return {
          status: state.tasks.find(({ id }) => id === "last-due")?.status,
          arrangements: state.arrangements.length,
        };
      }),
    )
    .toEqual({ status: "done", arrangements: 0 });
  const completed = page.locator(".today-completed");
  const completedSummary = completed.locator(":scope > summary");
  const due = page.getByRole("region", { name: "预计今天完成" });
  await expect(due).toHaveCount(0);
  await expect(completedSummary).toHaveText("今日已完成 1 项");
  await expect(completedSummary).toBeFocused();
  await expect(page.locator(".empty-state")).toHaveCount(0);
  await page.reload();
  await expect(completedSummary).toHaveText("今日已完成 1 项");
  await completedSummary.click();
  await completed
    .getByRole("button", { name: "恢复任务：今天唯一的预计任务" })
    .press("Space");
  await expect(
    due.getByRole("button", { name: "完成任务：今天唯一的预计任务" }),
  ).toBeFocused();
  await expect(completedSummary).toHaveCount(0);
  await page.evaluate(async () => {
    let state = await window.desktop.load();
    const now = new Date();
    const date = now.toLocaleDateString("sv-SE");
    const apply = async (command) => {
      state = await window.desktop.execute(state.revision, command);
    };
    await apply({ type: "deleteTask", id: "last-due" });
    await apply({ type: "energy", value: "有些疲惫" });
    for (const [id, title, scope, done] of [
      ["laundry", "洗衣服", "晾好洗完的衣服", true],
      ["blog", "写博客", "写完开头和文章提纲", false],
      ["read", "整理资料", "挑出三份值得保留的资料", false],
      ["email", "回复邮件", "确认下周会议时间", false],
      ["legacy", "已归档旧任务", "保留的阶段记录", true],
    ]) {
      await apply({
        type: "saveTask",
        task: {
          id,
          title,
          description: id === "blog" ? "先写清楚这篇文章想回答的问题。" : "",
          status: "doing",
          parentId: null,
          startDate: "",
          expectedDate: id === "legacy" ? date : "",
          updatedAt: now.toISOString(),
          version: 0,
        },
      });
      await apply({ type: "schedule", taskId: id, date, scope });
      if (done) await apply({ type: "stage", taskId: id, date, done });
    }
    await apply({ type: "setTaskDone", taskId: "legacy", done: true });
    const task = state.tasks.find(({ id }) => id === "blog");
    await apply({
      type: "saveTask",
      task: {
        ...task,
        id: "due",
        title: "预计完成提醒",
        version: 0,
        expectedDate: date,
      },
    });
    for (const [id, parentId, title] of [
      ["child", "blog", "已安排的子任务"],
      ["grandchild", "child", "未安排的孙任务"],
    ]) {
      await apply({
        type: "saveTask",
        task: { ...task, id, title, parentId, version: 0 },
      });
    }
    await apply({
      type: "schedule",
      taskId: "child",
      date,
      scope: "独立的子任务范围",
    });
  });
  await page.reload();
  const focus = page.locator(".task-card.focused");
  const queue = page.getByRole("region", { name: "其余待推进" });
  await expect(page.locator(".today-plan > :first-child")).toHaveClass(
    /focused/,
  );
  await expect(focus).toContainText("写博客");
  await expect(due).toBeVisible();
  expect((await focus.boundingBox()).y).toBeLessThan(
    (await due.boundingBox()).y,
  );
  await expect(
    focus.getByRole("button", { name: "完成任务", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
  await page.getByRole("button", { name: "管理", exact: true }).click();
  const select = page.getByRole("button", { name: "选择今日安排：写博客" });
  await expect(page.locator(".today-plan > :first-child")).toHaveText(/写博客/);
  await expect(select.locator(".select-box")).toBeVisible();
  await select.press("Space");
  await expect(select).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "完成", exact: true }).click();
  await expect(completedSummary).toHaveText("今日已完成 2 项");
  await expect(completed.getByText("洗衣服", { exact: true })).toBeHidden();

  for (const theme of ["light", "dark"]) {
    await page.getByRole("button", { name: "我的空间 本地保存" }).click();
    await page.getByLabel("主题").selectOption(theme);
    await page.getByRole("button", { name: "保存设置" }).click();
    if (theme === "dark")
      await expect(page.locator("html")).toHaveClass(/dark/);
    else await expect(page.locator("html")).not.toHaveClass(/dark/);
    await page.screenshot({ path: `test-results/today-${theme}.png` });
  }
  await page.setViewportSize({ width: 800, height: 900 });
  await expect
    .poll(() =>
      page.evaluate(() => {
        const workspace = document.querySelector(".main-scroll");
        return (
          document.documentElement.scrollWidth <= window.innerWidth &&
          workspace.scrollWidth <= workspace.clientWidth
        );
      }),
    )
    .toBe(true);
  await page.screenshot({ path: "test-results/today-narrow.png" });

  await queue.getByRole("button", { name: "上移安排" }).click();
  await expect(queue.locator(".task-name")).toHaveText([
    "回复邮件",
    "整理资料",
  ]);
  await queue
    .locator("article")
    .filter({ hasText: "整理资料" })
    .getByRole("button", { name: "聚焦这件事" })
    .click();
  await expect(focus).toContainText("整理资料");
  await expect(queue.locator(".task-name")).toHaveText(["写博客", "回复邮件"]);
  await queue.getByRole("button", { name: "回复邮件", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(focus).toContainText("整理资料");

  for (const title of ["整理资料", "写博客", "回复邮件"]) {
    await expect(focus).toContainText(title);
    await focus.getByRole("button", { name: "完成任务", exact: true }).click();
  }
  await expect(focus).toHaveCount(0);
  await expect(page.locator(".today-finished")).toHaveText(
    "已安排的事项均已完成，另有 1 项预计今天完成",
  );
  await due.getByRole("button", { name: "完成任务：预计完成提醒" }).click();
  await expect(due).toHaveCount(0);
  await expect(page.locator(".today-finished")).toHaveText(
    "今日安排已全部完成",
  );
  await page.getByRole("button", { name: /所有任务/ }).click();
  for (const title of [
    "写博客",
    "已安排的子任务",
    "未安排的孙任务",
    "预计完成提醒",
  ])
    await expect(
      page.locator(".task-list-row").filter({ hasText: title }),
    ).toContainText("整体完成");
  await page.getByRole("button", { name: /^今日安排/ }).click();
  await expect(completedSummary).toHaveText("今日已完成 7 项");
  await completedSummary.click();
  await expect(
    completed.getByRole("button", { name: "预计完成提醒", exact: true }),
  ).toBeVisible();
  const blog = completed.locator("article").filter({ hasText: "写博客" });
  await blog.getByRole("button", { name: "恢复任务", exact: true }).click();
  await expect(focus).toContainText("写博客");
  await expect(
    focus.getByRole("list", { name: "写博客的子任务" }),
  ).toContainText("整体完成");
  await expect(completedSummary).toBeVisible();
  if (!(await completed.getByText("洗衣服", { exact: true }).isVisible()))
    await completedSummary.click();
  const laundry = completed.locator("article").filter({ hasText: "洗衣服" });
  await expect(laundry).toContainText("整体任务：进行中");
  await laundry.getByRole("button", { name: "恢复今日阶段" }).click();
  await expect(focus).toContainText("洗衣服");
  await expect(page.locator(".today-finished")).toHaveCount(0);
  await page.getByRole("button", { name: "已完成", exact: true }).click();
  const oldRecord = page.getByRole("region", { name: "已完成的今日阶段" });
  await oldRecord.getByRole("button", { name: "恢复今日阶段" }).click();
  await expect(oldRecord).toHaveCount(0);
  await expect(
    page.locator(".task-list-row").filter({ hasText: "已归档旧任务" }),
  ).toContainText("整体完成");
  expect(errors).toEqual([]);
  console.log(
    "PASS: focus-first, queue ordering, scheduled and unscheduled completion, restoration, light/dark themes, narrow layout",
  );
} finally {
  await app.close();
}
