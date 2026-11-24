# AGENT.md — AI 开发助手工作规范

本文件是 **CloudNote / 云笺** 仓库给 AI 编码助手的入口规范。进入本仓库工作前，先读本文件、`README.md`、`docs/commit-convention.md` 与 `docs/versioning.md`；涉及同步语义时再读 `docs/implementation-report.md`。若本文件与其他文档冲突，以更严格的约束为准，并向用户指出冲突。

## 1. 项目定位与当前状态

- 这是一个 **Obsidian 桌面插件**：通过本机 Git、非交互 SSH、自建裸仓库同步知识库；提供冲突处理、历史恢复、整库快照与可选 DeepSeek 提交说明。
- 当前 `VERSION` 为 `0.1.0`，状态是 **待验收构建**，**不是正式发布版本**。尚未完成 Windows / macOS 真机 Obsidian 验收、私人 SSH 服务器双设备验收和真实 DeepSeek 冒烟测试；未创建发布标签、未合并到 `main`、未部署服务器。
- 第一版不支持移动端、多用户、端到端加密或 Git LFS。服务器仍需独立备份，Git 历史不能替代磁盘备份。
- 不要在没有明确指令和验收证据的情况下声称“已上线 / 已发布 / 已验收”，也不要自行发布、打标签或部署服务器。

## 2. 仓库地图

| 位置 | 职责 |
| --- | --- |
| `src/main.ts` | 插件入口、设置白名单、六个原生视图、状态栏、自动同步调度、SecretStorage 与会话内存回退 |
| `src/engine.ts` | 同步编排：本地提交、获取、逐文件三方比较、冲突预览、整合、推送、历史与快照 |
| `src/git.ts` | Git 参数数组封装；禁用 shell、禁用钩子与签名、非交互 SSH、超时与输出上限 |
| `src/transaction.ts` | 事务性文件发布、日志恢复、操作副本与原子硬链接；中断后保护后续编辑 |
| `src/paths.ts` | 路径校验、排除规则、大小写 / Unicode 碰撞检查、符号链接与大文件限制、目录扫描 |
| `src/ai.ts` | DeepSeek 请求体构造、24 KiB 输入截断、10 秒超时、默认说明回退、文本差异 |
| `src/types.ts` | `Tree` / `Change` / `Preview` / `Choice` / `Settings` 等共享类型与 `MAX_FILE` |
| `tests/` | `sync.test.ts` 使用真实 Git 与临时知识库；`ai.test.ts` 使用模拟响应 |
| `config/` | TypeScript、esbuild、Vitest 配置 |
| `scripts/package.mjs` | 生成 `dist/cloudnote/` 安装目录和 ZIP |
| `docs/` | 配置、服务端、恢复、实施报告、提交规范、版本约定 |

`plan.md`、`rabbish/`、`.workbuddy-ai/` 是本地忽略材料；不要把它们提交到仓库，也不要从中复制未经确认的数据或网络行为到产品代码。

## 3. 工作环境与命令

环境要求：Node.js 22.12+ 或 24、npm、Git 2.40+。Windows 下可用 PowerShell 运行同样的命令。

```powershell
npm ci
npm run check      # TypeScript 严格检查
npm test           # Vitest，顺序执行，单 worker
npm run dev        # esbuild watch
npm run build      # check + esbuild
npm run package    # build + 安装目录 + ZIP
```

开始改动前先看 `git status`，确认只处理本次任务范围。`npm test` 会创建临时知识库和真实 Git 裸仓库；测试中的本地远端仅用于测试，产品代码默认只接受 SSH 地址。不要提交 `node_modules/`、`dist/`、日志、`.env`、密钥或临时文件。

## 4. 不可绕过的安全与正确性约束

这些是插件的核心不变量。修改相关代码必须配套补充测试，并说明对恢复行为的影响。

