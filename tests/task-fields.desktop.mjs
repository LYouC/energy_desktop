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
  await expect(dialog.getByText("重要性", { exact: true })).toHaveCount(0);
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
  expect(Object.keys(parent).sort()).toEqual(Object.keys(child).sort());
  await page.locator(".task-list-row").filter({ hasText: "买洗衣液" }).click();
  await expect(dialog.getByLabel("所属任务").locator("option")).toHaveCount(1);
  await dialog.getByText("安排一次推进", { exact: true }).click();
  await dialog.getByLabel("推进日期").fill("2026-11-19");
  await dialog.getByLabel("本次阶段目标").fill("去超市购买");
  await dialog.getByRole("button", { name: "保存并安排", exact: true }).click();
  state = await page.evaluate(() => window.desktop.load());
  expect(state.tasks.find((task) => task.id === parent.id).startDate).toBe(
    "2026-11-17",
  );
  expect(state.arrangements[0].date).toBe("2026-11-19");
  expect(state.messages).toHaveLength(0);
  await app.close();
  ({ app, page } = await launch());
  await page.getByRole("button", { name: /所有任务/ }).click();
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
  await page.getByRole("button", { name: "我的空间 本地保存" }).click();
  await page.getByLabel("主题").selectOption("dark");
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await page.locator(".task-list-row").filter({ hasText: "买洗衣液" }).click();
  await page.screenshot({ path: "test-results/task-fields-dark.png" });
  await page.setViewportSize({ width: 800, height: 900 });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(800);
  await page.screenshot({ path: "test-results/task-fields-narrow.png" });
  expect(errors).toEqual([]);
  console.log(
    "PASS: minimal fields, shared child editor, dates, scheduling independence, SQLite restart, themes and narrow layout; no model calls",
  );
} finally {
  await app.close();
}
