import { _electron as electron, expect } from "@playwright/test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const directory = await mkdtemp(path.join(tmpdir(), "xixu-review-"));
await mkdir("test-results", { recursive: true });
const app = await electron.launch({
  args: ["."],
  env: { ...process.env, XIXU_DATA_DIR: directory },
});
const page = await app.firstWindow();
const errors = [];
const checks = [];
page.on("pageerror", (error) => errors.push(error.message));
async function settings(theme) {
  await page.getByRole("button", { name: "我的空间 本地保存" }).click();
  await page.getByLabel("主题").selectOption(theme);
  await page.getByRole("button", { name: "保存设置" }).click();
}
try {
  await expect(
    page.getByRole("heading", { name: "今天，留一点余地。" }),
  ).toBeVisible();
  await page.getByLabel("对话模式").selectOption("mock");
  await page.evaluate(async () => {
    let state = await window.desktop.load();
    const task = (id, title, parentId = null) => ({
      id,
      title,
      parentId,
      version: 0,
      description: `留下可以检查的阶段产出，用户明确提供的背景，下一步先打开${title}的材料`,
      startDate: "",
      expectedDate: "",
      status: "todo",
      updatedAt: new Date().toISOString(),
    });
    const apply = async (command) => {
      state = await window.desktop.execute(state.revision, command);
    };
    await apply({ type: "saveTask", task: task("parent", "报告父任务") });
    await apply({
      type: "saveTask",
      task: task("child", "选中的分析子任务", "parent"),
    });
    const date = new Date();
    const today = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    await apply({
      type: "schedule",
      taskId: "parent",
      date: today,
      scope: "今天整理资料",
    });
    await apply({
      type: "schedule",
      taskId: "parent",
      date: "2030-01-01",
      scope: "未来交付终稿",
    });
  });
  await page.reload();
  await page.getByLabel("对话模式").selectOption("mock");
  await expect(page.locator(".task-card")).toHaveCount(1);
  await settings("system");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await page.getByLabel("和息序聊聊").fill("系统主题切换时保留草稿");
  const before = await page.evaluate(() => window.desktop.load());
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect(page.getByLabel("和息序聊聊")).toHaveValue(
    "系统主题切换时保留草稿",
  );
  const after = await page.evaluate(() => window.desktop.load());
  expect(after.arrangements).toEqual(before.arrangements);
  expect(after.messages).toEqual(before.messages);
  checks.push("跟随系统实时切换，保留草稿、安排和会话");
  await settings("light");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  checks.push("手选浅色不受系统深色事件覆盖");
  for (const theme of ["light", "dark"]) {
    await settings(theme);
    await page.screenshot({ path: `test-results/review-${theme}-today.png` });
    await page.getByRole("button", { name: "查看任务详情" }).click();
    await page.screenshot({ path: `test-results/review-${theme}-task.png` });
    const today = await page.evaluate(() => {
      const date = new Date();
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    });
    await page.getByText("安排一次推进", { exact: true }).click();
    await page.getByLabel("推进日期").fill(today);
    await expect(page.getByLabel("本次阶段目标")).toHaveValue("今天整理资料");
    checks.push(`${theme}切换已有安排日期后正确显示当日范围`);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: /所有任务/ }).click();
    await page.screenshot({ path: `test-results/review-${theme}-list.png` });
    await page.getByRole("button", { name: /今日安排/ }).click();
  }
  await page.locator(".child-row").click();
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "帮我开始", exact: true }).click();
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.locator(".assistant")).toHaveCount(1);
  await expect(page.locator(".assistant")).toContainText(
    "我们先看「选中的分析子任务」",
  );
  checks.push(
    `选择子任务后的启动协助为 ${await page.locator(".assistant").innerText()}`,
  );
  for (const theme of ["light", "dark"]) {
    await settings(theme);
    const ratios = await page.evaluate(() => {
      const selectors = [
        ".brand small",
        ".quiet-note",
        ".profile small",
        ".energy .eyebrow",
        ".chat-header > span",
        ".message.user p",
      ];
      function luminance(color) {
        const values = color
          .match(/[\d.]+/g)
          .slice(0, 3)
          .map(Number)
          .map((value) => value / 255)
          .map((value) =>
            value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
          );
        return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
      }
      return selectors.map((selector) => {
        const element = document.querySelector(selector);
        let parent = element;
        let background;
        while (parent) {
          background = getComputedStyle(parent).backgroundColor;
          if (background !== "rgba(0, 0, 0, 0)" && background !== "transparent")
            break;
          parent = parent.parentElement;
        }
        const foreground = getComputedStyle(element).color;
        const values = [luminance(foreground), luminance(background)].sort(
          (a, b) => a - b,
        );
        return {
          selector,
          foreground,
          background,
          ratio: (values[1] + 0.05) / (values[0] + 0.05),
        };
      });
    });
    for (const result of ratios)
      expect(
        result.ratio,
        `${theme} ${result.selector} contrast`,
      ).toBeGreaterThanOrEqual(4.5);
    checks.push(`${theme}导航、能量和用户消息的文字对比度均达到4.5:1`);
  }
  await page.setViewportSize({ width: 800, height: 720 });
  await page.getByRole("button", { name: "查看任务详情" }).click();
  await page
    .getByLabel("任务名称", { exact: true })
    .fill("长任务标题".repeat(20));
  await page.screenshot({
    path: "test-results/review-narrow-dialog.png",
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.keyboard.press("Tab");
  expect(
    await page.evaluate(
      () => !!document.activeElement?.closest("[role=dialog]"),
    ),
  ).toBe(true);
  checks.push("800px 窄窗口弹窗无横向溢出，键盘焦点留在弹窗");
  expect(errors).toEqual([]);
  await writeFile(
    "test-results/review-results.json",
    JSON.stringify({ checks, errors }, null, 2),
  );
  console.log(checks.join("\n"));
} finally {
  await app.close();
}
