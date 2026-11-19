# 业务模型与操作

任务仅有名称 `title`、状态 `status`、预计开始 `startDate`、预计完成 `expectedDate`、说明 `description`、所属任务 `parentId` 六项用户属性，加上系统维护的 `id/version/updatedAt`。普通任务和子任务共用 `newTask(parentId?)` 与同一 schema。日期可空；业务入口校验有效日历日期及开始不晚于完成。说明承载目标、背景、进展等内容，不再保存旧独立字段。

安排独立于任务日期，安排、取消或阶段完成均不改预计起止日期。父子关系只表示包含，校验存在性与循环；不再维护结构化依赖。

Agent 动作与草稿均已使用新属性。childTaskSchema 从任务可编辑属性复用子任务字段，拆分时所属任务由父任务确定。子任务可仅提供名称，也可保存自己的说明、状态与预计起止日期。旧方案读取时将 children.goal 转入 description，新工具协议拒绝旧字段，避免静默丢失内容。子任务日期沿用普通任务校验。

`model.ts` 定义任务、按日期安排、方案、会话和有限 Command。`operations.ts` 是业务变更入口，返回独立的新状态，失败时原状态完整保留。任务版本用于识别旧方案，状态 revision 用于持久化并发校验。方案支持部分接受与幂等重试。

今日阶段完成只写 Arrangement，任务整体完成由用户单独设置。子任务完成不自动完成父任务。删除父任务会删除后代，界面必须明确展示此范围。

验证使用 `npm test`。Agent 动作复用同一业务入口和方案规则。

`agent.ts` 定义模型提交的有限动作协议与 `applyAgentTurn`。输入为当前会话、当前用户原文和完整结构化回复；输出为包含事实更新、已授权操作、待接受方案及助手回复的新状态。新任务可声明临时 `ref`，后续动作通过该引用关联，由应用分配实际 ID。`WorkspaceDatabase.commitAgentTurn` 在单次 SQLite 事务中保存整轮结果，失败保留原数据。

应用绑定本轮真实用户消息作为来源，工具参数仅需用 mode 表达每项授权状态。创建时机、授权、否定和指代由模型结合多轮对话判断，执行层校验结构、任务引用、会话归属、关系、版本和事务。方案按模型给出的具体变更 ID 逐项接受。用户原话保存在会话消息中，说明文字按需标明事实、暂估与推测。背景与停点通过 updateTask.patch.description 保存完整新文本，模型需保留仍有效的目标、事实和硬截止。

`updateArrangement` 通过原 taskId/date 指定已有安排，可选 targetTaskId 指定新归属，内部复用 schedule 方案并保存源与目标版本。接受时再次检查源安排存在，跨任务原子移除源安排并保存目标，修改同一任务范围保持排列顺序。

`model.ts` 的可选 `agentMemorySchema` 保存会话摘要和待创建内容，`applyAgentTurn` 随整轮提交保存。`context.ts` 组装当前会话记忆、近期消息和方案，`readConversation` 按游标向前分页读取同会话原文。旧会话无需增加字段即可读取。

关键验证见 `tests/agent-domain.test.ts`，包括自然确认、同轮引用、字段隔离、会话草拟和历史查询；工具顺序及失败修正见 `tests/agent-tools.test.ts`。

`capacity.ts` 以固定 15 分钟缓冲接收分钟为单位的可用时间和任务估时，返回总量、缺口、单项是否能放下及条件性分配。它负责算术，不替用户决定优先级，也不保证估时准确。由运行层的 `calculateCapacity` 工具调用，验证见 `tests/capacity.test.ts`。
