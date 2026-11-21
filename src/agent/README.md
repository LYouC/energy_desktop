# Agent 运行服务

| 文件                       | 内容                                                                                                                       |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| [runtime.ts](runtime.ts)   | `generateAgentTurn` 用 AI SDK Core 的 `streamText` 执行工具循环。`AgentRuntime` 管理请求、运行事件、重试、取消和整轮提交。 |
| [prompt.ts](prompt.ts)     | 息序的角色、任务、行为指令与示例。                                                                                         |
| [config.ts](config.ts)     | `AgentConfig` 管理模型地址、模型名和凭据，公开视图只传出 Key 是否可用。                                                    |
| [turn.ts](turn.ts)         | 定义模型动作及整轮结果的 schema，通过 `applyAgentTurn` 把动作应用成业务状态。                                              |
| [context.ts](context.ts)   | 组装当前会话、任务和安排的上下文，按游标读取同会话历史。界面预览共用 `buildContext`。                                      |
| [capacity.ts](capacity.ts) | 根据分钟估时计算总量、缺口、单项容量和条件性分配，预留 15 分钟缓冲。                                                       |

本模块复用[领域模型与命令](../domain/README.md)。运行层接收工作区读写接口，由[桌面宿主](../desktop/README.md)接入 SQLite 和 IPC。配置从宿主接收凭据加密能力。

`prompt.ts` 按身份、任务、指导思想、每轮执行、要求和示例组织，将《反倦怠能量站》的能量感思路用于规划、启动、受阻与收尾。示例覆盖闲聊转建任务、部分接受、阶段收尾、容量冲突，以及不同阻力下的能量分析。结构依据见 [Agent 提示词调研](../../docs/Agent提示词调研.md)。95 项离线回归、五组 Electron 桌面回归、类型检查、生产构建与源码格式检查通过，真实模型表现待复验。

## 调用与数据流

界面通过有限 IPC 调用 `sendAgent({runId, sessionId, text, focusedId})`，订阅 `onAgentEvent` 的文本增量和状态，使用 `cancelAgent(runId)` 中止。模型设置通过 `agentConfig` 获取公开配置，通过 `configureAgent` 保存。公开配置只包含地址、模型和是否存在 Key。

用户消息先独立保存。服务读取最新任务、能量、背景、当前会话记忆与待接受方案，用真实 user/assistant 轮次传递近期对话。模型通过 `readTask` 查询任务、`readConversation` 向前翻阅同会话历史、`calculateCapacity` 核算时间。

每轮由模型调用 `prepareTurn({intent,actions,memory?})` 明确语义决定。纯交流选择 conversation 与空 actions，实际操作或正式方案选择 changes 与具体动作，每项 mode 单独表达是否已授权。程序在内存预演并返回回执，SDK 下一步关闭工具并生成自然语言终答。每次生成共用一套最多六步的工具循环。运行层对可重试的服务或网络故障最多退避重试三次，共享两分钟总时限；取消立即终止等待，业务校验和鉴权失败不会自动重试。额外同模型 review 试验未识别连续流程遗漏，已撤回，其结果保留在验证记录。

