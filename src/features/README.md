# 对话与模拟回归

`mock.ts` 提供明确标注的模拟回复，用于验证方案展示、部分接受及子任务落地。它采用有限模板，不能理解任意自然语言，也不能验证真实 Agent 的规划效果。`shared/context.ts` 提供可查看的最新能量、任务、历史安排、近期消息与待处理方案。

真实 Agent 已通过 `electron/agent/runtime.ts` 接入，使用共享的业务操作与方案接口；界面使用真实 Agent，模拟回复保留在 `mock.ts` 供单元测试与开发验证使用。接口与验证范围见 `electron/agent/README.md`。

模拟回复已适配精简属性，读取任务说明与预计完成日期，子任务方案使用 `description`。模拟安排仍经共享业务入口生效，预计起止日期独立保存。

`ChatPanel.vue` 在组件内部处理失败重试：清空失败尝试的流式预览，重试按钮复用原请求。`ChatHistory.vue` 管理分页和删除确认，`shared/conversations.ts` 统一历史顺序和保留上限。`tests/conversations.test.ts` 覆盖清理与上限，`tests/agent-ui.desktop.mjs` 使用本地测试传输验证交互。
