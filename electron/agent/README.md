# Agent 运行服务

`runtime.ts` 使用 AI SDK Core 的 `streamText` 作为唯一工具循环，`prompt.ts` 保存行为指令，`config.ts` 管理用户模型配置和系统保护的凭据。

## 调用与数据流

界面通过有限 IPC 调用 `sendAgent({runId, sessionId, text, focusedId})`，订阅 `onAgentEvent` 的文本增量和状态，使用 `cancelAgent(runId)` 中止。模型设置通过 `agentConfig` 获取公开配置，通过 `configureAgent` 保存。公开配置只包含地址、模型和是否存在 Key。

用户消息先独立保存。服务再读取最新能量、未完成任务、背景、近期消息和待接受方案。模型可以用 `readTask` 查询完整任务，用 `calculateCapacity` 核算时间总量和条件性分配，再通过 `submitTurn` 暂存完整回复和动作。工具调用失败可在同一循环内修正，循环最多六步，每轮最多两分钟，网络自动重试为零。指定 SiliconFlow 服务关闭扩展思考以验证工具执行流程。

完整结果经 `shared/agent.ts` 在内存预演。提交前比较任务、安排、方案、能量和偏好的快照，防止分析期间的数据变化被旧结果覆盖。草稿和主题变化允许本轮继续。`WorkspaceDatabase.commitAgentTurn` 在一次事务中保存本轮动作、待接受方案和助手回复。成功回复使用运行标识生成持久化 ID，使重启后的同一请求也能识别为已提交。

文本流和工具参数中的回复前缀只用于临时预览。用户取消、超时或网络失败后，本轮业务数据和方案不会提交，用户原消息保留。事务已成功的结果通过数据库恢复。

## 业务与授权边界

`shared/agent.ts` 定义有限动作，包括创建、修改、背景、安排、取消安排、阶段完成、拆分和方案接受。模型不直接获得 SQLite、系统命令或任意工作区 Command。新增建议保存为待接受方案，明确授权的变更直接执行。每个动作引用当前用户原文，校验器检查引用、动作类型、否定表达、会话归属和业务规则。

原文和动作词校验只提供有限防护，自然语言中的对象、范围和授权仍依赖模型理解，必须结合连续场景验证。不能宣称这套词法校验能够证明任意自然语言授权正确。当前背景仍按任务保存一份文本、分类和最近来源，逐条事实记忆、长期会话摘要和复杂跨方案依赖尚待后续扩展。

## 配置与验证

开发时本地 `.env.agent.local` 可提供 `XIXU_API_KEY`、`XIXU_BASE_URL`、`XIXU_MODEL`。文件由 Git 忽略，正式目录包通过模型设置配置。Key 使用 Electron `safeStorage` 加密后写入 userData 的 `model-config.json`。服务地址更换要求对应 Key，地址使用 HTTPS。SDK 默认错误打印已关闭，界面接收脱敏错误。

`npm test` 检查领域和运行边界，`npm run test:desktop` 检查桌面交互。`npm run test:agent:live` 串行调用实际配置模型，会消耗 API 额度，结果在忽略的 `test-results/agent-live.json`。可用 `XIXU_LIVE_FILTER` 只运行名称匹配的场景。真实模型评估需要同时检查程序断言和回复质量。

完整流程可打开 [交互说明](../../docs/agent-flow.html)。
