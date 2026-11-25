# 测试说明

产品验收条件见 [产品需求](../docs/产品需求.md)，真实模型结果见 [Agent 验证记录](../docs/Agent验证记录.md)。

## 运行

| 命令                         | 用途                                                                |
| ---------------------------- | ------------------------------------------------------------------- |
| `npm test`                   | 运行业务、SQLite、Agent 编排、会话和界面规则回归。                  |
| `npm run test:desktop`       | 构建后运行七组 Electron 回归，使用隔离工作区和本地 Agent 测试传输。 |
| `npm run test:desktop:today` | 构建后定向验证今日安排与重复任务。                                  |
| `npm run format:check`       | 检查源码和测试格式。                                                |

构建后可直接运行下表中的桌面脚本，例如 `node tests/agent-ui.desktop.mjs`。脚本通过 `XIXU_DATA_DIR` 指定临时工作区，截图及结果写入 Git 忽略的 `test-results/`。

## 工作区与桌面回归

| 范围         | 覆盖与入口                                                                                                                                                                                                    |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 任务与安排   | [领域测试](domain.test.ts)、[任务字段测试](task-fields.test.ts)和 [任务字段桌面脚本](task-fields.desktop.mjs)覆盖普通任务与子任务、预计日期与安排、旧数据兼容、行内安排、筛选搜索与管理选择。                 |
| 重复任务     | [领域测试](recurrence.test.ts)、[存储测试](recurrence-storage.test.ts)和 [桌面脚本](recurrence.desktop.mjs)覆盖规则继承、跨日结算、实例版本、调序、移除和撤销、历史入口移除，以及删除模板后仍可处理当日实例。 |
| 持久化       | [工作区测试](workspace.test.ts)覆盖重开、迁移、版本冲突和事务。                                                                                                                                               |
| Agent 与会话 | [运行测试](agent-runtime.test.ts)、[工具测试](agent-tools.test.ts)、[会话测试](conversations.test.ts)和 [对话桌面脚本](agent-ui.desktop.mjs)覆盖编排、协议错误、流式、取消、重试、幂等、分页和删除。          |
| 界面与主题   | [配色测试](styles.test.ts)和 [桌面审查脚本](review.desktop.mjs)覆盖系统主题、手动选择与恢复、DOM 对比度、键盘焦点、800px 窄窗口与自绘标题栏。                                                                 |

## 任务调整卡验证

[Agent 领域测试](agent-domain.test.ts)、[工作区测试](workspace.test.ts)和 [对话桌面脚本](agent-ui.desktop.mjs)覆盖 A06、A18。核对整卡接受或拒绝、跨任务独立确认、按卡片日期执行、旧卡迁移与重复接受保护。原任务删除或原安排被移走时，接受失败并回滚，原因在原卡中展示，重开后仍可见。

## 今日安排与预计完成验证

- [今日桌面脚本](today.desktop.mjs)覆盖 A19、A21，包括两区完成与恢复、父子任务联动、聚焦和调序。未安排的已完成任务刷新后仍在「今日已完成」。
- [Agent 领域测试](agent-domain.test.ts)和 [上下文桌面脚本](agent-context.desktop.mjs)覆盖 A20，包括一键优化读取两区、保留草稿、整卡拒绝、整卡接受后创建子任务并按卡片日期安排，以及实发请求调试和会话隔离。
- [任务字段测试](task-fields.test.ts)和 [任务字段桌面脚本](task-fields.desktop.mjs)覆盖 A22，包括两处「安排到今天」入口、重复点击、跨日限制、原日期与安排保留、键盘操作和写入冲突。

## 近期任务查询验证

[Agent 工具测试](agent-tools.test.ts)覆盖 A23 的只读查询、跨年窗口和七天上限。本轮候选校验同时覆盖整项建议和拆分后安排。A23–A24 的真实模型证据与复验范围见 [Agent 验证记录](../docs/Agent验证记录.md#2026-年-11-月-24-日-近期任务与提前推进)。

## 真实模型验证

Agent 变更时按涉及的场景运行真实模型用例。以下命令消耗 API 额度。开发使用本地 `.env.agent.local`，脱敏结果写入 `test-results/`。

- `npm run test:agent:live` 串行运行六条样例。
- `npm run test:agent:journey` 运行 S01 七轮对话，末轮同日序列化重读后继续。
- `npm run test:agent:behavior` 运行为授权、草稿承接、事实纠正、历史查询等设计的场景。设置 `XIXU_BEHAVIOR_FILTER` 可按逗号分隔的子串筛选。PowerShell 示例为 `$env:XIXU_BEHAVIOR_FILTER = 'B09,B12'`。
- `node tests/agent-real.desktop.mjs` 对已构建的应用执行一轮真实桌面对话，检查 SQLite 保存和重启恢复。

## Windows 交付

`node tests/pack.smoke.mjs` 验证 Windows 目录包启动、Agent IPC、SQLite 和模型设置隔离。已在 Windows 11 x64 本地生成安装包，安装向导全流程与 GitHub 标签触发的托管运行待验证。 [打包和下载步骤](../README.md#windows-安装包)

## 验证边界

- 最近一次安排调整对应 `1a0553d`，记录为 148 项离线测试、生产构建、格式检查和七组 Electron 回归通过。早期结果可用 `git log -- tests/README.md` 回看。
- Windows 鼠标拖动标题栏、边缘调整尺寸、显示缩放、真实用户试用、长时间运行和大工作区待补充验证。
- 真实服务故障、流式取消和多轮稳定性待复验，现有故障恢复证据主要来自模拟传输。 [Agent 待复验项](../docs/Agent验证记录.md#覆盖范围与后续验证)
