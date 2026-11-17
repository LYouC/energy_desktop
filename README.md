# 息序 · Energy Desktop

通过对话理解任务、形成背景、拆分目标并协商每日安排的桌面应用。目标是帮助用户更舒服地推进重要的事，同时考虑精力消耗、受挫与恢复。

## 当前状态

2026-11-17 任务属性修订：普通任务与子任务统一为名称、状态、预计开始/完成、说明和父任务；旧字段通过数据库 v2 迁移。手动任务界面与存储已更新；按本轮授权范围，真实 Agent、模拟回复及相关测试暂未适配新字段，完整类型检查/标准构建仍会被其旧字段引用阻止。下文首轮 Agent 能力及 74 项测试记录属于修订前验证范围，当前验证见 [测试说明](tests/README.md)。

本地交互原型与首轮真实 Agent 已建立，包含任务与子任务、按日期安排、阶段与整体进度、背景与偏好、方案部分接受、上下文预览、会话草稿、SQLite 保存及浅深主题。Agent 使用 AI SDK Core 单工具循环，通过本地执行层连接用户配置的模型服务。

当前从空工作区开始，可手动记任务，也可在右侧直接对话。默认真实 Agent，模型设置支持服务地址、模型和 API Key；本地模拟可通过对话模式显式选择。建议方案接受后生效，明确授权的操作直接执行。已完成首批真实场景验证，长期稳定性、更多表达和复杂连续协商继续按场景迭代。

## 开发运行

使用 Node.js 24 LTS，执行 `npm ci` 安装锁定依赖。

- `npm run dev` 启动 Vite 与 Electron 开发窗口。
- `npm run build` 执行类型检查并构建。
- `npm start` 打开构建后的桌面应用。
- `npm test` 验证关键业务规则。
- `npm run test:desktop` 构建并实际操作 Electron，运行主流程和独立审查场景，验证交互、重启恢复、系统主题、弹窗与对比度。
- `npm run format:check` 检查源码格式。
- `npm run pack` 构建 Windows 便携目录。

开发分支采用 `codex/desktop-prototype`，每个可验证阶段独立提交。便携开发工具、数据库及构建产物由 `.gitignore` 排除。

当前 74 项业务、SQLite、Pinia、Agent 运行与配色测试通过，独立审查及复验范围见 [测试说明](tests/README.md)。

任务、会话及设置保存在 Electron userData 的 `workspace.db`。验证脚本使用隔离的临时目录，截图在 `test-results/`。设置 `XIXU_DATA_DIR` 可指定独立的数据目录。主题首屏缓存只保存主题选项。

## 试用 Windows 原型

运行 `npm run pack` 后打开 `release/win-unpacked/息序.exe`。当前目录包已经独立启动验证，移动时需保留整个 `win-unpacked` 目录。原型使用无签名目录包。

Electron 首次运行会下载桌面运行文件。下载受网络环境影响时，可在当前 PowerShell 会话设置 `$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'` 后重试 `npm start` 或 `npm run pack`。镜像为可选环境设置。

## 查看设计稿

在浏览器打开 [浅色设计稿](design/index.html) 即可查看，样式文件随设计稿保存在同一目录。

## 项目文档

- [产品需求](docs/产品需求.md)记录产品行为、原型要验证的问题和验收场景。
- [Agent 场景用例](docs/Agent场景用例.md)将第二阶段需求展开为连续使用场景及评审标准；实际覆盖与未验证项见验证记录。
- [Agent 流程说明](docs/agent-flow.html)交互展示消息、上下文、模型工具、授权、事务与取消的完整过程。
- [Agent 运行模块](electron/agent/README.md)说明接口、代码入口、凭据与验证方式。
- [Agent 验证记录](docs/Agent验证记录.md)记录真实场景的程序结果、独立语义评审与覆盖范围。
- [设计规范](docs/设计规范.md)记录布局、视觉和浅深主题。
- [技术方案](docs/技术方案.md)记录技术边界和开发路线。
- [AGENTS.md](AGENTS.md)记录开发协作与模块定位规则。
