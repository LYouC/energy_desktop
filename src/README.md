# 工作台

任务编辑器默认仅显示名称、状态、预计开始/完成、说明、所属任务。只有名称必填；“安排一次推进”默认折叠，独立编辑每日范围。子任务创建、查看和修改均复用同一个编辑器；父任务选择排除当前任务及其后代。今日卡片和任务列表使用新日期与说明，不展示旧重要性/截止字段。

字段修订已适配真实 Agent，`npm test`、类型检查与标准构建覆盖业务规则、Agent 字段与界面类型。桌面手动验证先 `node node_modules/vite/bin/vite.js build`，再 `node tests/task-fields.desktop.mjs`，该脚本不调用模型。

`App.vue` 负责三栏导航、主题和视图组合，并持有侧栏折叠、对话折叠与对话宽度状态，偏好经 localStorage 持久化。`TaskEditor.vue` 编辑任务、背景、进度和安排，`TaskCard.vue` 展示当日范围与子任务。`ChatPanel.vue` 管理真实对话、流式预览、取消与方案交互，并提供对话折叠按钮与左缘拖拽条（300–560px，双击恢复默认），`ModelSettings.vue` 管理模型设置并清空用后的凭据输入。UI 基础采用 shadcn-vue 的源码组件模式，Button 组合 Reka Primitive、CVA 与 cn，弹层采用 Reka Dialog 的焦点管理。

列表页与今日安排共用“管理”多选：`ManageToggle.vue` 提供统一入口，`ManageBar.vue` 展示已选数量、全选与删除入口，`composables/taskSelection.ts` 负责选择状态、可见项收敛与父子删除去重。删除前用 `Modal` 确认，确认后逐个提交 `deleteTask`；中途失败会保留剩余目标并显示原因。管理模式下任务卡切换为紧凑选择行，退出或切换视图会清空选择。该功能以 `npm test` 与 `npm run build` 验证。

Pinia 的 `workspace` 持有业务数据的界面副本，所有写入串行调用受控 IPC。写入失败显示错误并刷新，用户编辑表单保留。SQLite 是持久化来源。

今日安排将未完成的聚焦项置顶，完成后自动转到下一项。显式切换聚焦不改计划顺序，打开详情只更新右侧对话上下文。其余待推进项按规划顺序排列，移动时交换相邻可见项，跳过聚焦项和已完成阶段；已完成阶段收在底部，可展开并恢复，不改变整体任务状态。

主题缓存只用于首次绘制，SQLite 保存用户正式选择。系统主题事件只在跟随系统模式改变外观。默认空工作区，验证数据使用隔离临时目录。

`npm run test:desktop` 实际启动 Electron，覆盖主要交互和重启恢复。截图输出到被忽略的 `test-results/`。
