# Agent 运行服务

`runtime.ts` 使用 AI SDK Core 的 `streamText` 作为唯一工具循环，`prompt.ts` 保存行为指令，`config.ts` 管理用户模型配置和系统保护的凭据。

## 调用与数据流

界面通过有限 IPC 调用 `sendAgent({runId, sessionId, text, focusedId})`，订阅 `onAgentEvent` 的文本增量和状态，使用 `cancelAgent(runId)` 中止。模型设置通过 `agentConfig` 获取公开配置，通过 `configureAgent` 保存。公开配置只包含地址、模型和是否存在 Key。

用户消息先独立保存。服务读取最新任务、能量、背景、当前会话记忆与待接受方案，用真实 user/assistant 轮次传递近期对话。模型通过 `readTask` 查询任务、`readConversation` 向前翻阅同会话历史、`calculateCapacity` 核算时间。

每轮由模型调用 `prepareTurn({intent,actions,memory?})` 明确语义决定。纯交流选择 conversation 与空 actions，实际操作或正式方案选择 changes 与具体动作，每项 mode 单独表达是否已授权。程序在内存预演并返回回执，SDK 下一步关闭工具并生成自然语言终答。准备和答复共用一套工具循环，最多六步、两分钟，网络自动重试为零。每轮至少包含决策和答复两个模型步骤。额外同模型 review 试验未识别连续流程遗漏，已撤回，其结果保留在验证记录。

SiliconFlow 继续使用已验证的 `enable_thinking:false` 工具调用配置。本轮尝试服务默认推理时未得到可应用结果，尚未确认该模式的完整兼容性。参数说明见 [SiliconFlow 官方文档](https://docs.siliconflow.cn/docs/api/chat-completions-post)。

提交前比较任务、安排、方案、能量、偏好和会话工作记忆的快照。`WorkspaceDatabase.commitAgentTurn` 在一次事务中保存动作、方案、记忆和助手回复。成功回复使用运行标识生成持久化 ID，使重启后的同一请求能识别为已提交。

准备完成后的最终回复支持文本前缀预览，纯交流在独立回复步骤完成时发出正文。混合工具步骤里被丢弃的回复草稿不会进入预览。用户取消、超时或网络失败后，本轮业务数据和方案不会提交，用户原消息保留。事务已成功的结果通过数据库恢复。

## 业务与授权边界

`shared/agent.ts` 定义创建、修改、安排、取消安排、阶段完成、拆分和方案接受等有限动作。创建时机、用户授权、否定、指代和接受范围由模型结合对话语义判断，应用自动绑定真实用户消息作为来源，程序校验结构、ID、会话归属、版本及业务一致性。关键词与逐字抄写不参与执行拦截。新增计划建议保存为待接受方案，已授权操作直接执行。

任务与子任务使用 `title/status/startDate/expectedDate/description/parentId`。创建和修改的 patch 及会话 taskDraft 使用这些字段，工具回执与草稿展示同步返回预计日期和说明。`split.children` 支持名称、说明、状态和预计日期，父任务由 split.taskId 确定。`createTask.ref` 可供同批动作的 taskId 和 patch.parentId 引用。持久化层读取旧拆分时将 goal 转入说明，模型工具对旧字段报错，供同一循环修正。

信息收集由通用提示词指导。优先提炼已有对话，自主概括标题和说明，按明确反馈判断状态。关键未知信息有价值时简短询问，用户跳过或信息足够时及时创建。预计起止日期独立于每日安排，明确安排通过 schedule 执行。硬截止、具体钟点、背景与停点按需写入说明，`updateTask.patch.description` 应合并仍有效的内容后提交完整文本。任务优先级可在分析时判断。

模型偶尔在关闭工具后把补充动作写为 DSML 正文。运行层识别该协议损坏并让整轮失败，事务不会保存该轮业务动作。该检查只校验回复格式，完整性与事实质量继续通过真实场景评审。预演回执以任务名称表达新建归属，避免将预演 ID 记成最终提交后的真实 ID。

修改已有安排使用 `updateArrangement` 明确引用原安排，支持通过 targetTaskId 转由子任务或其他任务承接。工具一次完成源安排移除与目标安排保存，版本或来源失效时整轮回滚，避免把修改范围误成另一条新增安排。

`session.agentMemory` 可选保存模型整理的 summary 和待创建 taskDraft，兼容旧会话。草拟内容处于协商中，模型决定创建后，应用在同名草拟实际落地时清除待创建状态，事务失败会整体回滚。模型已生成的草稿标题缺失于正文时会补充展示，草拟也可以通过已持久化的聊天正文承接。`readConversation` 用消息 ID 游标分页，每页最多四十条，同会话原话可用于核实摘要。记忆的事实质量和语义判断仍通过真实场景评审。

## 配置与验证

开发时本地 `.env.agent.local` 可提供 `XIXU_API_KEY`、`XIXU_BASE_URL`、`XIXU_MODEL`。文件由 Git 忽略，正式目录包通过模型设置配置。Key 使用 Electron `safeStorage` 加密后写入 userData 的 `model-config.json`。服务地址更换要求对应 Key，地址使用 HTTPS。SDK 默认错误打印已关闭，界面接收脱敏错误。

`npm test` 检查领域、SQLite、运行边界及真实 SDK 工具编排，`npm run test:desktop` 检查桌面交互。`npm run test:agent:live` 和 `npm run test:agent:behavior` 串行调用实际模型，会消耗 API 额度。结果保存在忽略的 `test-results/`，行为用例支持逗号分隔的 `XIXU_BEHAVIOR_FILTER`。真实模型评估同时检查程序断言和回复质量。

完整流程可打开 [交互说明](../../docs/agent-flow.html)。