SiliconFlow 继续使用已验证的 `enable_thinking:false` 工具调用配置。本轮尝试服务默认推理时未得到可应用结果，尚未确认该模式的完整兼容性。参数说明见 [SiliconFlow 官方文档](https://docs.siliconflow.cn/docs/api/chat-completions-post)。

提交前比较任务、安排、方案、能量、偏好和会话工作记忆的快照。`WorkspaceDatabase.commitAgentTurn` 在一次事务中保存动作、方案、记忆和助手回复。成功回复使用运行标识生成持久化 ID，使重启后的同一请求能识别为已提交。

成功预演后的回复步骤支持流式预览，决策前和混合工具步骤中的文字留在模型循环中。取消、超时、异常协议或模型失败会结束本轮，保留已保存的用户消息。业务变更、记忆与助手回复通过最后的 SQLite 事务统一保存，成功的请求可在重启后恢复识别。

## 工具与业务边界

| 模型工具            | 职责                                                   |
| ------------------- | ------------------------------------------------------ |
| `readTask`          | 按 ID 查看任务、子任务和历史安排                       |
| `readConversation`  | 按游标读取当前会话更早的原话                           |
| `calculateCapacity` | 计算可用时间、任务估时和缓冲的容量关系                 |
| `prepareTurn`       | 提交 intent、actions 及可选 memory，预演后返回业务回执 |

`prepareTurn.actions` 支持八种动作。`createTask` 创建任务，`updateTask` 修改属性与说明，`split` 拆分子任务，`schedule` 新增安排或移期，`updateArrangement` 修改已有安排，`unschedule` 取消安排，`stage` 完成或恢复当日阶段，`resolve` 接受或拒绝方案条目。它们共用同一业务应用器。

`turn.ts` 定义这些动作。创建时机、用户授权、否定、指代和接受范围由模型结合对话语义判断，应用自动绑定真实用户消息作为来源，程序校验结构、ID、会话归属、版本及业务一致性。新增计划建议保存为待接受方案，已授权操作直接执行。

创建和修改的 patch 及会话 taskDraft 使用 `title/status/startDate/expectedDate/description/parentId`，工具回执与草稿展示同步返回预计日期和说明。`split.children` 支持名称、说明、状态和预计日期，父任务由 split.taskId 确定。`createTask.ref` 可供同批动作的 taskId 和 patch.parentId 引用。持久化层读取旧拆分时将 goal 转入说明，模型工具对旧字段报错，供同一循环修正。上下文和 `readTask` 提供用户标注的 `importance`，供规划时参考。标注由任务编辑器写入。

信息收集由通用提示词指导。优先提炼已有对话，自主概括标题和说明，按明确反馈判断状态。关键未知信息有价值时简短询问，用户跳过或信息足够时及时创建。预计起止日期独立于每日安排，明确安排通过 schedule 执行。硬截止、具体钟点、背景与停点按需写入说明，`updateTask.patch.description` 应合并仍有效的内容后提交完整文本。任务优先级可在分析时判断。

模型偶尔在关闭工具后把补充动作写为 DSML 正文。运行层识别该协议损坏并让整轮失败，事务不会保存该轮业务动作。该检查只校验回复格式，完整性与事实质量继续通过真实场景评审。预演回执以任务名称表达新建归属，避免将预演 ID 记成最终提交后的真实 ID。

决策工具复用共享回复协议中的 actions 和 memory schema。任务名称规则复用任务模型，授权来源由应用记录，模型无需提供 quote 参数。预演与最终事务各执行一次业务应用，生成服务在回复结束后直接返回已验证动作。

修改已有安排使用 `updateArrangement` 明确引用原安排，支持通过 targetTaskId 转由子任务或其他任务承接。工具一次完成源安排移除与目标安排保存，版本或来源失效时整轮回滚，避免把修改范围误成另一条新增安排。

`session.agentMemory` 可选保存模型整理的 summary 和待创建 taskDraft，兼容旧会话。草拟内容处于协商中，模型决定创建后，应用在同名草拟实际落地时清除待创建状态，事务失败会整体回滚。模型已生成的草稿标题缺失于正文时会补充展示，草拟也可以通过已持久化的聊天正文承接。`readConversation` 用消息 ID 游标分页，每页最多四十条，同会话原话可用于核实摘要。记忆的事实质量和语义判断仍通过真实场景评审。

## 配置与验证

开发时本地 `.env.agent.local` 可提供 `XIXU_API_KEY`、`XIXU_BASE_URL`、`XIXU_MODEL`。文件由 Git 忽略，正式目录包通过模型设置配置。Key 使用 Electron `safeStorage` 加密后写入 userData 的 `model-config.json`。服务地址更换要求对应 Key，地址使用 HTTPS。SDK 默认错误打印已关闭，界面接收脱敏错误。

`npm test` 检查领域、SQLite、运行边界及真实 SDK 工具编排，`npm run test:desktop` 检查桌面交互。`npm run test:agent:live` 和 `npm run test:agent:behavior` 串行调用实际模型，会消耗 API 额度。结果保存在忽略的 `test-results/`，行为用例支持逗号分隔的 `XIXU_BEHAVIOR_FILTER`。真实模型评估同时检查程序断言和回复质量。

完整流程可打开 [交互说明](../../docs/agent-flow.html)。
