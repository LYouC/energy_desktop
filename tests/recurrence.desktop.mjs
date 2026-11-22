import { _electron as electron, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const dataDir = await mkdtemp(path.join(tmpdir(), "xixu-recurrence-desktop-"));
let app;
let page;
const errors = [];
async function launch() {
  app = await electron.launch({
    args: ["."],
    env: { ...process.env, XIXU_DATA_DIR: dataDir, XIXU_API_KEY: "" },
  });
  page = await app.firstWindow();
  page.on("pageerror", (error) => errors.push(error.message));
  await expect(
    page.getByRole("heading", { name: "今天，留一点余地。" }),
  ).toBeVisible();
}

async function expectInlineTag(row, text = "重复") {
  const line = row.locator(".task-title-line");
  await expect(line.locator(".recurrence-tag")).toHaveText(text);
  await expect
    .poll(() =>
      line.evaluate((element) => {
        const [name, tag] = Array.from(element.children, (child) =>
          child.getBoundingClientRect(),
        );
        return (
          tag.left >= name.right &&
          tag.top < name.bottom &&
          tag.bottom > name.top
        );
      }),
    )
    .toBe(true);
}

try {
  await launch();
  const editor = page.getByRole("dialog");
  await page
    .getByRole("button", { name: "记下一件事", exact: true })
    .first()
    .click();
  await editor.getByLabel("任务名称").fill("整理纪要");
  await editor.getByText("安排一次推进", { exact: true }).click();
  await editor.getByLabel("本次阶段目标").fill("列出三个要点");
  await editor.getByRole("button", { name: "保存并安排" }).click();
  await expect(editor).toBeHidden();

  await page.getByRole("button", { name: /所有任务/ }).click();
  await page.getByRole("button", { name: "添加任务", exact: true }).click();
  await editor.getByLabel("任务名称").fill("练英语");
  await editor
    .getByRole("combobox", { name: "重要性", exact: true })
    .selectOption("high");
  const frequency = editor.getByRole("combobox", { name: "重复", exact: true });
  await frequency.selectOption("weekly");
  await editor.getByRole("checkbox", { name: "周一", exact: true }).check();
  await frequency.selectOption("range");
  await expect(editor.getByLabel("重复开始日期")).toBeVisible();
  await expect(editor.getByLabel("重复结束日期")).toBeVisible();
  await frequency.selectOption("daily");
  await editor.getByRole("button", { name: "保存任务", exact: true }).click();
  await expect(editor).toBeHidden();
  const template = page.locator(".task-list-row").filter({ hasText: "练英语" });
  await page
    .getByRole("combobox", { name: "按任务类型筛选" })
    .selectOption("single");
  await expect(template).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "重复记录", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("combobox", { name: "按任务类型筛选" })
    .selectOption("repeated");
  await page
    .getByRole("combobox", { name: "按重要性筛选" })
    .selectOption("high");
  await expect(template).toHaveCount(1);
  await expectInlineTag(template);
  const search = page.getByRole("textbox", { name: "搜索任务" });
  await search.fill("不存在");
  await expect(template).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "重复记录", exact: true }),
  ).toBeVisible();
  await search.clear();

  await page.getByRole("button", { name: /今日安排/ }).click();
  const occurrence = page
    .locator("article.task-card")
    .filter({ hasText: "练英语" });
  await expectInlineTag(occurrence);
  await expect(occurrence.locator(".stage-goal")).toHaveCount(0);
  await occurrence.getByRole("button", { name: "上移安排" }).click();
  await expect(page.locator(".task-card.focused")).toContainText("练英语");
  await expectInlineTag(page.locator(".task-card.focused"));
  await occurrence.getByRole("button", { name: "下移安排" }).click();
  await expect(page.locator(".task-card.focused")).toContainText("整理纪要");
  await page.getByRole("button", { name: "管理", exact: true }).click();
  await expectInlineTag(
    page.locator(".select-card").filter({ hasText: "练英语" }),
  );
  const management = page.getByRole("toolbar", { name: "批量管理任务" });
  await management.getByRole("button", { name: "全选", exact: true }).click();
  await expect(
    management.getByRole("button", { name: "删除 1 项普通任务" }),
  ).toBeVisible();
  await management
    .getByRole("button", { name: "从今天移除 1 项重复安排" })
    .click();
  await expect(
    management.getByRole("button", { name: "删除 1 项普通任务" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await page.getByRole("button", { name: "完成", exact: true }).click();
  await occurrence
    .getByRole("button", { name: "从今天移除", exact: true })
    .click();
  await expect(occurrence).toHaveCount(0);
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect(occurrence).toHaveCount(1);
  await occurrence.getByRole("button", { name: "练英语", exact: true }).click();
  const occurrenceDialog = page.getByRole("dialog", { name: "本次详情" });
  await occurrenceDialog
    .getByRole("textbox", { name: "本次阶段目标" })
    .fill("跟读五分钟");
  await occurrenceDialog.getByRole("button", { name: "保存本次范围" }).click();
  await expect(occurrence.locator(".stage-goal")).toContainText("跟读五分钟");

  await page.getByRole("button", { name: /所有任务/ }).click();
  await template.click();
  await editor
    .getByRole("button", { name: "删除重复任务", exact: true })
    .click();
  await editor
    .getByRole("button", { name: "确认删除重复任务", exact: true })
    .click();
  await expect(template).toHaveCount(0);
  await app.close();
  app = undefined;

  await launch();
  const restored = page
    .locator("article.task-card")
    .filter({ hasText: "练英语" });
  await expect(restored).toContainText("跟读五分钟");
  await restored.getByRole("button", { name: /完成(?:今日阶段|本次)/ }).click();
  await page.getByRole("button", { name: /所有任务/ }).click();
  await page.getByRole("button", { name: "重复记录", exact: true }).click();
  const history = page.getByRole("dialog", { name: "重复记录" });
  await history
    .getByRole("button", { name: "查看执行记录", exact: true })
    .click();
  await expect(history).toContainText("练英语");
  await expect(history).toContainText("跟读五分钟");
  await expect(history).toContainText(/完成\s*1\s*次/);
  await history.getByRole("button", { name: "关闭", exact: true }).click();

  await page.getByRole("button", { name: /今日安排/ }).click();
  const ordinary = page
    .locator("article.task-card")
    .filter({ hasText: "整理纪要" });
  await ordinary.getByRole("button", { name: "整理纪要", exact: true }).click();
  const editOrdinary = page.getByRole("dialog", { name: "任务详情" });
  await editOrdinary
    .getByRole("combobox", { name: "重复", exact: true })
    .selectOption("weekly");
  const tomorrow = await page.evaluate(() => (new Date().getDay() + 1) % 7);
  const weekdays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  await editOrdinary
    .getByRole("checkbox", { name: weekdays[tomorrow], exact: true })
    .check();
  await editOrdinary
    .getByRole("button", { name: "保存任务", exact: true })
    .click();
  await expect(ordinary).toContainText("临时安排");
  await ordinary.getByRole("button", { name: "整理纪要", exact: true }).click();
  await editOrdinary.getByText("安排一次推进", { exact: true }).click();
  await editOrdinary.getByLabel("本次阶段目标").fill("整理四个要点");
  await editOrdinary.getByRole("button", { name: "保存并安排" }).click();
  await expect(ordinary).toContainText("整理四个要点");

  // 用保存的 Agent 方案验证真实 IPC、方案卡和部分接受。
  await page.evaluate(async () => {
    const state = await window.desktop.load();
    const task = state.tasks.find((item) => item.title === "整理纪要");
    const occurrence = state.arrangements.find(
      (item) => item.recurrence?.title === "练英语",
    );
    const sessionId = state.activeSessionId;
    const proposalId = crypto.randomUUID();
    const pending = {
      reason: "用户希望先看建议",
      date: occurrence.date,
      scope: "",
      children: [],
      status: "pending",
    };
    await window.desktop.execute(state.revision, {
      type: "reply",
      message: {
        id: crypto.randomUUID(),
        sessionId,
        role: "assistant",
        text: "两项建议待确认。",
        createdAt: new Date().toISOString(),
        proposalId,
      },
      proposal: {
        id: proposalId,
        sessionId,
        createdAt: new Date().toISOString(),
        changes: [
          {
            ...pending,
            id: crypto.randomUUID(),
            label: "设置重复规则「整理纪要」",
            type: "updateRecurrence",
            taskId: task.id,
            taskVersion: task.version,
            recurrence: { type: "daily" },
          },
          {
            ...pending,
            id: crypto.randomUUID(),
            label: "记录今日完成状态「练英语」",
            type: "setOccurrenceDone",
            taskId: occurrence.taskId,
            taskVersion: null,
            occurrence,
            done: false,
          },
        ],
      },
    });
  });
  await page.reload();
  const plan = page.locator(".proposal");
  await expect(plan).toContainText("每天");
  await expect(plan).toContainText("恢复为未完成");
  await plan
    .getByRole("button", { name: "接受这项", exact: true })
    .first()
    .click();
  await expect(plan).toContainText("部分接受");
  const accepted = await page.evaluate(() => window.desktop.load());
  expect(
    accepted.tasks.find((item) => item.title === "整理纪要").recurrence,
  ).toEqual({ type: "daily" });
  expect(
    accepted.arrangements.find((item) => item.recurrence?.title === "练英语")
      .done,
  ).toBe(true);
  await plan.getByRole("button", { name: "拒绝", exact: true }).click();

  await page.getByRole("button", { name: "我的空间 本地保存" }).click();
  await page.getByLabel("主题").selectOption("dark");
  await page.getByRole("button", { name: "保存设置" }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.setViewportSize({ width: 800, height: 900 });
  await expectInlineTag(ordinary, "临时安排");
  await page.locator(".today-completed summary").click();
  await expectInlineTag(restored);
  await expect(restored.locator(".task-footer")).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const main = document.querySelector(".main-scroll");
        return (
          document.documentElement.scrollWidth <= innerWidth &&
          main.scrollWidth <= main.clientWidth
        );
      }),
    )
    .toBe(true);
  expect(errors).toEqual([]);
  console.log(
    "PASS: recurring task editing, history, restart and Agent proposal acceptance",
  );
} finally {
  await app?.close();
  await rm(dataDir, { recursive: true, force: true, maxRetries: 3 });
}
