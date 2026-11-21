# 息序 Agent 提示词调研

2026-11-19。建议把系统提示词组织为角色、任务、原则、工作流程、输出要求和示例。运行时按轮提供事实和历史。这个结构是息序的改写起点，实际效果需在用户配置的模型上评估。

## 官方资料的建议

- OpenAI 将身份、指令、示例、上下文作为常见结构，并指出合适的内容和顺序随模型变化。Markdown 标题可以表达层级，XML 可以标记资料边界。Anthropic 建议明确所需结果，说明关键规则的动机，在确实有先后依赖时写步骤。示例应贴近真实用法，覆盖不同的决定和边界。两家的指南针对各自模型，适合用来设计息序的初稿和对照实验。 [OpenAI Prompt engineering](https://developers.openai.com/api/docs/guides/prompt-engineering#message-formatting-with-markdown-and-xml)、[Anthropic Prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices#general-principles)
- 工具描述应说明用途、调用条件、参数含义和关键限制，复杂参数可配代表性示例。AI SDK 将工具描述用于引导模型选择，以输入 schema 验证参数，并通过代码控制执行和多步停止。输入合法、用户确实授权、预演成功和最终写入成功是不同的检查点。 [Anthropic Define tools](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools#best-practices-for-tool-definitions)、[AI SDK Tool Calling](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling)

## 息序提示词结构

| 段落     | 建议写入的内容                                                                                                                                                                                                                                |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 角色     | 用自然、简洁的中文协助用户推进重要任务，兼顾可持续的节奏和用户的选择权。                                                                                                                                                                      |
| 任务     | 理解目标与背景、记录和拆分任务、协商安排、协助启动和应对受挫、调整及收尾。依据当轮意图选择当前需要的帮助。                                                                                                                                    |
| 原则     | 将离散能量状态作为定性线索，结合任务阻力、截止、可用时间和偏好判断节奏。考虑实际消耗、可见进展和恢复机会。休息本身有价值，恢复程度因处境而异。区分已知事实、暂估和推测，保留真实截止、原目标及用户已经作出的决定。                            |
| 工作流程 | 从当前消息、近期对话和工作区判断意图、对象、范围及授权。信息不足时按需查任务、历史或算容量，仍有实质歧义时问一个具体问题。明确授权的动作直接准备，Agent 主动建议的实质变更以待接受方案提交。用 `prepareTurn` 提交整轮决定，依据回执生成终答。 |
| 输出要求 | 以用户当前最需要的结果开头。交代实际动作和待接受方案的对象、日期及范围。遇到容量缺口时说清取舍，遇到启动困难时给可以立即尝试的一步。表达的进展、计划与回执一致。                                                                              |
| 示例     | 用简短情境示范判断和结果。可优先覆盖「明确改期」「仅接受拆分」「疲惫但想继续」「今日阶段结束、整项仍在进行」。示例中的任务、估时和说法随情境变化。                                                                                            |

上述行为来自产品规则与现有工具接口。动态上下文可沿用日期及其时区、最新能量、任务和今日安排、还未接受的方案、近期对话及必要记忆。工作区记录、历史摘要和工具结果提供本轮判断的事实依据，系统段落统一定义如何使用这些数据。 [产品需求](产品需求.md)、[技术方案](技术方案.md)、[Agent 运行服务](../src/agent/README.md)

当前运行层负责结构、引用、状态版本及业务校验，在内存预演并在 SQLite 事务中提交；手改能量是否触发模型也由应用入口决定。自然语言授权仍由模型结合上下文判断，程序关联用户消息供追溯。提示词应说明如何区分授权范围和待协商建议，评估时应检查模型对每个动作的语义判断。 [Agent 运行服务](../src/agent/README.md)、[产品需求](产品需求.md)

## 验证方式

在相同模型、设置和初始状态下对照旧版与新版。复用现有场景，保留未写入提示词的措辞变体和多轮测试。每轮核对工具调用、参数、回执和实际数据，再评审对用户的答复是否保留事实强度、符合授权范围、给出可行帮助。高影响或曾波动的用例可重复试验，记录通过次数和失败形态。项目早期复验已出现字段遗漏、未确认细节写成事实及回复和执行范围不一致，适合优先纳入对照。 [OpenAI Evaluation best practices](https://developers.openai.com/api/docs/guides/evaluation-best-practices#identify-where-you-need-evals)、[Anthropic Demystifying evals for AI agents](https://www.anthropic.com/research/demystifying-evals-for-ai-agents)、[息序 Agent 场景用例](Agent场景用例.md)、[息序 Agent 验证记录](Agent验证记录.md)
