# 原型阶段验证

## 2026-11-21 任务重要性

`tests/task-fields.test.ts` 验证旧数据库兼容、保存时区分省略与清空、重开保留标注，以及 Agent 读取标注和写入限制。`tests/task-fields.desktop.mjs` 覆盖任务详情编辑、列表标注、筛选与搜索联用，以及切换筛选时的管理选择。

已通过 97 项离线测试、格式检查、类型检查、生产构建和五组 Electron 桌面回归。Agent 对标注的读取和写入限制通过离线验证，本轮未调用真实模型服务。

## 2026-11-21 第一阶段 Windows 安装包

隔离工作树中通过格式检查、95 项离线回归、类型检查、生产构建及五组 Electron 桌面回归。Windows 11 x64 本地生成 `xixu-0.1.0-windows-x64-setup.exe`，并用 `node tests/pack.smoke.mjs` 验证打包应用启动、Agent IPC、SQLite 和模型设置。安装向导和 GitHub 标签触发后的托管运行待验证。

## 2026-11-20 源码目录重构

应用源码移入 `src/` 下五个模块。模拟回复移入 `tests/fixtures/mock-agent.ts`，只供工作区测试。评审前跑通离线测试和桌面流程。一次并行评审核对实现边界、需求与文档，随后修正 Agent 授权流程示例并补齐验证记录。

评审后复测通过：

- `npm test` 的 95 项离线用例及 `npm run format:check`。
- Vite 开发服务启动 Electron，Vue 界面通过 preload 和 IPC 初始化隔离的 SQLite 工作区。
- `npm run test:desktop` 内的类型检查、生产构建及五组桌面脚本，覆盖任务、主题、对话、今日安排和重启恢复。
- `npm run pack` 与 `node tests/pack.smoke.mjs`。目录包可独立启动，Agent IPC、模型设置与 SQLite 可用。另用占位凭据验证 `safeStorage` 加密写入和重启读取。

桌面和打包检查使用隔离工作区。本轮真实模型回复质量沿用既有验证记录，复测使用模拟传输和占位凭据。

## 2026-11-18 今日安排版面

85 项离线回归通过。最终标准构建和 `node tests/today.desktop.mjs` 在只包含本次补丁的隔离副本通过，避免受并行聊天历史改动影响。Electron 使用隔离数据验证空状态、聚焦置顶、待推进排序、查看详情不抢焦点、完成后自动切换、全部完成与恢复阶段。复核了浅深主题与 800px 窄窗口，截图写入 `test-results/today-*.png`。未调用真实模型，未重打 Windows 发布包。

## 2026-11-18 Agent 编排审查与精简

提示词合并重复的创建、属性归属和工具提交说明。决策工具复用共享动作及记忆 schema，名称校验复用任务 schema，移除未使用的 quote 参数、重复工具白名单和回复结束时的重复内存预演。预演与 SQLite 最终事务仍分别验证业务动作。

新增一项回归检查模型未提交 prepareTurn 时不展示执行完成正文。85 项离线回归、类型检查、标准构建与完整桌面脚本通过。串行真实模型复验 B03、B04a、B04b 和 B06 四轮通过，原始结果在忽略的 `test-results/agent-behavior-review.json`。B04a 首次误用 changes 加空动作，在同一 SDK 循环收到校验反馈后修正。主开发复核了实际动作、状态和回复，核心行为通过，说明仍有重复叙述。完整性稳定性继续保留先前限制。

## 任务字段的 Agent 适配

创建、修改、拆分、会话草稿、工具回执与模拟回复均已使用精简字段。`npm test` 的 84 项回归、`npm run build` 及 `npm run test:desktop` 通过。新增用例覆盖六项属性、日期与安排隔离、子任务完整字段和非法日期回滚、父子临时引用、旧拆分读取、旧字段拒绝，以及最终正文输出 DSML 时整轮失败。桌面脚本同步更新表单定位、任务数据及当前聊天标题选择器，Agent 桌面用例另验证预计起止日期和说明在方案中可见、接受后写入且不产生每日安排。

真实模型的新字段场景记录在忽略的 `test-results/agent-fields*.json`，部分轮次正确落地，也出现已知说明或日期遗漏、子任务信息归入父任务及正文输出补充调用的问题。提示词已补充归属与一次完整提交的指导，运行层增加协议损坏保护。具体结果与保留限制见 `docs/Agent验证记录.md`。下文保留手动字段修订时尚未适配 Agent 的阶段记录。

## 2026-11-17 任务字段修订

`tests/task-fields.test.ts` 验证最小任务字段、普通/子任务一致、安排与起止日期隔离、日历与日期顺序校验、数据库 v1→v2 迁移、重开幂等与失败回滚。手动流程由 `tests/task-fields.desktop.mjs` 在隔离数据库中验证：只填名称保存、统一子任务表单、父子循环选项排除、独立日期、安排、重启、浅深主题及窄窗口；不发送消息、不调用模型。

