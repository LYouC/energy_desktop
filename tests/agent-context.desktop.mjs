import { _electron as electron, expect } from "@playwright/test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const directory = await mkdtemp(path.join(tmpdir(), "xixu-agent-context-"));
const app = await electron.launch({
  args: ["."],
  env: {
    ...process.env,
    XIXU_DATA_DIR: directory,
    XIXU_BASE_URL: "https://model.example.test/v1",
    XIXU_MODEL: "context-test",
    XIXU_API_KEY: "fake-context-test-key",
  },
});
try {
  const page = await app.firstWindow();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const capturedBodies = () => app.evaluate(() => globalThis.contextTestBodies);
  await app.evaluate(() => {
    globalThis.contextTestBodies = [];
    globalThis.fetch = async (url, init) => {
      if (url !== "https://model.example.test/v1/chat/completions")
        throw new Error(`Unexpected URL ${url}`);
      const body = JSON.parse(init.body);
      globalThis.contextTestBodies.push(body);
      const previousResult = body.messages.findLast(
        ({ role }) => role === "tool",
      );
      const currentMessage = body.messages.findLast(
        ({ role }) => role === "user",
      );
      const optimizing =
        currentMessage.content.includes("预计今天完成但尚未安排");
      const decision = optimizing
        ? {
            intent: "changes",
            actions: [
              {
                type: "split",
                mode: previousResult ? "proposal" : "direct",
                taskId: "report",
                children: [
                  {
                    title: "写提纲",
                    description: "列出三个要点",
                    todayScope: "列出三个要点",
                  },
                ],
                reason: "先完成提纲，降低今天的工作量。",
              },
            ],
          }
        : { intent: "conversation", actions: [] };
      const replying = !body.tools?.length;
      const chunk = {
        choices: [
          {
            index: 0,
            delta: replying
              ? { content: optimizing ? "建议今天只写提纲。" : "收到第二轮。" }
              : {
                  tool_calls: [
                    {
                      index: 0,
                      id: previousResult ? "call-correction" : "call-first",
                      type: "function",
                      function: {
                        name: "prepareTurn",
                        arguments: JSON.stringify(decision),
                      },
                    },
                  ],
                },
            finish_reason: replying ? "stop" : "tool_calls",
          },
        ],
      };
      return new Response(
        `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`,
        {
          headers: { "Content-Type": "text/event-stream" },
        },
      );
    };
  });

  const optimize = page.getByRole("button", { name: "一键优化", exact: true });
  const debug = page.getByRole("button", { name: "调试上下文" });
  const dialog = page.getByRole("dialog", { name: "Agent 请求上下文" });
  const composer = page.getByLabel("和息序聊聊");
  const load = () => page.evaluate(() => window.desktop.load());
  await optimize.click();
  await expect(
    page.getByText("今天没有待优化的安排或预计完成任务。", { exact: true }),
  ).toBeVisible();
  expect((await load()).messages).toHaveLength(0);
  expect(await capturedBodies()).toHaveLength(0);
  await debug.click();
  await expect(dialog).toContainText("当前会话暂无已捕获的模型请求。");
  await page.keyboard.press("Escape");

  await page.evaluate(async () => {
    const initial = await window.desktop.load();
    const now = new Date();
    const state = await window.desktop.execute(initial.revision, {
      type: "saveTask",
      task: {
        id: "report",
        version: 0,
        title: "写报告",
        description: "",
        startDate: "",
        expectedDate: now.toLocaleDateString("sv-SE"),
        status: "todo",
        parentId: null,
        updatedAt: now.toISOString(),
      },
    });
    const recurring = await window.desktop.execute(state.revision, {
      type: "saveTask",
      task: {
        ...state.tasks[0],
        id: "archived",
        version: 0,
        title: "已删除的重复模板",
        recurrence: { type: "daily" },
      },
    });
    const finished = await window.desktop.execute(recurring.revision, {
      type: "stage",
      taskId: "archived",
      date: now.toLocaleDateString("sv-SE"),
      done: true,
    });
    await window.desktop.execute(finished.revision, {
      type: "deleteTask",
      id: "archived",
    });
  });
  await page.reload();
  await composer.fill("保留没写完的草稿");
  await optimize.click();
  await expect(page.locator(".message.user")).toContainText(
    "预计今天完成但尚未安排",
  );
  await expect(page.locator(".proposal")).toBeVisible();
  await expect(composer).toHaveValue("保留没写完的草稿");
  const optimized = await load();
  expect(optimized.messages).toHaveLength(2);
  expect(optimized.sessions[0].draft).toBe("保留没写完的草稿");
  expect(optimized.tasks.map(({ title }) => title)).toEqual(["写报告"]);
  expect(optimized.arrangements.some((item) => item.taskId === "report")).toBe(
    false,
  );
  expect(
    optimized.arrangements.some((item) => item.taskId === "archived"),
  ).toBe(true);
  expect(optimized.proposals[0].cards[0]).toMatchObject({
    status: "pending",
    changes: [{ children: [{ title: "写提纲", todayScope: "列出三个要点" }] }],
  });
  const firstRequests = await capturedBodies();
  expect(firstRequests).toHaveLength(3);
  for (const request of firstRequests)
    expect(JSON.stringify(request.messages)).not.toContain("已删除的重复模板");
  expect(JSON.stringify(firstRequests[1].messages)).toContain(
    "一键优化只允许提出待用户接受的方案",
  );
  const workspaceMessage = firstRequests[0].messages.find(
    ({ content }) =>
      typeof content === "string" && content.startsWith("以下JSON是工作区数据"),
  );
  const { context } = JSON.parse(workspaceMessage.content.split("\n")[1]);
  expect(context.today).toEqual([]);
  expect(context.dueToday).toMatchObject([{ id: "report" }]);
  await page
    .locator(".proposal")
    .getByRole("button", { name: "接受", exact: true })
    .click();
  await expect(page.locator(".proposal")).toContainText("已接受");
  const childCard = page
    .locator(".task-card.focused")
    .filter({ hasText: "写提纲" });
  await childCard
    .getByRole("button", { name: "完成任务", exact: true })
    .click();
  const completed = await load();
  expect(completed.tasks.find(({ title }) => title === "写提纲").status).toBe(
    "done",
  );
  expect(completed.tasks.find(({ id }) => id === "report").status).toBe("todo");

  await composer.fill("第二轮消息");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByText("收到第二轮。", { exact: true })).toBeVisible();
  await expect(composer).toBeEnabled();
  const bodies = await capturedBodies();
  expect(bodies).toHaveLength(5);

  await debug.click();
  const requestBody = dialog.getByLabel("模型请求体");
  const readBody = async () => JSON.parse(await requestBody.textContent());
  expect(await readBody()).toEqual(bodies[4]);
  await dialog.getByLabel("对话轮次").selectOption("1");
  expect(await readBody()).toEqual(bodies[2]);
  await dialog.getByLabel("模型请求", { exact: true }).selectOption("0");
  expect(await readBody()).toEqual(bodies[0]);
  await expect(dialog).not.toContainText("fake-context-test-key");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "新建对话", exact: true }).click();
  await expect(page.locator(".message.user")).toHaveCount(0);
  await debug.click();
  await expect(dialog).toContainText("当前会话暂无已捕获的模型请求。");
  expect(errors).toEqual([]);
  console.log(
    "PASS: empty optimization, first-turn proposal with draft preserved, exact model requests and session isolation",
  );
} finally {
  await app.close();
}
