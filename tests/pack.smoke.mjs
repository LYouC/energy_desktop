import { _electron as electron, expect } from "@playwright/test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
const directory = await mkdtemp(path.join(tmpdir(), "xixu-pack-agent-"));
const app = await electron.launch({
  executablePath: path.resolve("release/win-unpacked/息序.exe"),
  env: { ...process.env, XIXU_DATA_DIR: directory, XIXU_API_KEY: "" },
});
try {
  const page = await app.firstWindow();
  expect((await page.evaluate(() => window.desktop.load())).tasks).toHaveLength(
    0,
  );
  expect((await page.evaluate(() => window.desktop.agentConfig())).hasKey).toBe(
    false,
  );
  await page.getByRole("button", { name: "模型设置", exact: true }).click();
  await expect(page.getByLabel("模型 API Key")).toHaveValue("");
  console.log(
    "PASS: packaged Agent IPC, SQLite, model settings; development credential absent",
  );
} finally {
  await app.close();
}
