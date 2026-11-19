# 桌面与保存

`main.ts` 管理窗口与有限 IPC，`preload.ts` 暴露明确方法。手动操作通过 `WorkspaceDatabase.execute` 写入，Agent 整轮通过 `commitAgentTurn` 原子写入，参数在业务层经 Zod 校验。界面隔离 Node，禁止打开外部窗口与页面跳转。

`storage.ts` 使用 Electron 内置 Node 的 `node:sqlite`。原型将工作区保存为一条带版本的 JSON 记录，事务同时提交任务、方案与接受状态，避免过早引入复杂数据映射。数据库位于 Electron userData 下的 `workspace.db`。可通过 `XIXU_DATA_DIR` 指定隔离验证目录。数据库和会话不能提交。

模式版本为 2。`migrations.ts` 将 v1 任务的目标、背景、进展、阻力、下一步、硬截止和前提要求合入说明，保留预计完成日期；旧推进日期不推断为开始日期。迁移与版本更新在同一事务中完成，失败回滚，重开不重复执行。保留任务、安排、会话和输入草稿；旧待接受方案失效，清除旧待创建任务草稿，避免旧字段操作悄悄丢失。无需清空数据库，也未直接操作用户本地数据库，实际在升级后打开时迁移。

验证见 `tests/task-fields.test.ts`，包括迁移、失败回滚、重开与日期独立性；桌面手动交互见 `tests/task-fields.desktop.mjs`。Agent 已完成新字段适配，类型检查、标准构建与 `npm test` 回归通过。模型提取质量的实际验证范围见 `../docs/Agent验证记录.md`，接口和凭据边界见 `agent/README.md`。
