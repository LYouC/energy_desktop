# 桌面与保存

`main.ts` 管理窗口与有限 IPC，`preload.ts` 暴露明确方法。手动操作通过 `WorkspaceDatabase.execute` 写入，Agent 整轮通过 `commitAgentTurn` 原子写入，参数在业务层经 Zod 校验。界面隔离 Node，禁止打开外部窗口与页面跳转。

`storage.ts` 使用 Electron 内置 Node 的 `node:sqlite`。原型将工作区保存为一条带版本的 JSON 记录，事务同时提交任务、方案与接受状态，避免过早引入复杂数据映射。数据库位于 Electron userData 下的 `workspace.db`。可通过 `XIXU_DATA_DIR` 指定隔离验证目录。数据库和会话不能提交。

验证使用 `npm test`，桌面端再通过 Electron 实际验证驱动、IPC 和重启恢复。模式版本为 1，后续结构变化需编写迁移，不能清空用户数据。真实模型与系统加密凭据已接入，接口和边界见 `agent/README.md`。
