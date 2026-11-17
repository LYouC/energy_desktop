import { _electron as electron, expect } from "@playwright/test";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const dataDir = await mkdtemp(path.join(tmpdir(), "xixu-smoke-"));
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
  await page.getByLabel("对话模式").selectOption("mock");
  return { app, page };
}
let { app, page } = await launch();
try {
  for (const [title, description] of [
    ["完成产品调研报告", "形成可检查的初稿"],
    ["英语练习", "完成一次阅读练习"],
  ]) {
    await page
      .getByRole("button", { name: "记下一件事", exact: true })
      .first()
      .click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("任务名称").fill(title);
    await dialog
      .getByLabel("说明", { exact: true })
      .fill(`${description}，下一步打开${title}的材料`);
    await dialog.getByRole("button", { name: "保存任务", exact: true }).click();
    await expect(dialog).not.toBeVisible();
  }
  await page.getByLabel("此刻的能量").selectOption("有些疲惫");
  const before = await page.evaluate(() => window.desktop.load());
  expect(before.messages).toHaveLength(0);
  expect(before.arrangements).toHaveLength(0);
  await page.getByRole("button", { name: "重新分析", exact: true }).click();
  expect(await page.getByLabel("和息序聊聊").inputValue()).toContain(
    "有些疲惫",
  );
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "接受这项", exact: true }),
  ).toHaveCount(2);
  await page
    .getByRole("button", { name: "接受这项", exact: true })
    .first()
    .click();
  await expect(page.locator(".task-card")).toHaveCount(1);
  await expect(page.getByText("已接受 · 已生效")).toHaveCount(1);
  await page.getByRole("button", { name: "拒绝", exact: true }).click();
  await page.getByRole("button", { name: "完成今日阶段" }).click();
  const state = await page.evaluate(() => window.desktop.load());
  expect(state.tasks.every((task) => task.status === "todo")).toBe(true);
  expect(state.arrangements[0].done).toBe(true);
  await page.getByRole("button", { name: /所有任务/ }).click();
  await expect(
    page.getByRole("heading", { name: "所有任务", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".task-list-row")).toHaveCount(2);
  await expect(page.locator(".chat")).toBeVisible();
  await page.getByRole("button", { name: "我的空间 本地保存" }).click();
  await page.getByLabel("主题").selectOption("dark");
  await page.getByLabel("明确偏好").fill("晚上保留休息时间");
  await page.getByRole("button", { name: "保存设置" }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.getByRole("button", { name: /今日安排/ }).click();
  await page.screenshot({ path: "test-results/desktop-dark.png" });
  await page.getByRole("button", { name: "查看当前上下文" }).click();
  await expect(page.locator(".context-preview")).toContainText("有些疲惫");
  await expect(page.locator(".context-preview")).toContainText(
    "晚上保留休息时间",
  );
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "拆分任务", exact: true }).click();
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "接受这项", exact: true }),
  ).toHaveCount(1);
  await page.getByRole("button", { name: "接受这项", exact: true }).click();
  const split = await page.evaluate(() => window.desktop.load());
  expect(split.tasks.filter((task) => task.parentId)).toHaveLength(3);
  await page.getByRole("button", { name: "重新分析", exact: true }).click();
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await page.getByRole("button", { name: "取消生成", exact: true }).click();
  await page.waitForTimeout(650);
  expect(
    (await page.evaluate(() => window.desktop.load())).proposals,
  ).toHaveLength(2);
  await page.getByRole("button", { name: "重新分析", exact: true }).click();
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "接受这项", exact: true }),
  ).toHaveCount(2);
  await page.getByLabel("和息序聊聊").fill("保留这段输入草稿");
  await page.waitForTimeout(400);
  await app.close();
  ({ app, page } = await launch());
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect(page.getByLabel("和息序聊聊")).toHaveValue("保留这段输入草稿");
  const restored = await page.evaluate(() => window.desktop.load());
  expect(restored.tasks).toHaveLength(5);
  expect(restored.arrangements).toHaveLength(1);
  expect(restored.proposals).toHaveLength(3);
  expect(
    restored.proposals[2].changes.every(
      (change) => change.status === "pending",
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "我的空间 本地保存" }).click();
  await page.getByLabel("主题").selectOption("light");
  await page.getByRole("button", { name: "保存设置" }).click();
  await page.screenshot({ path: "test-results/desktop-light.png" });
  await page.getByRole("button", { name: /所有任务/ }).click();
  await page.locator(".task-list-row").filter({ hasText: "英语练习" }).click();
  await page.getByLabel("任务状态").selectOption("done");
  await page.getByRole("button", { name: "保存任务", exact: true }).click();
  await page.getByRole("button", { name: "已完成", exact: true }).click();
  await expect(page.locator(".task-list-row")).toHaveCount(1);
  await page.locator(".task-list-row").click();
  await page.getByRole("button", { name: "删除任务", exact: true }).click();
  await page.getByRole("button", { name: "确认删除", exact: true }).click();
  await expect(page.locator(".task-list-row")).toHaveCount(0);
  await page.getByRole("button", { name: /今日安排/ }).click();
  await page.setViewportSize({ width: 800, height: 900 });
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    )
    .toBe(true);
  await page.screenshot({
    path: "test-results/desktop-narrow.png",
    fullPage: true,
  });
  expect(errors).toEqual([]);
  console.log(
    "PASS: CRUD, latest energy, partial acceptance, stage completion, split, themes, context, SQLite restart, draft, narrow layout",
  );
} finally {
  await app.close();
}
