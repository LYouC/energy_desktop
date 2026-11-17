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
  await expect(page.getByLabel("对话模式")).toHaveValue("real");
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
    ipcMain.removeHandler("agent:send");
    ipcMain.removeHandler("agent:cancel");
    ipcMain.handle("agent:send", (event, request) => {
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

  // 新字段需要在待接受方案中可见，并通过同一个接受入口写入任务。
  await page.evaluate(async () => {
    let state = await window.desktop.load();
    const taskId = crypto.randomUUID();
    const now = new Date().toISOString();
    state = await window.desktop.execute(state.revision, {
      type: "saveTask",
      task: {
        id: taskId,
        version: 0,
        title: "字段方案验证",
        description: "",
        startDate: "",
        expectedDate: "",
        status: "todo",
        parentId: null,
        updatedAt: now,
      },
    });
    const proposalId = crypto.randomUUID();
    await window.desktop.execute(state.revision, {
      type: "reply",
      message: {
        id: crypto.randomUUID(),
        sessionId: state.activeSessionId,
        role: "assistant",
        text: "建议补充以下信息。",
        createdAt: now,
        proposalId,
      },
      proposal: {
        id: proposalId,
        sessionId: state.activeSessionId,
        createdAt: now,
        changes: [
          {
            id: crypto.randomUUID(),
            taskId,
            taskVersion: state.tasks.find((task) => task.id === taskId).version,
            type: "update",
            label: "补充任务信息",
            reason: "固定测试方案",
            date: "",
            scope: "",
            children: [],
            status: "pending",
            patch: {
              startDate: "2026-11-19",
              expectedDate: "2026-11-21",
              description: "保留目标和硬截止",
            },
          },
        ],
      },
    });
  });
  await page.reload();
  await expect(page.locator(".proposal")).toContainText("预计开始：2026-11-19");
  await expect(page.locator(".proposal")).toContainText("预计完成：2026-11-21");
  await expect(page.locator(".proposal")).toContainText(
    "说明：保留目标和硬截止",
  );
  expect(
    (await page.evaluate(() => window.desktop.load())).tasks[0].description,
  ).toBe("");
  await page.getByRole("button", { name: "接受这项", exact: true }).click();
  const applied = await page.evaluate(() => window.desktop.load());
  expect(applied.tasks[0].description).toBe("保留目标和硬截止");
  expect(applied.tasks[0].startDate).toBe("2026-11-19");
  expect(applied.tasks[0].expectedDate).toBe("2026-11-21");
  expect(applied.arrangements).toHaveLength(0);
  expect(errors).toEqual([]);
  console.log(
    "PASS: no-key entry, secret input clearing, public config, stream preview, cancellation, session switch, new-field proposal display and acceptance; no model requests",
  );
} finally {
  await app.close();
}
