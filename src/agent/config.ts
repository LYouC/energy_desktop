import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
} from "node:fs";
import path from "node:path";
import { z } from "zod";

const configSchema = z.object({
  baseURL: z
    .string()
    .url()
    .refine((value) => {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password;
    }, "模型服务必须使用 HTTPS，凭据请通过 Key 字段提供。"),
  model: z.string().trim().min(1).max(200),
  encryptedKey: z.string().optional(),
});
type CredentialProtection = {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
};

export class AgentConfig {
  private filename: string;
  private config: z.infer<typeof configSchema>;
  private loadError = "";
  constructor(
    directory: string,
    private readonly protection: CredentialProtection,
  ) {
    mkdirSync(directory, { recursive: true });
    this.filename = path.join(directory, "model-config.json");
    this.config = {
      baseURL: "https://api.siliconflow.cn/v1",
      model: "deepseek-ai/DeepSeek-V4.1-Flash",
    };
    try {
      this.config = configSchema.parse(
        existsSync(this.filename)
          ? JSON.parse(readFileSync(this.filename, "utf8"))
          : {
              baseURL: process.env.XIXU_BASE_URL || this.config.baseURL,
              model: process.env.XIXU_MODEL || this.config.model,
            },
      );
    } catch {
      // 模型配置损坏不应阻止本地任务界面启动。原文件保留至用户重新保存。
      this.loadError = "模型配置无法读取，请在模型设置中重新保存。";
    }
  }
  private key() {
    if (this.config.encryptedKey) {
      if (!this.protection.isEncryptionAvailable())
        throw new Error("系统凭据保护不可用。");
      return this.protection.decryptString(
        Buffer.from(this.config.encryptedKey, "base64"),
      );
    }
    return process.env.XIXU_API_KEY || "";
  }
  publicView() {
    let hasKey = false;
    try {
      hasKey = !this.loadError && Boolean(this.key());
    } catch {}
    return { baseURL: this.config.baseURL, model: this.config.model, hasKey };
  }
  connection() {
    if (this.loadError) throw new Error(this.loadError);
    const apiKey = this.key();
    if (!apiKey) throw new Error("请先在模型设置中配置 API Key。");
    return { baseURL: this.config.baseURL, model: this.config.model, apiKey };
  }
  save(input: unknown) {
    const parsed = configSchema
      .omit({ encryptedKey: true })
      .extend({ apiKey: z.string().trim().min(1).optional() })
      .parse(input);
    // 换服务地址必须重新输入凭据，避免把旧服务的 Key 意外发送给另一服务。
    if (parsed.baseURL !== this.config.baseURL && !parsed.apiKey)
      throw new Error("更换服务地址时请同时输入对应 Key。");
    let encryptedKey = this.config.encryptedKey;
    if (parsed.apiKey) {
      if (!this.protection.isEncryptionAvailable())
        throw new Error("系统凭据保护不可用。");
      encryptedKey = this.protection
        .encryptString(parsed.apiKey)
        .toString("base64");
    }
    const next = { baseURL: parsed.baseURL, model: parsed.model, encryptedKey };
    const temporary = `${this.filename}.tmp`;
    writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 });
    renameSync(temporary, this.filename);
    this.config = next;
    this.loadError = "";
    return this.publicView();
  }
}
