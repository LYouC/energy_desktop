# 息序 · Energy Desktop

通过对话理解任务、形成背景、拆分目标并协商每日安排的桌面应用。目标是帮助用户更舒服地推进重要的事，同时考虑精力消耗、受挫与恢复。

## 当前状态

- **工作台**支持任务与子任务、重要性与完成状态筛选、今日安排、能量状态和浅深主题。可从「所有任务」把一次性任务安排到今天，完成一次性父任务时会同步完成各层仍开放的一次性子任务。
- **重复任务**在「所有任务」管理规则与完成记录，在「今日安排」执行今天一轮。子任务沿用父任务的规则，父任务完成后新增的子任务当轮也显示已完成。支持逾期补勾、撤销完成、跳过今天、停止、恢复和删除。
- **对话**使用用户配置的模型服务，支持建立任务、拆分、协商安排和故障重试。Agent 可按需查询从明天起最多七天的候选任务，提出整项提前完成或拆分建议。建议经接受后写入安排，提前建议默认保留原日程和预计日期。

真实模型的信息提取和多轮协商仍需要持续验证。当前主线和下一步见 [开发计划](docs/开发计划.md)，实际覆盖与已知限制见 [Agent 验证记录](docs/Agent验证记录.md)。

## 开发运行

使用 Node.js 24 LTS，执行 `npm ci` 安装锁定依赖。

- `npm run dev` 启动 Vite 与 Electron 开发窗口。
- `npm run build` 执行类型检查并构建。
- `npm start` 打开构建后的桌面应用。
- `npm test` 运行离线回归。
- `npm run test:desktop` 构建并运行 Electron 桌面回归。

验证命令、覆盖范围及最近结果见 [测试说明](tests/README.md)，开发协作及提交规范见 [AGENTS.md](AGENTS.md)。

任务、会话和工作区偏好保存在 Electron userData 的 `workspace.db`。`npm run dev` 遇到格式版本不一致时自动清空并重建工作区，保留单独存放的模型设置。设置 `XIXU_DATA_DIR` 可指定独立的数据目录。构建后启动的格式处理见 [工作区说明](src/persistence/README.md#开发期工作区格式)。

## Windows 安装包

在 Windows 上运行 `npm run pack:installer`，安装包位于 `release/xixu-<版本>-windows-x64-setup.exe`。安装包采用 NSIS，默认按当前用户安装，当前版本无代码签名。

将版本标签推送到 GitHub 后，[Windows installer 工作流](.github/workflows/windows-installer.yml)会校验标签所指提交已进入 `main`，运行离线回归和 Electron 桌面测试，打包并检查应用能启动。完成后，在 GitHub Actions 对应运行记录的 **Artifacts** 中下载 `xixu-windows-x64-installer`，解压后运行安装程序。

例如，发布 `package.json` 中的 `0.1.0` 时，在 `main` 的相应提交已推送后执行：

```powershell
git tag -a v0.1.0 main -m "息序 0.1.0"
git push origin v0.1.0
```

## Windows 便携试用

运行 `npm run pack` 后打开 `release/win-unpacked/息序.exe`。移动时保留整个 `win-unpacked` 目录。目录包无代码签名。

Electron 首次运行会下载桌面运行文件。下载受网络环境影响时，可在当前 PowerShell 会话设置 `$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'` 后重试 `npm start` 或 `npm run pack`。

## 查看设计稿

在浏览器打开 [浅色设计稿](design/index.html) 即可查看，样式文件随设计稿保存在同一目录。

## 源码目录

应用源码放在 `src/`，测试与夹具放在 `tests/`，项目文档放在 `docs/`。源码职责、入口及模块 README 见 [模块索引](AGENTS.md#已落地模块索引)。

## 项目文档

- [产品需求](docs/产品需求.md)记录产品范围、行为和验收条件。
- [重复任务使用说明](docs/重复任务.md)列出父子继承、当轮完成及各类排期场景。
- [开发计划](docs/开发计划.md)记录后续事项和近期交付。
- [待确认需求](docs/待确认需求.md)记录待讨论的规则、想法和试用反馈。
- [技术方案](docs/技术方案.md)说明技术路线、架构和关键决策。
- [设计规范](docs/设计规范.md)记录布局、视觉和浅深主题。
- [Agent 场景用例](docs/Agent场景用例.md)和 [Agent 流程说明](docs/agent-flow.html)用于了解对话场景、验收方式和运行流程。
