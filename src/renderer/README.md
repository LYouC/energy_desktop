# 工作台界面

| 文件或目录                                     | 内容                                                                              |
| ---------------------------------------------- | --------------------------------------------------------------------------------- |
| `index.html`、`main.ts`、`style.css`           | Vite 的 HTML 和 Vue 入口，主题首屏初始化及全局样式。                              |
| `App.vue`、`stores/workspace.ts`               | 工作台三栏、导航、今日安排与任务列表组合，工作区数据加载及命令队列。              |
| `components/`                                  | 任务编辑、任务卡片、管理多选、对话、历史和模型设置。通用按钮在 `components/ui/`。 |
| `composables/taskSelection.ts`、`lib/utils.ts` | 管理模式选择规则与通用 CSS 类合并。                                               |
| `env.d.ts`                                     | 声明 preload 提供的 `window.desktop` 类型。                                       |

## 工作台与主题

任务编辑器显示名称、状态、重要性、预计开始/完成、说明和所属任务。只有名称必填；“安排一次推进”默认折叠，独立编辑每日范围。子任务创建、查看和修改均复用同一个编辑器，父任务选择排除当前任务及其后代。

「所有任务」显示已标注的重要性。等级筛选和名称搜索共同决定可见任务及管理模式的选择范围，切换筛选后只保留可见选中项。

字段修订已适配真实 Agent，`npm test`、类型检查与标准构建覆盖业务规则、Agent 字段与界面类型。桌面手动验证先 `node node_modules/vite/bin/vite.js build`，再 `node tests/task-fields.desktop.mjs`，该脚本不调用模型。

`App.vue` 负责三栏导航、主题和视图组合，并持有侧栏折叠、对话折叠与对话宽度状态，偏好经 localStorage 持久化。`TaskEditor.vue` 编辑任务、背景、进度和安排，`TaskCard.vue` 展示当日范围与子任务。`ChatPanel.vue` 管理真实对话、流式预览、取消与方案交互，并提供对话折叠按钮与左缘拖拽条（300–560px，双击恢复默认），`ModelSettings.vue` 管理模型设置并清空用后的凭据输入。UI 基础采用 shadcn-vue 的源码组件模式，Button 组合 Reka Primitive、CVA 与 cn，弹层采用 Reka Dialog 的焦点管理。

列表页与今日安排共用“管理”多选：`ManageToggle.vue` 提供统一入口，`ManageBar.vue` 展示已选数量、全选与删除入口，`composables/taskSelection.ts` 负责选择状态、可见项收敛与父子删除去重。删除前用 `Modal` 确认，确认后逐个提交 `deleteTask`；中途失败会保留剩余目标并显示原因。管理模式下任务卡切换为紧凑选择行，退出或切换视图会清空选择。该功能以 `npm test` 与 `npm run build` 验证。

Pinia 的 `workspace` 持有业务数据的界面副本，所有写入串行调用受控 IPC。写入失败显示错误并刷新，用户编辑表单保留。SQLite 是持久化来源。

今日安排将未完成的聚焦项置顶，完成后自动转到下一项。显式切换聚焦不改计划顺序，打开详情只更新右侧对话上下文。其余待推进项按规划顺序排列，移动时交换相邻可见项，跳过聚焦项和已完成阶段；已完成阶段收在底部，可展开并恢复，不改变整体任务状态。

主题缓存只用于首次绘制，SQLite 保存用户正式选择。系统主题事件只在跟随系统模式改变外观。默认空工作区，验证数据使用隔离临时目录。

`npm run test:desktop` 实际启动 Electron，覆盖主要交互和重启恢复。截图输出到被忽略的 `test-results/`。

## 对话与模型设置

`ChatPanel.vue` 管理流式预览、取消和失败后的本轮重试。重试复用原请求并清空失败尝试的流式预览。`ChatHistory.vue` 管理分页与删除确认，使用[会话领域规则](../domain/conversations.ts)统一排序。`ModelSettings.vue` 展示公开模型配置与凭据状态，使用过的 Key 从输入状态清空。

上下文预览复用 [Agent 上下文构建](../agent/context.ts)。发送消息、提交任务和保存模型设置都走[桌面桥接](../desktop/README.md)。`tests/agent-ui.desktop.mjs` 使用本地测试传输验证对话交互。
