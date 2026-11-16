# 息序 · Energy Desktop

通过对话理解任务、形成背景、拆分目标并协商每日安排的桌面应用。目标是帮助用户更舒服地推进重要的事，同时考虑精力消耗、受挫与恢复。

## 当前状态

本地交互原型已建立，包含任务与子任务、按日期安排、阶段与整体进度、背景与偏好、模拟方案部分接受、上下文预览、会话草稿、SQLite 保存及浅深主题。Windows 窗口、受控 IPC、类型检查、构建和桌面流程已经验证。AI API 留待后续接入。

当前从空工作区开始。点击“记下一件事”输入任务，在任务详情中安排日期与阶段目标；右侧快捷入口可试操作拆分、安排与部分接受。模拟回复使用固定模板，任务事实由用户在详情中维护。真实自然语言理解、自动背景提炼、容量判断及个性化规划仍待模型接入验证。

## 开发运行

使用 Node.js 24 LTS，执行 `npm ci` 安装锁定依赖。

- `npm run dev` 启动 Vite 与 Electron 开发窗口。
- `npm run build` 执行类型检查并构建。
- `npm start` 打开构建后的桌面应用。
- `npm test` 验证关键业务规则。
- `npm run test:desktop` 构建并实际操作 Electron，验证主要交互及重启恢复。
- `npm run format:check` 检查源码格式。
- `npm run pack` 构建 Windows 便携目录。

开发分支采用 `codex/desktop-prototype`，每个可验证阶段独立提交。便携开发工具、数据库及构建产物由 `.gitignore` 排除。

任务、会话及设置保存在 Electron userData 的 `workspace.db`。验证脚本使用隔离的临时目录，截图在 `test-results/`。设置 `XIXU_DATA_DIR` 可指定独立的数据目录。主题首屏缓存只保存主题选项。

## 试用 Windows 原型

运行 `npm run pack` 后打开 `release/win-unpacked/息序.exe`。当前目录包已经独立启动验证，移动时需保留整个 `win-unpacked` 目录。原型使用无签名目录包。

Electron 首次运行会下载桌面运行文件。下载受网络环境影响时，可在当前 PowerShell 会话设置 `$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'` 后重试 `npm start` 或 `npm run pack`。镜像为可选环境设置。

## 查看设计稿

在浏览器打开 [浅色设计稿](design/index.html) 即可查看，样式文件随设计稿保存在同一目录。

## 项目文档

- [产品需求](docs/产品需求.md)记录产品行为、原型要验证的问题和验收场景。
- [设计规范](docs/设计规范.md)记录布局、视觉和浅深主题。
- [技术方案](docs/技术方案.md)记录技术边界和开发路线。
- [AGENTS.md](AGENTS.md)记录开发协作与模块定位规则。
