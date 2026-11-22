# 业务模型与操作

| 文件                                 | 内容                                                              |
| ------------------------------------ | ----------------------------------------------------------------- |
| [model.ts](model.ts)                 | 任务、安排、方案、工作区和命令的 Zod schema、类型及初始值。       |
| [operations.ts](operations.ts)       | `applyCommand` 校验并应用任务、安排、方案、能量、偏好与会话命令。 |
| [recurrence.ts](recurrence.ts)       | 计算重复规则的下一次日期，结算过去和当天的实例。                  |
| [conversations.ts](conversations.ts) | 通过最近活动时间组织可见历史，处理会话删除及保留上限。            |

界面、Agent 与持久化共用这些规则。调用方负责获取当前状态和保存操作结果。

任务属性包括名称 `title`、状态 `status`、重要性 `importance`、预计开始 `startDate`、预计完成 `expectedDate`、说明 `description`、所属任务 `parentId`，以及系统维护的 `id/version/updatedAt`。普通任务和子任务共用 `newTask(parentId?)` 与同一 schema。日期可空，业务入口校验有效日历日期及开始不晚于完成。说明承载目标、背景和进展等内容。

重要性取 `high`、`medium`、`low` 或 `null`，已有数据缺失时读取为 `null`。用户通过 `saveTask` 编辑标注，显式传入 `null` 清空标注。省略该字段的旧版命令沿用已有标注。

安排独立于任务日期，安排、取消或阶段完成均不改预计起止日期。父子关系只表示包含，校验存在性与循环；不再维护结构化依赖。

Agent 动作与草稿均已使用新属性。childTaskSchema 从任务可编辑属性复用子任务字段，拆分时所属任务由父任务确定。子任务可仅提供名称，也可保存自己的说明、状态与预计起止日期。旧方案读取时将 children.goal 转入 description，新工具协议拒绝旧字段，避免静默丢失内容。子任务日期沿用普通任务校验。

`model.ts` 定义任务、按日期安排、方案、会话和有限 Command。`operations.ts` 是业务变更入口，返回独立的新状态，失败时原状态完整保留。任务版本用于识别旧方案，状态 revision 用于持久化并发校验。方案支持部分接受与幂等重试。

今日阶段完成只写 Arrangement，任务整体完成由用户单独设置。子任务完成不自动完成父任务。删除父任务会删除后代，界面必须明确展示此范围。

重复模板在任务中保存 `recurrence`，支持每天、每周自选星期和起止日期内每天。`synchronizeRecurrence(state, date)` 按本地日期结算到当天。每个模板每日至多一条实例，同日已有安排沿用原位置、范围与完成状态。实例保存当时的名称，跨日后未完成的实例显示为错过。规则编辑从次日生效。

当天的实例可以完成、调序、修改范围或移除。移除单独保存当天能撤销所需的数据，实例随即从队列和历史统计移除。删除模板会停止后续生成，已产生的实例仍可查询，今天这次仍可操作。普通任务与子任务的级联删除同样保留已产生的重复实例。Agent 的动作协议暂时只允许使用普通任务的写规则。

验证使用 `npm test`。Agent 动作复用同一业务入口和方案规则。

`conversations.ts` 以最近活动时间排序，最多保留 1000 个会话。工作区 schema 允许旧会话省略 `agentMemory`。Agent 动作的授权语义、工作记忆与历史查询由 [Agent 模块](../agent/README.md)说明。

`npm test` 中的 `domain.test.ts`、`workspace.test.ts`、`conversations.test.ts` 和 `task-fields.test.ts` 覆盖状态变更、方案、会话和任务日期规则。`recurrence.test.ts` 覆盖日期结算、同日复用、规则编辑、移除撤销和模板删除。
