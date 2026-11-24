# 版本提升与分支约定

本文件供 AI 开发助手在执行版本变更时遵循。版本号以仓库根目录 `VERSION` 为唯一来源，格式为 `x.y.z`；`develop/x.y.z` 分支名中的 `x.y.z` 必须与 `VERSION` 的内容完全一致。

## 一、根据提交信息判断提升哪一位

提交格式遵循 [Commit 规范](commit-convention.md)。统计范围：从标记当前版本的 `v<当前 VERSION>` 标签开始；没有标签时，从最后一次修改 `VERSION` 的提交之后开始，直到待发布的 HEAD。

只统计本仓库的代码提交。插件在用户知识库自动生成的同步提交（如「同步笔记：新增 1 个，修改 2 个，删除 0 个」，或 DeepSeek 生成的中文说明）是产品行为，不计入版本判断。

| 提交特征 | 提升位数 | 示例 |
| --- | --- | --- |
| 主题行类型后带 `!`，或正文/页脚含 `BREAKING CHANGE:` / `BREAKING-CHANGE:` | **x（主版本）**，y、z 归零 | `feat(engine)!: 改变整合提交的父提交顺序` |
| `feat` 类型 | **y（次版本）**，z 归零 | `feat(ui): 增加主题切换` |
| `fix`、`perf`、`revert` 类型 | **z（修订号）** | `fix(paths): 符号链接跳过时显示具体原因` |
| `docs`、`test`、`build`、`ci`、`chore`、`style`、`refactor` 类型 | 不提升 | `chore(repo): 忽略 WorkBuddy 工作区元数据` |
| 不符合上述格式的提交（含自动生成的同步提交） | 不提升，也不视为错误 | `同步笔记：新增 1 个，修改 2 个，删除 0 个` |

同一范围内有多条提交时取最高优先级：**x > y > z > 不提升**。若没有任何可触发提升的提交，保持 `VERSION` 不变，也不创建新分支。

示例：当前 `0.1.0`，范围内有 `fix` 和 `feat` → `0.2.0`；若另有破坏性变更 → `1.0.0`；只有 `chore` → 保持 `0.1.0`。

## 二、提升 VERSION

1. 按上表得到新版本号，把根目录 `VERSION` 改成该版本，内容为单行 `x.y.z`。
2. 版本变更单独提交，说明用 `chore(repo): bump version to x.y.z`，不要夹带无关改动。
3. 保持其他版本相关文件一致：`package.json` 的 `version`、`manifest.json` 的 `version`，以及 `versions.json` 中以旧版本为键的条目（把键改为新版本，`minAppVersion` 的值不变）。

## 三、分支命名与推送

1. 分支名直接由 `VERSION` 派生：新版本是 `x.y.z` 时，目标分支就是 `develop/x.y.z`。例如 `VERSION` 为 `0.2.0`，分支为 `develop/0.2.0`。不得使用旧版本号、缩写或与 `VERSION` 不一致的名字。
2. 从当前开发分支创建该分支，把版本变更提交到该分支；同名分支已存在时先核对内容，不要覆盖或强推。
3. 推送到 `origin` 的同名分支：`git push -u origin develop/x.y.z`。不强推 `main`，也不把未验收版本合并到 `main`。
4. 推送后再次确认远端分支名与 `VERSION` 一致，再继续后续发布流程。
