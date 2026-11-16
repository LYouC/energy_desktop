# 工作台

`App.vue` 负责三栏导航、主题和视图组合。`TaskEditor.vue` 编辑任务、背景、进度和安排，`TaskCard.vue` 展示当日范围与子任务。`ChatPanel.vue` 管理真实或模拟对话、流式预览、取消与方案交互，`ModelSettings.vue` 管理模型设置并清空用后的凭据输入。UI 基础采用 shadcn-vue 的源码组件模式，Button 组合 Reka Primitive、CVA 与 cn，弹层采用 Reka Dialog 的焦点管理。

Pinia 的 `workspace` 持有业务数据的界面副本，所有写入串行调用受控 IPC。写入失败显示错误并刷新，用户编辑表单保留。SQLite 是持久化来源。

主题缓存只用于首次绘制，SQLite 保存用户正式选择。系统主题事件只在跟随系统模式改变外观。默认空工作区，验证数据使用隔离临时目录。

`npm run test:desktop` 实际启动 Electron，覆盖主要交互和重启恢复。截图输出到被忽略的 `test-results/`。
