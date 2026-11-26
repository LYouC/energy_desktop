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
  await expect(editor.getByText("安排一次推进", { exact: true })).toHaveCount(
    0,
  );
  await expect(editor.getByLabel("本次阶段目标")).toHaveCount(0);
  await editor.getByRole("button", { name: "保存任务" }).click();
  await expect(editor).toBeHidden();

  await page.getByRole("button", { name: /所有任务/ }).click();
  await page.getByRole("button", { name: "安排到今天：整理纪要" }).click();
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
  const historyEntry = page.getByRole("button", {
    name: "重复记录",
    exact: true,
  });
  const historyDialog = page.getByRole("dialog", { name: "重复记录" });
  await expect(historyEntry).toHaveCount(0);
  await expect(historyDialog).toHaveCount(0);
  await page
    .getByRole("combobox", { name: "按任务类型筛选" })
    .selectOption("single");
  await expect(template).toHaveCount(0);
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
  await expect(
    occurrenceDialog.getByRole("button", { name: "查看重复设置" }),
  ).toBeVisible();
  await expect(
    occurrenceDialog.getByRole("button", { name: "查看执行记录", exact: true }),
  ).toHaveCount(0);
  await occurrenceDialog
    .getByRole("textbox", { name: "本次范围" })
    .fill("跟读五分钟");
  await occurrenceDialog.getByRole("button", { name: "保存本次范围" }).click();
  await expect(occurrence.locator(".stage-goal")).toContainText("跟读五分钟");

  await page.getByRole("button", { name: /所有任务/ }).click();
  await template.click();
  await expect(editor).toBeVisible();
  await expect(
    editor.getByRole("button", { name: "查看执行记录", exact: true }),
  ).toHaveCount(0);
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
  await restored.getByRole("button", { name: "练英语", exact: true }).click();
  const restoredDialog = page.getByRole("dialog", { name: "本次详情" });
  await expect(restoredDialog).toBeVisible();
  await expect(
    restoredDialog.getByRole("button", { name: "查看执行记录", exact: true }),
  ).toHaveCount(0);
  await expect(
    restoredDialog.getByRole("button", { name: "查看重复设置" }),
  ).toHaveCount(0);
  await restoredDialog.getByRole("button", { name: "关闭" }).click();
  await restored.getByRole("button", { name: "完成本次安排" }).click();
  await page.getByRole("button", { name: "已完成", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "今日已完成的重复任务" }),
  ).toContainText("练英语");

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
  const temporaryDialog = page.getByRole("dialog", { name: "本次详情" });
  await temporaryDialog
    .getByRole("textbox", { name: "本次范围" })
    .fill("整理四个要点");
  await temporaryDialog.getByRole("button", { name: "保存本次范围" }).click();
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
      date: occurrence.date,
      scope: "",
      children: [],
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
        cards: [
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
        ].map((change) => ({
          id: crypto.randomUUID(),
          taskId: change.taskId,
          title: change.label,
          reason: "用户希望先看建议",
          status: "pending",
          changes: [change],
        })),
      },
    });
  });
  await page.reload();
  const plan = page.locator(".proposal");
  await expect(plan).toContainText("每天");
  await expect(plan).toContainText("恢复为未完成");
  await plan.getByRole("button", { name: "接受", exact: true }).first().click();
  await expect(plan.locator(".proposal-change").first()).toContainText(
    "已接受",
  );
  await expect(
    plan
      .locator(".proposal-change")
      .last()
      .getByRole("button", { name: "接受", exact: true }),
  ).toBeVisible();
  const accepted = await page.evaluate(() => window.desktop.load());
  expect(
    accepted.tasks.find((item) => item.title === "整理纪要").recurrence,
  ).toEqual({ type: "daily" });
  expect(
    accepted.arrangements.find((item) => item.recurrence?.title === "练英语")
      .done,
  ).toBe(true);
  await plan.getByRole("button", { name: "拒绝", exact: true }).click();
  await expect(plan.locator(".proposal-change").last()).toContainText("已拒绝");

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
  await page.getByRole("button", { name: /所有任务/ }).click();
  await page.locator(".task-list-row").filter({ hasText: "整理纪要" }).click();
  const taskEditor = page.getByRole("dialog");
  await taskEditor.getByRole("button", { name: "添加子任务" }).click();
  await taskEditor.getByLabel("任务名称").fill("检查行动项");
  await expect(taskEditor.getByText("随所属任务重复 · 每天")).toBeVisible();
  await taskEditor
    .getByRole("button", { name: "保存任务", exact: true })
    .click();
  const childRow = page
    .locator(".task-list-row")
    .filter({ hasText: "检查行动项" });
  await expectInlineTag(childRow);
  await expect(
    page.locator(".task-list-item.is-nested").filter({ has: childRow }),
  ).toBeVisible();
  await page.getByLabel("搜索任务").fill("检查行动项");
  await expect(childRow).toContainText("所属任务 · 整理纪要");
  await page.getByLabel("搜索任务").clear();
  await page.getByRole("button", { name: /今日安排/ }).click();
  const childList = page.getByRole("list", { name: "整理纪要的子任务" });
  const childCheck = childList.getByRole("button", {
    name: "完成子任务本次安排：检查行动项",
  });
  await expect(
    page.getByRole("button", { name: "检查行动项", exact: true }),
  ).toHaveCount(1);
  await expect(childList.getByRole("listitem")).toHaveCSS(
    "border-bottom-width",
    "1px",
  );
  await childList
    .getByRole("button", { name: "检查行动项", exact: true })
    .click();
  await expect(page.getByRole("dialog", { name: "本次详情" })).toBeVisible();
  await page.keyboard.press("Escape");
  await childCheck.press("Space");
  await expect(
    childList.getByRole("button", { name: "恢复子任务本次安排：检查行动项" }),
  ).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await childList
    .getByRole("button", { name: "恢复子任务本次安排：检查行动项" })
    .click();
  await expect(childCheck).toBeVisible();
  const parentCard = page.locator(".task-card.focused");
  await parentCard
    .getByRole("button", { name: "完成本次安排", exact: true })
    .click();
  await page.locator(".today-completed > summary").click();
  await expect(childList).toBeHidden();
  await page.getByText("展开子任务（1）", { exact: true }).click();
  await expect(childList).toBeVisible();
  await childList
    .getByRole("button", { name: "恢复子任务本次安排：检查行动项" })
    .click();
  await expect(
    parentCard.getByRole("button", { name: "恢复本次安排", exact: true }),
  ).toBeVisible();
  await childCheck.click();
  await page.getByRole("button", { name: /所有任务/ }).click();
  await expect(childRow).toContainText("今日已完成");
  await page.getByRole("button", { name: "已完成", exact: true }).click();
  const completedStages = page.getByRole("region", {
    name: "今日已完成的重复任务",
  });
  await completedStages
    .locator("article")
    .filter({ hasText: "检查行动项" })
    .getByRole("button", { name: "恢复本次安排" })
    .click();
  await expect(completedStages).not.toContainText("检查行动项");
  await page.getByRole("button", { name: /今日安排/ }).click();
  await expect(childCheck).toBeVisible();
  await childList
    .getByRole("button", { name: "检查行动项的安排操作" })
    .press("Enter");
  await page.getByRole("menuitem", { name: "从今天移除", exact: true }).click();
  await expect(page.locator(".recurrence-undo")).toContainText(
    "已从今天移除 1 项重复安排",
  );
  await app.close();
  app = undefined;
  await launch();
  await expect(page.locator(".recurrence-undo")).toHaveCount(0);
  const reopened = await page.evaluate(() => window.desktop.load());
  expect(
    reopened.skippedOccurrences.some(
      ({ arrangement }) => arrangement.recurrence?.title === "检查行动项",
    ),
  ).toBe(true);

  await page.getByRole("button", { name: /所有任务/ }).click();
  await page.getByRole("button", { name: "添加任务", exact: true }).click();
  const newDialog = page.getByRole("dialog");
  await newDialog.getByLabel("任务名称").fill("短暂移除测试");
  await newDialog
    .getByRole("combobox", { name: "重复", exact: true })
    .selectOption("daily");
  await newDialog
    .getByRole("button", { name: "保存任务", exact: true })
    .click();
  await page.getByRole("button", { name: /今日安排/ }).click();
  await page.clock.install();
  const secondRemoval = page
    .locator("article.task-card")
    .filter({ hasText: "短暂移除测试" });
  const skip = secondRemoval.getByRole("button", {
    name: "从今天移除",
    exact: true,
  });
  const notice = page.locator(".recurrence-undo");
  await skip.click();
  await expect(notice).toContainText("已从今天移除 1 项重复安排");
  await notice.getByRole("button", { name: "撤销", exact: true }).click();
  await expect(secondRemoval).toBeVisible();
  await expect(
    page.locator(".task-name").filter({ hasText: /^检查行动项$/ }),
  ).toHaveCount(0);
  await skip.click();
  await expect(notice).toBeVisible();
  await page.clock.fastForward(10_001);
  await expect(notice).toHaveCount(0);
  await expect(secondRemoval).toHaveCount(0);
  await page.evaluate(async () => {
    let state = await window.desktop.load();
    const now = new Date();
    const root = state.tasks.find((task) => task.title === "整理纪要");
    const parent = {
      ...root,
      id: crypto.randomUUID(),
      parentId: root.id,
      version: 0,
      title: "未安排的中层任务",
      recurrence: undefined,
    };
    const grandchild = {
      ...parent,
      id: crypto.randomUUID(),
      parentId: parent.id,
      title: "今天安排的孙任务",
    };
    // Use a one-off root so the bridge does not inherit a repeating arrangement.
    const independent = {
      ...parent,
      id: crypto.randomUUID(),
      parentId: null,
      title: "三层结构根任务",
    };
    parent.parentId = independent.id;
    for (const task of [independent, parent, grandchild])
      state = await window.desktop.execute(state.revision, {
        type: "saveTask",
        task,
      });
    for (const task of [grandchild, independent])
      state = await window.desktop.execute(state.revision, {
        type: "schedule",
        taskId: task.id,
        date: now.toLocaleDateString("sv-SE"),
        scope: task.title,
      });
  });
  await page.reload();
  const branch = page.getByRole("list", { name: "三层结构根任务的子任务" });
  await expect(branch.getByRole("listitem")).toHaveCount(2);
  await expect(branch.getByRole("listitem").nth(0)).toContainText(
    "未安排的中层任务",
  );
  await expect(branch.getByRole("listitem").nth(1)).toHaveAttribute(
    "style",
    "--task-indent: 12px;",
  );
  await expect(
    branch.getByRole("button", { name: /完成子任务：/ }),
  ).toHaveCount(1);
  await branch
    .getByRole("button", { name: "今天安排的孙任务的安排操作" })
    .press("Enter");
  await page.getByRole("menuitem", { name: "移出当日", exact: true }).click();
  await expect(
    branch.getByRole("button", { name: /完成子任务：/ }),
  ).toHaveCount(0);
  const state = await page.evaluate(() => window.desktop.load());
  const remainingTask = state.tasks.find(
    (task) => task.title === "今天安排的孙任务",
  );
  expect(remainingTask).toBeDefined();
  expect(
    state.arrangements.some(({ taskId }) => taskId === remainingTask.id),
  ).toBe(false);
  expect(errors).toEqual([]);
  console.log(
    "PASS: recurring task editing, removed history entries, restart, transient undo and Agent proposal acceptance",
  );
} finally {
  await app?.close();
  await rm(dataDir, { recursive: true, force: true, maxRetries: 3 });
}
