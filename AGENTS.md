
# 项目目标

开发“息序”桌面 Agent Todo：通过对话理解目标与背景，拆分大任务、协商每日安排，并帮助用户应对启动困难、受挫和精力变化。当前仓库包含桌面交互原型与首轮真实 Agent，实际完成和验证范围见 README 与技术方案。

## 接手顺序

先读 `README.md` 了解项目状态，再按当前任务查阅 `docs/产品需求.md`、`docs/设计规范.md` 和 `docs/技术方案.md` 的相关章节。外观参考 `design/index.html` 与 `design/style.css`；`design/archive/` 仅为历史，不作为当前需求。行为以产品需求为准，不能把示例数据当成固定规则。

## 模块划分与定位

- 开发时必须按职责划分模块，明确各自负责的行为和对外接口。模块落地后，在本文件维护一份简短索引，记录模块职责、代码入口和说明位置。新增重要模块时，用短 README 记录接口、边界和验证方式。
- 接手需求或修复时，优先通过模块索引定位相关模块，再查看该模块的入口和说明，开展开发。涉及跨模块行为或归属不清时，再沿调用关系扩大查找范围。

## 已落地模块索引

| 模块 | 职责 | 入口与说明 |
| --- | --- | --- |
| 业务模型与操作 | 任务、阶段安排、方案接受、关系校验、能量与会话操作 | `shared/model.ts`、`shared/operations.ts`；`shared/README.md` |
| 桌面与本地保存 | 隔离 IPC、SQLite 事务及版本检查 | `electron/main.ts`、`electron/storage.ts`；`electron/README.md` |
| 工作台 | 三栏、任务详情、今日安排、双主题与界面状态 | `src/App.vue`、`src/stores/workspace.ts`；`src/README.md` |
| 模拟会话与上下文 | 模板回复、方案展示、会话与草稿、上下文预览 | `src/components/ChatPanel.vue`、`src/features/mock.ts`；`src/features/README.md` |
| Agent 运行与模型配置 | AI SDK 单循环、语义决策、历史查询与会话记忆、工具回执与整轮提交、系统保护凭据 | `electron/agent/runtime.ts`、`shared/agent.ts`、`shared/context.ts`、`src/components/ModelSettings.vue`；`electron/agent/README.md` |

## 约束

- 使用 Vue 3、TypeScript、Vite、Pinia、shadcn-vue、Tailwind CSS、Electron、Vercel AI SDK Core、SQLite。个人使用，用户自配模型 API Key；不重开框架选型，不叠加第二套 Agent 循环。
- 左侧是导航。“所有任务”在主工作区显示简洁列表，与详细“今日安排”切换；不在左侧列任务。不引入外部 Todo、收集箱或“接下来”。任务图留待未来。
- 能量采用离散状态。手动改状态只更新数据；用户主动发送消息后才分析。AI 主动提出的计划修改先协商，用户已明确授权的操作不重复确认。
- 正式应用必须支持浅色、深色主题切换；遵守设计规范，不用整页反色替代主题设计。
- 保持代码简洁、整齐、规范。
- 用户关注需求与结果，授予日常设计和实现自主权。按文档中可逆默认值继续推进；遇到影响范围、核心交互或授权规则的真实歧义，直接提出具体问题，先弄清楚再实现，不能擅自改目标。
- 不提交 Key、用户数据库、私人会话或构建产物。按变更验证关键行为；交接时更新文档中的真实进度、假设与未验证项，不声称完成未实现的功能。