本轮业务验证命令：`node --import tsx --test --test-skip-pattern="选择子任务后|模拟规划保持" tests/domain.test.ts tests/workspace.test.ts tests/store.test.ts tests/styles.test.ts tests/task-fields.test.ts`。32 项通过。该命令明确排除 workspace 中两项模拟 Agent 用例，未覆盖的 Agent 回归不计作通过。

桌面验证先用 `node node_modules/vite/bin/vite.js build` 转译，再运行 `node tests/task-fields.desktop.mjs`。这是本轮独立手动流程验证，不能替代完整类型检查/标准构建。真实 Agent、模拟回复及相应测试的旧字段引用按用户要求留待后续 AI 适配，当时 `npm run typecheck` 和 `npm run build` 不通过；原 `test:desktop` 的旧表单定位亦需后续更新。下面 74 项测试为字段修订前的历史验证范围。

本轮实际结果：32 项业务回归通过；Vite 转译构建通过；上述 Electron 手动任务流程通过，浅深主题与 800px 窄窗口截图已查看。全量类型检查失败位置仅在真实 Agent、模拟回复及 Agent 测试，未声称 Agent 或标准构建通过。未调用真实模型、未修改用户本地数据库，也未重新生成 Windows 发布包。

## 运行

- `npm test` 运行业务规则、SQLite、Pinia 队列和双主题配色回归。
- `npm run test:desktop` 构建并运行 Electron 交互验证（不含真实模型调用）。
- `node tests/review.desktop.mjs` 对已构建的应用执行独立审查场景。
- `node tests/agent-ui.desktop.mjs` 使用固定 IPC 流验证配置恢复、流式、取消与切会话，不调用真实模型。
- `npm run test:agent:live` 串行执行六条真实模型实验，会产生 API 调用，使用本地 `.env.agent.local`，脱敏业务结果写入忽略的 `test-results/agent-live.json`。
- `node tests/agent-real.desktop.mjs` 实际发送一次桌面对话并检查 SQLite 与重启，会产生 API 调用。
- `npm run test:agent:journey` 串行验证 S01 七轮连续对话，末轮使用序列化重读状态同日继续；会产生 API 调用，不能代替跨日和桌面重启检查。
- `npm run test:agent:behavior` 验证自然确认、自主标题、草拟承接、含糊指代、事实纠正和历史查询，会产生 API 调用。`XIXU_BEHAVIOR_FILTER` 支持逗号分隔的场景子串，语义结论需独立评审。
- `node tests/pack.smoke.mjs` 对生成的 Windows 目录包验证 Agent 入口、IPC 和凭据隔离。

桌面脚本通过 `XIXU_DATA_DIR` 使用隔离临时目录，截图及结果写入被忽略的 `test-results/`。受限环境启动 Electron 时可能需要允许本地子进程。

## 独立审查记录 · 2026-11-16

对照产品需求、设计规范和技术方案检查了业务实现与用例。原有 8 项业务用例和一段桌面流程覆盖了主要正常操作，日期切换、子任务聚焦、排队输入快照、校验和具体表面文字对比度存在覆盖缺口。

审查在真实 Electron 中复现并推动修复以下问题。

- 切换已有安排日期时，本次范围沿用其他日期内容，可能覆盖原范围。
- 选中子任务后启动协助仍使用父任务。
- 浅深主题部分辅助文字与用户消息正文低于 4.5:1。
- 通用 label 样式使任务搜索框竖向排列。

修复后独立重新运行 39 项业务 / 存储 / 状态 / 配色测试，全部通过。`review.desktop.mjs` 的实际界面断言通过，验证了系统主题实时变化、手选主题优先、草稿 / 消息 / 安排保持、已有日期范围联动、子任务聚焦、实际 DOM 文字对比度、800px 窄窗口和弹窗键盘焦点。浅深主题的今日安排、任务列表、任务弹窗及窄窗口截图已经人工查看。

## 阶段判断

首轮 Agent 回归为 57 项，2026-11-17 语义行为打磨后扩展为 74 项，新增真实 SDK 决策与回执顺序、会话记忆重开、自然确认、历史分页、安排原子替换及相同拆分接受记录复用回归。真实场景、连续对话及每次失败修复结果见 `docs/Agent验证记录.md`，程序断言与语义评审分别记录。既有原型审查记录保留其当时范围。

当前用例足以支持本地交互原型的受控试用与后续迭代。验收继续保留真实用户操作观察、不同 Windows 显示缩放、长时间使用及更大历史数据量的验证。AI API 接入后还需验证自然语言授权、事实提炼、规划质量、网络失败和真实流式取消。产品验收 A01–A14 的覆盖范围以 `docs/技术方案.md` 为准。
