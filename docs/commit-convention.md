# Commit 规范

本文件约定 **CloudNote 代码仓库** 的 Git 提交格式。云笺在用户知识库中自动生成的同步提交（如 `同步笔记：新增 1 个，修改 2 个，删除 0 个`，或 DeepSeek 生成的中文说明）属于产品行为，使用独立格式，不受本规范约束，也不要手工改写。

## 提交格式

```text
<type>(<scope>)!: <subject>

<body>

<footer>
```

- `type`：提交类型，必填，小写英文。
- `scope`：影响范围，可选，小写英文。
- `!`：破坏性变更标记，可选；与 `BREAKING CHANGE:` 页脚至少出现一个。
- `subject`：主题行，必填，中文或英文均可，但同一条提交内保持一致。
- `body` 与 `footer`：可选，与主题行之间空一行。

主题行不超过 72 个半角字符（约 36 个汉字），正文每行建议不超过 72 个字符。

## 类型

| type | 用途 |
| --- | --- |
| `feat` | 新功能或新视图 |
| `fix` | 修复缺陷 |
| `perf` | 性能优化 |
| `refactor` | 不改变行为的代码重构 |
| `docs` | 文档变更 |
| `test` | 新增或修改测试 |
| `build` | 构建、打包、依赖版本变更 |
| `ci` | CI 配置变更 |
| `chore` | 仓库维护、忽略规则、版本元数据等杂项 |
| `style` | 格式调整，不影响逻辑 |
| `revert` | 撤销此前的提交 |

## 范围

| scope | 对应内容 |
| --- | --- |
| `engine` | 同步流程、预览、冲突整合、历史恢复 |
| `git` | Git 命令封装与提交元数据 |
| `transaction` | 快照、标签与恢复事务 |
| `ai` | DeepSeek 提交说明生成与回退 |
| `ui` | Obsidian 视图、设置面板与交互 |
| `paths` | 路径校验、排除规则与大文件限制 |
| `types` | 共享类型定义 |
| `config` | TypeScript、esbuild、Vitest 配置 |
| `scripts` | 打包与辅助脚本 |
| `deps` | 依赖升级 |
| `repo` | 仓库级文件，如 README、LICENSE、`.gitignore` |

跨多个模块或不便归类时省略 `scope`，不要写 `all`、`misc` 之类的泛化词。一次提交只包含一个范围；确实涉及两件事时拆成两次提交。

## 主题行

- 用祈使语气描述做了什么，中文用「增加」「修复」「调整」，英文用 `add`、`fix`、`adjust`，不要用过去式。
- 不加句号、感叹号或省略号，不以 `WIP`、`update`、`fix bug` 这类无信息量的文字开头。
- 说明变化本身，而不是文件列表或行号。
- 允许使用中文，例如 `feat(engine): 冲突整合保留双方父提交`；英文示例 `chore: ignore WorkBuddy workspace metadata`。

## 正文与页脚

正文解释「为什么改」和「怎么改」，以及与旧行为的差异；能通过代码和主题行看出的内容不必重复。破坏性变更在页脚用 `BREAKING CHANGE: <说明>`，升级注意事项和关联问题也写在页脚，例如 `Refs: #42`。

```text
fix(engine)!: 改变整合提交的父提交顺序

历史视图原先假定本地提交为唯一父提交，无法正确展示保留双方的场景。

BREAKING CHANGE: 读取整合提交历史的外部脚本需要兼容两个父提交。
```

## 示例

```text
feat(engine): 冲突整合时保留双方父提交
fix(paths): 符号链接跳过时显示具体原因
perf(ai): 输入超过 24 KiB 时按路径顺序截断
refactor(git): 统一 spawn 的 Git 参数构造
test(engine): 覆盖拉取过程中出现本地编辑的情况
docs: 补充 commit 规范与提交前检查
build(deps): 升级 esbuild 至 0.28
chore(repo): 忽略 WorkBuddy 工作区元数据
revert: 撤销「调整快照标签命名」
```

## 提交前检查

1. 确认只暂存本次变更，不提交 `dist/`、`node_modules/`、密钥或临时文件。
2. 运行 `npm run check` 和 `npm test`；涉及打包流程时再运行 `npm run package`。
3. 未推送的提交可以用 `git commit --amend` 修改说明；已推送的提交用新的修正提交，不改写历史。
4. 不在本仓库提交用户笔记、SSH 私钥或 DeepSeek Key，这些不属于插件代码。

## 可选：本地提交模板

将以下内容保存为 `.gitmessage`，再执行 `git config commit.template .gitmessage`，可在 `git commit` 时得到提示骨架：

```text
<type>(<scope>): <subject>

# type: feat | fix | perf | refactor | docs | test | build | ci | chore | style | revert
# scope: engine | git | transaction | ai | ui | paths | types | config | scripts | deps | repo
# 主题行不超过 72 字符；破坏性变更加 ! 并写 BREAKING CHANGE: 页脚
```
