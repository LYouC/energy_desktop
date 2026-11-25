import { _electron as electron, expect } from "@playwright/test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const directory = await mkdtemp(path.join(tmpdir(), "xixu-agent-ui-"));
await mkdir("test-results", { recursive: true });
// 配置损坏也必须能够打开工作台并在设置中恢复。
await writeFile(path.join(directory, "model-config.json"), "{broken-json");
const app = await electron.launch({
  args: ["."],
  env: { ...process.env, XIXU_DATA_DIR: directory, XIXU_API_KEY: "" },
});
const page = await app.firstWindow();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
try {
  await page.getByLabel("和息序聊聊").fill("帮我推进报告");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("模型设置");
  expect(
    (await page.evaluate(() => window.desktop.load())).messages,
  ).toHaveLength(0);
  await dialog.getByLabel("模型 API Key").fill("ui-test-placeholder");
  await dialog.getByRole("button", { name: "保存模型设置" }).click();
  await expect(dialog).not.toBeVisible();
  await page.getByRole("button", { name: "模型设置", exact: true }).click();
  await expect(dialog.getByLabel("模型 API Key")).toHaveValue("");
  expect(
    await page.evaluate(() => window.desktop.agentConfig()),
  ).not.toHaveProperty("apiKey");
  await page.screenshot({ path: "test-results/agent-model-settings.png" });
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();

  // 测试传输只生成固定片段，避免 UI 回归触发真实模型调用。
  await app.evaluate(({ ipcMain }) => {
    let pending;
    let retryId;
    ipcMain.removeHandler("agent:send");
    ipcMain.removeHandler("agent:cancel");
    ipcMain.handle("agent:send", (event, request) => {
      if (request.text === "重试测试") {
        if (!retryId) {
          retryId = request.runId;
          for (const chunk of [
            { type: "text", text: "失败的半段文字" },
            { type: "retry", text: "正在自动重试（3/3）…" },
          ])
            event.sender.send("agent:event", {
              runId: request.runId,
              ...chunk,
            });
          throw new Error("测试网络失败");
        }
        if (retryId !== request.runId) throw new Error("重试没有复用标识");
        return null;
      }
      event.sender.send("agent:event", {
        runId: request.runId,
        type: "status",
        text: "正在查看相关任务背景…",
      });
      event.sender.send("agent:event", {
        runId: request.runId,
        type: "text",
        text: "可以先整理",
      });
      event.sender.send("agent:event", {
        runId: request.runId,
        type: "text",
        text: "报告提纲。",
      });
      return new Promise((resolve) => {
        pending = resolve;
      });
    });
    ipcMain.handle("agent:cancel", () => {
      pending?.(null);
      pending = undefined;
    });
  });
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.locator(".message.assistant")).toContainText(
    "可以先整理报告提纲。",
  );
  await expect(page.getByLabel("和息序聊聊")).toBeDisabled();
  await page.getByRole("button", { name: "取消生成", exact: true }).click();
  await expect(page.getByLabel("和息序聊聊")).toBeEnabled();
  await expect(page.locator(".message.assistant")).toHaveCount(0);
  expect((await page.evaluate(() => window.desktop.load())).tasks).toHaveLength(
    0,
  );

  await page.getByLabel("和息序聊聊").fill("第二轮协助");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.locator(".message.assistant")).toContainText("报告提纲");
  await page.getByRole("button", { name: "新建对话", exact: true }).click();
  await expect(page.getByLabel("和息序聊聊")).toBeEnabled();
  await expect(page.locator(".message.assistant")).toHaveCount(0);
  expect(
    (await page.evaluate(() => window.desktop.load())).sessions,
  ).toHaveLength(2);
  await page.screenshot({ path: "test-results/agent-new-session.png" });

  await page.getByLabel("和息序聊聊").fill("重试测试");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  const retry = page.getByRole("button", { name: "重试本轮" });
  await expect(retry).toBeVisible();
  await expect(page.getByText("失败的半段文字")).toHaveCount(0);
  await page.getByLabel("和息序聊聊").fill("保留新的草稿");
  await retry.click();
  await expect(page.getByLabel("和息序聊聊")).toBeEnabled();
  await expect(retry).toHaveCount(0);
  await expect(page.getByLabel("和息序聊聊")).toHaveValue("保留新的草稿");

  // A18 验证卡片合并展示与接受后的安排和字段联动。
  await page.evaluate(async () => {
    let state = await window.desktop.load();
    const taskId = crypto.randomUUID();
    const now = new Date().toISOString();
    state = await window.desktop.execute(state.revision, {
      type: "saveTask",
      task: {
        id: taskId,
        version: 0,
        title: "整理发票",
        description: "",
        startDate: "",
        expectedDate: "2026-11-20",
        status: "todo",
        parentId: null,
        updatedAt: now,
      },
    });
    state = await window.desktop.execute(state.revision, {
      type: "schedule",
      taskId,
      date: "2026-11-20",
      scope: "核对发票",
    });
    const proposalId = crypto.randomUUID();
    const change = {
      taskId,
      taskVersion: state.tasks.find((task) => task.id === taskId).version,
      children: [],
    };
    await window.desktop.execute(state.revision, {
      type: "reply",
      message: {
        id: crypto.randomUUID(),
        sessionId: state.activeSessionId,
        role: "assistant",
        text: "建议把整理发票移到明天。",
        createdAt: now,
        proposalId,
      },
      proposal: {
        id: proposalId,
        sessionId: state.activeSessionId,
        createdAt: now,
        cards: [
          {
            id: crypto.randomUUID(),
            taskId,
            title: "整理发票",
            reason: "给今天的报告留出时间",
            status: "pending",
            previousExpectedDate: "2026-11-20",
            changes: [
              {
                ...change,
                id: crypto.randomUUID(),
                type: "unschedule",
                label: "取消旧安排",
                date: "2026-11-20",
                scope: "",
              },
              {
                ...change,
                id: crypto.randomUUID(),
                type: "schedule",
                label: "安排新日期",
                date: "2026-11-21",
                scope: "核对发票",
              },
              {
                ...change,
                id: crypto.randomUUID(),
                type: "update",
                label: "更新任务",
                date: "",
                scope: "",
                patch: {
                  startDate: "2026-11-19",
                  expectedDate: "2026-11-21",
                  description: "保留目标和硬截止",
                },
              },
            ],
          },
        ],
      },
    });
  });
  await page.reload();
  const card = page.locator(".proposal-change");
  await expect(card).toHaveCount(1);
  await expect(card).toContainText("2026-11-20 → 2026-11-21 · 核对发票");
  await expect(card).toContainText("预计开始：2026-11-19");
  await expect(card).toContainText("预计完成：2026-11-20 → 2026-11-21");
  await expect(card).toContainText("说明：保留目标和硬截止");
  await expect(
    card.getByText("给今天的报告留出时间", { exact: true }),
  ).toHaveCount(1);
  const accept = card.getByRole("button", { name: "接受", exact: true });
  await expect(accept).toHaveCount(1);
  await expect(
    card.getByRole("button", { name: "拒绝", exact: true }),
  ).toHaveCount(1);
  const pending = await page.evaluate(() => window.desktop.load());
  expect(pending.tasks[0].description).toBe("");
  expect(pending.arrangements.map(({ date }) => date)).toEqual(["2026-11-20"]);
  await accept.click();
  await expect(card).toContainText("已接受 · 已生效");
  const applied = await page.evaluate(() => window.desktop.load());
  expect(applied.tasks[0].description).toBe("保留目标和硬截止");
  expect(applied.tasks[0].startDate).toBe("2026-11-19");
  expect(applied.tasks[0].expectedDate).toBe("2026-11-21");
  expect(applied.arrangements.map(({ date }) => date)).toEqual(["2026-11-21"]);

  await page.evaluate(async () => {
    let state = await window.desktop.load();
    for (let index = 0; index < 4; index++) {
      state = await window.desktop.execute(state.revision, {
        type: "session",
        id: crypto.randomUUID(),
      });
    }
  });
  await page.reload();
  await page.getByRole("button", { name: "对话历史", exact: true }).click();
  await dialog.getByLabel("每页对话数").selectOption("5");
  await expect(dialog.getByRole("listitem")).toHaveCount(5);
  await expect(dialog.locator("time").first()).toHaveAttribute("datetime", /T/);
  await dialog.getByRole("button", { name: "下一页" }).click();
  await expect(dialog.getByRole("listitem")).toHaveCount(1);
  await dialog.getByRole("button", { name: /^删除对话：/ }).click();
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(dialog.getByRole("listitem")).toHaveCount(1);
  await dialog.getByRole("button", { name: /^删除对话：/ }).click();
  await dialog.getByRole("button", { name: "确认删除", exact: true }).click();
  await expect(dialog.getByRole("listitem")).toHaveCount(5);
  await expect(dialog.getByRole("button", { name: "下一页" })).toBeDisabled();
  const afterDeletion = await page.evaluate(() => window.desktop.load());
  expect(afterDeletion.sessions).toHaveLength(5);
  expect(afterDeletion.tasks).toEqual(applied.tasks);
  expect(errors).toEqual([]);
  console.log(
    "PASS: model settings, stream preview, cancellation, same-turn retry, session switch, proposal acceptance, history pagination and deletion; no model requests",
  );
} finally {
  await app.close();
}
