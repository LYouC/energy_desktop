# 开源 Electron 项目目录对照

2026-11-19 核对上游源码、构建配置及发布记录。本文保留目录重构前的对照依据，当前架构以 [技术方案](技术方案.md) 为准。上游源码链接固定到所查提交。

## 息序重构前怎么组织

重构前，根目录 `src/` 是 Vue 渲染端，包含工作台、组件和 Pinia 状态。根目录 `electron/` 包含两个构建入口 `main.ts` 和 `preload.ts`，也包含主进程使用的 SQLite、迁移、Agent 运行与凭据管理。根目录 `shared/` 存放任务与会话模型、Zod 校验、业务变更规则和纯计算。比如渲染端工作区 store 使用 `shared/model.ts` 初始化状态，主进程同样使用其中的命令 schema。三个目录在桌面工程的初始化提交 `b2fa2b3` 已经存在。 [构建配置](../vite.config.ts) · [渲染端 store](../src/renderer/stores/workspace.ts) · [桌面入口](../src/desktop/main.ts) · [业务模型与操作](../src/domain/README.md)

Electron 主进程和渲染进程有各自的运行上下文。preload 是加载到渲染进程中的桥接脚本，启用上下文隔离时与页面处在不同的 JavaScript 上下文。比如息序的数据库写入由主进程处理，页面通过 preload 暴露的方法发起 IPC，`shared/` 提供两侧可以各自导入的代码。 [Electron 进程模型](https://www.electronjs.org/docs/latest/tutorial/process-model) · [上下文隔离](https://www.electronjs.org/docs/latest/tutorial/context-isolation) · [preload](../src/desktop/preload.ts) · [SQLite 实现](../src/persistence/storage.ts)

## 上游项目对照

| 项目 | 应用源码与构建入口 | 可借鉴的做法 |
| --- | --- | --- |
| electron-vite-vue 脚手架 | 根层 `src/` 放 Vue 界面，`electron/main/index.ts` 和 `electron/preload/index.ts` 是独立入口。当前快照的 Vite 配置使用 `vite-plugin-electron/multi-env` 中的 `electronSimple`，分别输出至 `dist-electron/main` 和 `dist-electron/preload`。 | 与息序的根层分法最接近。两个入口可以各自扩展成子目录，目录调整由构建配置显式接线。 [脚手架说明](https://github.com/electron-vite/electron-vite-vue/tree/8c395cda3755d542c6f90a23b1ce3e82ae440b0b) · [Vite 配置](https://github.com/electron-vite/electron-vite-vue/blob/8c395cda3755d542c6f90a23b1ce3e82ae440b0b/vite.config.ts) |
| massCode，本地优先开发工具 | Vite 的 Vue 渲染根是 `src/renderer/`。`build:main` 用 TypeScript 编译 `src/main/` 和 `src/shared/`，窗口由 `src/main/index.ts` 加载同目录编译出的 `preload.js`。当前发布记录中的 6.x 采用 Markdown Vault。 | 实际应用中与息序的技术栈和本地使用模式最接近。所有源码可收进同一个 `src/`，薄 preload 入口也可以与主进程入口相邻。 [Vite 配置](https://github.com/massCodeIO/massCode/blob/63e11423fdf4ca8b54a1d9b0ab6b68f444074698/vite.config.mjs) · [构建脚本](https://github.com/massCodeIO/massCode/blob/63e11423fdf4ca8b54a1d9b0ab6b68f444074698/package.json) · [主进程 TypeScript 配置](https://github.com/massCodeIO/massCode/blob/63e11423fdf4ca8b54a1d9b0ab6b68f444074698/tsconfig.main.json) · [窗口入口](https://github.com/massCodeIO/massCode/blob/63e11423fdf4ca8b54a1d9b0ab6b68f444074698/src/main/index.ts) · [v6.0.0 发布记录](https://github.com/massCodeIO/massCode/releases/tag/v6.0.0) · [v6.3.1 发布记录](https://github.com/massCodeIO/massCode/releases/tag/v6.3.1) |
| MarkText，Markdown 编辑器 | 桌面应用在 `packages/desktop/`，内部为 `src/main/`、`src/preload/`、`src/renderer/`、`src/shared/` 等。使用 `electron-vite`，渲染端用 Vue 3 和 Pinia。编辑器核心 Muya 另有工作区包。 | 窗口设置隔离和 sandbox，preload 从 `@shared/types/ipc` 复用跨进程协议。可参考 IPC 契约的归属，按息序自身的规模选目录。 [架构说明](https://github.com/marktext/marktext/blob/e4ed4cf4a3deafb81817987e9b3653f57031f6c8/AGENTS.md) · [构建配置](https://github.com/marktext/marktext/blob/e4ed4cf4a3deafb81817987e9b3653f57031f6c8/packages/desktop/electron.vite.config.ts) · [窗口配置](https://github.com/marktext/marktext/blob/e4ed4cf4a3deafb81817987e9b3653f57031f6c8/packages/desktop/src/main/config.ts) · [preload](https://github.com/marktext/marktext/blob/e4ed4cf4a3deafb81817987e9b3653f57031f6c8/packages/desktop/src/preload/index.ts) · [发布记录](https://github.com/marktext/marktext/releases) |
| Cherry Studio，AI 桌面应用 | `src/main/`、`src/preload/`、`src/renderer/`、`src/shared/` 并列。`electron-vite` 配置列出多个 preload 和多个窗口 HTML 入口，渲染端使用 React。 | preload 直接从 `@shared` 导入 IPC 通道、类型和部分运行时辅助代码。多个实际桥接入口为独立的 `preload/` 提供了明确用途。 [构建配置](https://github.com/CherryHQ/cherry-studio/blob/ec30a61b649f6cd944713276a57ca6ccec799873/electron.vite.config.ts) · [preload](https://github.com/CherryHQ/cherry-studio/blob/ec30a61b649f6cd944713276a57ca6ccec799873/src/preload/preload.ts) · [v2.2.2 发布记录](https://github.com/CherryHQ/cherry-studio/releases/tag/v2.2.2) |

脚手架用的 `vite-plugin-electron` 与 MarkText、Cherry Studio 使用的 `electron-vite` 是两个构建工具。后者有按 `src/main`、`src/preload`、`src/renderer` 查找入口的默认约定，息序目前则在 Vite 配置中显式设置主进程与 preload 入口。目录名称表达职责，真正决定入口和产物位置的是本项目的构建配置。 [vite-plugin-electron 文档](https://github.com/electron-vite/vite-plugin-electron) · [electron-vite 入口约定](https://electron-vite.org/guide/dev.html) · [息序构建配置](../vite.config.ts)

## 调研时的建议（重构前）

调研时只有一个工作台窗口和一个薄 preload 入口。短期可沿用根层 `src/`、`electron/`、`shared/`，以明确职责边界为主。当前源码已归入统一的 `src/`，入口见 [模块索引](../AGENTS.md#已落地模块索引)。

| 目录 | 应放的代码 |
| --- | --- |
| `src/` | Vue 组件、Pinia 状态和用户交互。需要读写桌面数据时调用 preload 提供的 API。 |
| `electron/` | `main.ts` 管窗口与 IPC，`preload.ts` 暴露有限方法。SQLite 和迁移、模型服务调用、凭据以及 Agent 工具执行由主进程侧负责。 |
| `shared/` | 按需共用的类型、可序列化数据、schema 和纯业务规则。引入运行时依赖前核对相应构建目标是否支持。 `shared/agent.ts` 负责动作协议及动作应用，模型连接和调度在 `electron/agent/`。 |

主进程职责增加时，可以先在 `electron/` 按职责增加子目录。例如 IPC 处理持续挤占窗口启动代码时，再提取独立的 IPC 注册模块。出现多个窗口需要不同桥接能力时，再考虑 `electron/preload/`。若将来确实需要统一源码根，`src/main/`、`src/preload/`、`src/renderer/`、`src/shared/` 能表达同样的边界。 [桌面模块说明](../src/desktop/README.md) · [Agent 模块说明](../src/agent/README.md)

若实施目录移动，同步核对 Vite 入口与别名、TypeScript 收录范围、渲染端 HTML 入口和测试导入。只要产物路径发生变化，还需核对窗口加载的 preload 和 HTML、`package.json` 的主入口和打包文件清单。先运行 `npm test` 与 `npm run build`，再通过桌面脚本核对 IPC 和重启恢复。若打包配置或产物路径有变动，再运行 `npm run pack` 并独立启动目录包。 [项目开发命令](../README.md) · [打包与测试配置](../package.json) · [窗口加载代码](../src/desktop/main.ts) · [类型检查配置](../tsconfig.json)
