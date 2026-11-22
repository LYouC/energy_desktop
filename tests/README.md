# 测试说明

本文记录验证入口、覆盖范围和已取得的证据。预期行为见 [产品需求](../docs/产品需求.md)，真实模型的用例结果、语义评审与限制见 [Agent 验证记录](../docs/Agent验证记录.md)。

## 运行

| 命令                              | 用途                                                                       |
| --------------------------------- | -------------------------------------------------------------------------- |
| `npm test`                        | 运行业务、SQLite、Agent 编排、界面状态和配色回归。                         |
| `npm run test:desktop`            | 构建并运行 Electron 桌面回归，使用隔离工作区和本地 Agent 测试传输。        |
| `node tests/review.desktop.mjs`   | 对已构建的应用运行独立桌面审查场景。                                       |
| `node tests/agent-ui.desktop.mjs` | 对已构建的应用验证配置恢复、流式、取消、重试和会话交互，使用本地测试传输。 |
| `node tests/pack.smoke.mjs`       | 验证生成的 Windows 目录包启动、Agent IPC、SQLite 和凭据隔离。              |

桌面脚本通过 `XIXU_DATA_DIR` 使用隔离临时目录，截图及结果写入 Git 忽略的 `test-results/`。受限环境启动 Electron 时可能需要允许本地子进程。

## 工作区与桌面回归

重复任务交付通过 107 项离线用例、格式检查、类型检查、生产构建和六组 Electron 桌面回归。详见 `git show 2d368a0`。

| 范围             | 覆盖与入口                                                                                                                                                                                                                                                                 |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 任务与安排       | [领域测试](domain.test.ts)、[任务字段测试](task-fields.test.ts)和 [今日安排桌面脚本](today.desktop.mjs)覆盖父子任务、预计日期与安排隔离、阶段完成与恢复、焦点和调序。任务字段桌面脚本覆盖重要性标注、筛选与搜索联用、管理选择及保存后的显示。                              |
| 重复任务         | [领域测试](recurrence.test.ts)、[存储测试](recurrence-storage.test.ts)和 [桌面脚本](recurrence.desktop.mjs)覆盖周期规则、同日安排复用、跨日补齐和版本检查、调序、移除及撤销、删除模板后保留实例，以及筛选、混合选择和深浅主题标签。                                        |
| 持久化与方案     | [工作区测试](workspace.test.ts)、[任务字段测试](task-fields.test.ts)和 [Agent 领域测试](agent-domain.test.ts)覆盖重开恢复、旧数据迁移、版本冲突、原子应用、部分接受及重复应用保护。                                                                                        |
| Agent 运行与会话 | [运行测试](agent-runtime.test.ts)、[工具测试](agent-tools.test.ts)、[会话测试](conversations.test.ts)和 [Agent 桌面脚本](agent-ui.desktop.mjs)覆盖工具编排、协议错误、中断重试、取消、幂等提交、分页和删除。Agent 可读取重要性和重复任务上下文，其写入限制由本地测试验证。 |
| 主题与布局       | [配色测试](styles.test.ts)和 [桌面审查脚本](review.desktop.mjs)覆盖系统主题实时变化、手选优先、偏好恢复、实际 DOM 对比度、键盘焦点和 800px 窄窗口。                                                                                                                        |

## 真实模型验证

以下命令会调用真实模型并消耗 API 额度。开发实验使用本地 `.env.agent.local`，脱敏结果写入 Git 忽略的 `test-results/`。

- `npm run test:agent:live` 串行运行六条真实模型样例。
- `npm run test:agent:journey` 运行 S01 七轮连续对话，末轮同日序列化重读后继续。
- `npm run test:agent:behavior` 验证自然确认、草稿承接、含糊指代、事实纠正和历史查询等场景。用 `XIXU_BEHAVIOR_FILTER` 按逗号分隔的子串选择场景。
- `node tests/agent-real.desktop.mjs` 对已构建的应用发送一轮真实桌面对话，检查 SQLite 保存和重启恢复。

## Windows 交付

安装包首轮验证在 Windows 11 x64 本地生成 `xixu-0.1.0-windows-x64-setup.exe`，通过打包应用启动、Agent IPC、SQLite 和模型设置检查。安装向导完整操作及 GitHub 标签触发后的托管运行仍待验证。打包和下载步骤见 [项目 README](../README.md#windows-安装包)。

## 验证边界

- 真实用户可用性、不同 Windows 显示缩放、完整视觉状态组合及长时间、大数据量使用待进一步验证。
- 真实模型已覆盖若干授权、事实提炼和连续规划路径。更多措辞、全部场景分支、长期稳定性及真实服务故障与流式取消仍待验证。故障恢复的现有自动化证据主要来自模拟传输。
- 早期原型的逐阶段测试结果可在 Git 查询，例如 `git show 2d368a0:tests/README.md`。
