# 息序 · Energy Desktop

通过对话理解任务、形成背景、拆分目标并协商每日安排的桌面应用。目标是帮助用户更舒服地推进重要的事，同时考虑精力消耗、受挫与恢复。

## 当前状态

- **工作台**支持任务与子任务分组、重要性筛选、按日安排、阶段与整体进度、能量状态和浅深主题。今日聚焦置顶，可从「所有任务」直接把一次性任务安排到今天。勾选完成一次性父任务时，各层仍开放的一次性子任务同步完成。
- **重复任务**支持规则继承和今日实例。通过对话可以设置规则、删除模板，也可以补加、调整、完成、移除或恢复今天的实例。模板与实例分别维护自己的状态。
- **对话**使用用户配置的模型服务，支持建立任务、拆分、协商安排和故障重试。Agent 可按需查询从明天起最多七天的候选任务，提出提前推进建议。接受调整卡后新增今天的安排，原日程和预计日期默认保留。任务、历史会话和草稿保存在本机。

真实模型的信息提取和多轮协商仍需要持续验证。当前主线和下一步见 [开发计划](docs/开发计划.md)，实际覆盖与已知限制见 [Agent 验证记录](docs/Agent验证记录.md)。

## 开发运行

使用 Node.js 24 LTS，执行 `npm ci` 安装锁定依赖。

- `npm run dev` 启动 Vite 与 Electron 开发窗口。
- `npm run build` 执行类型检查并构建。
- `npm start` 打开构建后的桌面应用。
- `npm test` 验证关键业务规则。
- `npm run test:desktop` 构建并实际操作 Electron，运行主流程和独立审查场景，验证交互、重启恢复、系统主题、弹窗与对比度。
- `npm run test:desktop:today` 构建并定向验证今日安排与重复任务。
- `npm run format:check` 检查源码格式。
- `npm run pack` 构建 Windows 便携目录。
- `npm run pack:installer` 生成 Windows 11 x64 安装包。

验证命令、覆盖范围及最近结果见 [测试说明](tests/README.md)，开发协作及提交规范见 [AGENTS.md](AGENTS.md)。

任务、会话和工作区偏好保存在 Electron userData 的 `workspace.db`。设置 `XIXU_DATA_DIR` 可指定独立的工作区数据目录。模型设置单独保存，见 [Agent 配置说明](src/agent/README.md#配置与验证)。

## Windows 安装包

在 Windows 上运行 `npm run pack:installer`，安装包位于 `release/xixu-<版本>-windows-x64-setup.exe`。安装包采用 NSIS，默认按当前用户安装，当前版本无代码签名。

将版本标签推送到 GitHub 后，[Windows installer 工作流](.github/workflows/windows-installer.yml)会校验标签所指提交已进入 `main`，运行离线回归和 Electron 桌面测试，打包并检查应用能启动。完成后，在 GitHub Actions 对应运行记录的 **Artifacts** 中下载 `xixu-windows-x64-installer`，解压后运行安装程序。

例如，发布 `package.json` 中的 `0.1.0` 时，在 `main` 的相应提交已推送后执行：

```powershell
git tag -a v0.1.0 main -m "息序 0.1.0"
git push origin v0.1.0
```

## Windows 便携试用

运行 `npm run pack` 后打开 `release/win-unpacked/息序.exe`。当前目录包已经独立启动验证，移动时需保留整个 `win-unpacked` 目录。原型使用无签名目录包。

Electron 首次运行会下载桌面运行文件。下载受网络环境影响时，可在当前 PowerShell 会话设置 `$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'` 后重试 `npm start` 或 `npm run pack`。

## 查看设计稿

在浏览器打开 [浅色设计稿](design/index.html) 即可查看，样式文件随设计稿保存在同一目录。

## 源码目录

应用源码放在 `src/`，测试与夹具放在 `tests/`，项目文档放在 `docs/`。源码职责、入口及模块 README 见 [模块索引](AGENTS.md#已落地模块索引)。

## 项目文档

- [产品需求](docs/产品需求.md)记录产品范围、行为和验收条件。
- [开发计划](docs/开发计划.md)记录后续事项、已交付工作与阶段复盘。
- [待确认需求](docs/待确认需求.md)记录试用反馈、临时想法和仍需讨论的业务规则。
- [技术方案](docs/技术方案.md)说明技术路线、架构和关键决策。
- [设计规范](docs/设计规范.md)记录布局、视觉和浅深主题。
- [Agent 场景用例](docs/Agent场景用例.md)和 [Agent 流程说明](docs/agent-flow.html)用于了解对话场景、验收方式和运行流程。