1. **Git 调用**：只用参数数组和 `spawn(..., { shell: false })`；清理继承的 `GIT_*` 变量；非交互 SSH（`BatchMode=yes`、`StrictHostKeyChecking=yes`）；不允许接管已有仓库、嵌套仓库、Git 工作树或符号链接 `.git`。
2. **管理边界**：知识库必须有 `.git/cloudnote/managed.json`（version 1），且在 `main` 分支；已有非云笺仓库不会被接管。远端地址必须校验，禁止以 `-` 开头或包含控制字符。
3. **同步语义**：先保存本地提交，再获取、逐文件比较、用户确认、整合、推送。同一文件的并发修改由用户选择 `local` / `remote` / `both`；**不写 Git 冲突标记**；整合提交保留双方父提交。首次连接时缺失路径不视为删除。
4. **文件写入**：先用固定 Git 对象、临时索引、操作副本和日志保护，再发布到用户目录。正式发布使用同卷硬链接，避免覆盖编辑器已打开的原文件；任何中断恢复逻辑都不得简单丢弃后续编辑。该机制依赖同卷硬链接，NTFS / APFS 适用，其他文件系统需验收确认。
5. **路径与大小**：排除 `.obsidian`、`.trash`、`.git`、`.cloudnote` 及 `.cloudnote-tmp-*`；不跟随符号链接；单文件上限 `100 MiB`；校验路径长度、保留名、结尾点空格和大小写 / Unicode / 文件目录碰撞。跳过项要进入状态中的 `skipped` 列表。
6. **AI**：自动同步和 AI 默认关闭；API Key 只用 Obsidian SecretStorage，旧版应用仅在会话内存，不写入设置或代码；输入最多 24 KiB，附件只发名称；10 秒超时或接口失败回退默认说明；不把响应体或密钥写进错误、日志或提交说明。
7. **设置**：从持久化数据加载时按已知字段白名单和类型恢复；旧版或注入的 `apiKey` 字段不得回写。连接信息变化后重置 `connectionTested` 和 `autoSync`，并重建 Engine。

## 5. 代码与测试约定

- TypeScript 开启 `strict` 与 `noUncheckedIndexedAccess`；不要使用 `any` 逃逸类型检查，不要用 `// @ts-ignore` 掩盖问题。
- 保持现有风格：ES modules、Node 内置模块、紧凑函数、中文 UI 文案。新依赖必须有明确理由并同步更新 `package-lock.json`；构建与测试配置继续放在 `config/`。
- 改动 `engine` / `transaction` / `paths` 时，至少覆盖：并发编辑、预览后变化、中断恢复、路径碰撞、超限或跳过文件。改动 `ai` 时覆盖超时、限流、无效响应与回退。改动 `main.ts` 时确认六个视图、状态栏和自动同步开关仍正常。
- 测试不能只依赖模拟：同步测试使用真实 Git；AI 使用模拟传输。不要用测试绕过上述安全红线。
- 文档随代码更新：行为变化要同步修改 `README.md` 或对应的 `docs/*.md`，保持链接有效。

## 6. 提交与版本

- 仓库代码提交遵循 [`docs/commit-convention.md`](docs/commit-convention.md)：`<type>(<scope>)!: <subject>`，主题行不超过 72 个半角字符，祈使语气，一次提交一个范围。插件在用户知识库自动生成的同步提交不受此规范约束，也不要手工改写。
- 提交前运行 `npm run check` 和 `npm test`；涉及打包时运行 `npm run package`。未推送提交可 amend，已推送提交用新提交修正，不改写历史。
- 版本规则见 [`docs/versioning.md`](docs/versioning.md)：`VERSION` 是唯一来源；统计范围内 `!` / `BREAKING CHANGE` 提升主版本，`feat` 提升次版本，`fix` / `perf` / `revert` 提升修订号，其余不提升；取最高优先级。版本变更单独提交为 `chore(repo): bump version to x.y.z`，分支为 `develop/x.y.z`，推送到 `origin` 同名分支，不强推 `main`，未验收版本不合并 `main`。
- 版本提升时保持 `VERSION`、`package.json`、`manifest.json`、`versions.json` 一致。注意 `scripts/package.mjs` 当前硬编码 ZIP 名为 `dist/cloudnote-0.1.0.zip`，提升版本时必须同步修改，避免产物名与 `VERSION` 不一致。

## 7. 建议的工作流程

1. 明确任务、读取相关源码与文档、确认当前分支和状态。
2. 小步实现；任何同步 / 写入 / 路径语义变化先补测试再改实现，或同步完成。
3. 运行检查与测试；必要时打包并核对 `dist/cloudnote/` 中 `main.js`、`manifest.json`、`styles.css`。
4. 更新文档和本文件中受影响的条目。
5. 汇报改动文件、验证结果、剩余风险和待验收项；不要替用户决定发布或部署。

## 8. 参考文档

- [README：安装、开发命令与范围](README.md)
- [安装与配置](docs/configuration.md)
- [服务端部署](docs/server.md)
- [备份与故障恢复](docs/recovery.md)
- [第一版实施报告与待验收项](docs/implementation-report.md)
- [Commit 规范](docs/commit-convention.md)
- [版本提升与分支约定](docs/versioning.md)
