# 桌面宿主

本模块在 Electron 中启动应用，把界面请求连接到 Agent 和持久化模块。涉及窗口、应用生命周期、IPC 或系统凭据保护时，从这里查找。

| 文件                     | 内容                                                                                                                                                                                                        |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [main.ts](main.ts)       | 主进程入口。配置数据目录和单实例锁，创建窗口、注册 IPC，按需打开 SQLite，并在退出时关闭连接。这里装配 `AgentRuntime` 的本地日期、读取、执行和整轮提交函数，并把 Electron `safeStorage` 传给 `AgentConfig`。 |
| [preload.ts](preload.ts) | 通过 `contextBridge` 暴露 `window.desktop`。工作区支持读取和提交命令，Agent 支持读取及保存模型配置、发送、取消、订阅流事件。订阅函数返回解绑函数。                                                          |

## 调用与构建

- 窗口启用上下文隔离和 sandbox，关闭 Node 集成，拒绝页面导航和新窗口。界面通过 preload 发送请求，主进程校验版本和命令后交给持久化模块。Agent 流事件回传至发起请求的窗口。
- 开发时加载 Vite 服务，构建后加载 `dist/index.html`。Vite 分别产出 `dist-electron/main.js` 和 `dist-electron/preload.mjs`，应用入口由根目录 `package.json` 指定。
- 默认使用 Electron 的 userData 目录。开发和测试可用 `XIXU_DATA_DIR` 指定独立目录。未打包时可读取仓库根的本地模型环境配置。

运行 `npm run test:desktop` 验证窗口、桥接、主要交互和重启恢复。打包后可运行 `node tests/pack.smoke.mjs` 验证便携目录独立启动。

相关模块见 [工作台界面](../renderer/README.md)、[Agent](../agent/README.md)和[持久化](../persistence/README.md)。
