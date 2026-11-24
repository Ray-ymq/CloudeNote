# 云笺：Obsidian 云同步插件

云笺通过本机 Git、SSH Agent 和自建裸仓库同步 Obsidian 知识库，并提供冲突处理、历史恢复、整库快照和可选的 DeepSeek 提交说明。当前已经实现 TypeScript 桌面插件与六个原生视图，版本为 **0.1.0 待验收构建**。尚未进行双平台 Obsidian 实机和私人服务器项目验收，也未发布正式版本。

开发环境需要 Node.js 22.12+ 或 24、npm 和 Git 2.40+。使用下面的命令运行开发检查并生成安装目录，将 `dist/cloudnote/` 中的 `main.js`、`manifest.json` 和 `styles.css` 复制到测试知识库的 `.obsidian/plugins/cloudnote/` 后启用插件。原始演示和预览图片保存在 `rabbish/`，其中的数据和网络行为仍为模拟。构建、TypeScript 与测试配置集中在 `config/`，打包脚本位于 `scripts/`。

```powershell
npm ci
npm run check
npm test
npm run package
```

同步先保存本地提交，再获取远端、逐文件比较和整合，最后推送。同一文件的并发修改由用户选择，不写入 Git 冲突标记，整合提交保留双方父提交；恢复先保存当前状态，并通过新提交应用历史内容。自动同步与 AI 默认关闭，需要先测试 SSH 连接，再预览范围并初始化独立知识库。

完整操作见 [安装与配置](docs/configuration.md)、[服务端部署](docs/server.md) 和 [备份与故障恢复](docs/recovery.md)，开发结果与待验收项见 [实施报告](docs/implementation-report.md)，提交约定见 [Commit 规范](docs/commit-convention.md)，版本提升规则见 [版本提升与分支约定](docs/versioning.md)。同步排除 `.obsidian`、`.trash` 与临时数据，单文件上限 100 MiB，不跟随符号链接，不接管其他工具创建的 Git 仓库。DeepSeek Key 使用 Obsidian SecretStorage，旧版应用仅保存在会话内存；服务器仍需独立备份，第一版不包含移动端、多用户、端到端加密或 Git LFS。
