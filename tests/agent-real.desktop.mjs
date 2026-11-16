import { _electron as electron, expect } from "@playwright/test";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// 可传入已有隔离目录复核保存结果，避免复验时重复调用模型。
const directory =
  process.argv[2] || (await mkdtemp(path.join(tmpdir(), "xixu-agent-real-")));
await mkdir("test-results", { recursive: true });
const errors = [];
async function launch() {
  const app = await electron.launch({
    args: ["."],
    env: { ...process.env, XIXU_DATA_DIR: directory },
  });
  const page = await app.firstWindow();
  page.on("pageerror", (error) => errors.push(error.message));
  await expect(page.getByLabel("对话模式")).toHaveValue("real");
  return { app, page };
}
let { app, page } = await launch();
try {
  const publicConfig = await page.evaluate(() => window.desktop.agentConfig());
  expect(publicConfig.hasKey).toBe(true);
  expect(Object.keys(publicConfig).sort()).toEqual([
    "baseURL",
    "hasKey",
    "model",
  ]);
  const initial = await page.evaluate(() => window.desktop.load());
  if (!initial.messages.length) {
    await page
      .getByLabel("和息序聊聊")
      .fill(
        "帮我记下一个任务：整理验证材料，完成条件是形成一页清单，截止2026-11-27。今天先不安排。",
      );
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect
      .poll(
        async () => {
          const state = await page.evaluate(() => window.desktop.load());
          return state.messages.filter(
            (message) => message.role === "assistant",
          ).length;
        },
        { timeout: 130000, intervals: [1000, 2000] },
      )
      .toBe(1);
    await expect(page.getByLabel("和息序聊聊")).toBeEnabled();
  }
  const result = await page.evaluate(() => window.desktop.load());
  expect(result.tasks).toHaveLength(1);
  expect(result.tasks[0].title).toBe("整理验证材料");
  expect(result.tasks[0].goal).toMatch(/一页.*清单/);
  expect(result.tasks[0].deadline).toContain("2026-11-27");
  expect(result.arrangements).toHaveLength(0);
  expect(result.messages).toHaveLength(2);
  await page.screenshot({ path: "test-results/agent-real-desktop.png" });
  await app.close();
  ({ app, page } = await launch());
  const restored = await page.evaluate(() => window.desktop.load());
  expect(restored.tasks).toEqual(result.tasks);
  expect(restored.messages).toEqual(result.messages);
  expect(restored.arrangements).toHaveLength(0);
  await expect(page.locator(".message.assistant")).toHaveCount(1);
  expect(errors).toEqual([]);
  console.log(
    "PASS: one real desktop model request, task and deadline saved, no arrangement, public config redacted, restart restored",
  );
} finally {
  await app.close();
}
