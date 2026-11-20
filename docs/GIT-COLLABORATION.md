# GitHub 协作、功能分支与跨电脑同步规范

> 项目：ecom-image-capture。适用于维护本仓库的开发者和 Agent。配合根目录 `AGENTS.md`、`docs/PIPELINE-RULES.md`、`docs/GITHUB-RELEASE.md` 使用。
> 本文是**协作规范**，不是向 Agent 授予执行 Git 提交、推送、PR 合并、依赖安装或文件删除的权限。以任务当前授权和真实 Git 状态为准。

## 1. 角色与唯一代码基线

- **GitHub**：代码交换与 PR 审核平台；`origin/main` 是已合并的共享基线。上传源码 ≠ 发布正式 Release。
- **PC1（主开发机）**：通常负责集成、评审、修复、发行，但不意味着 PC1 可以无审批覆盖 PC2 的实验。
- **PC2（测试 / 实验机）**：同步 `main` 做复测；新功能、修复与实验在 `feature/<topic>` 或 `fix/<topic>` 开发。
- 两台电脑不是两条永久分支：同一台电脑可以检出多个分支；角色不等于 Git 分支。
- 不需要 PC2 更换 GitHub 账号。分支管理和 PR 与账号是否相同无关；如果审核需要独立人员，应另行安排。
- 主干默认只接收已通过评审的改动。功能分支可以来自任何电脑，PR 合并后所有电脑再同步。

## 2. 每个 Agent 的统一入口

进入**目标项目工作区**，先读 `AGENTS.md` → 本文件 → 与任务有关的业务文档；如果存在 `runtime/agent-guides/PC1-GIT-RUNBOOK.md` 或 `runtime/agent-guides/PC2-GIT-RUNBOOK.md`，只读取当前电脑对应的一份本机补充。

先核查：电脑身份、仓库路径、`origin` URL、当前分支、`HEAD`、`git status --short --branch`、是否有未提交/未跟踪改动、当前任务的权限。只有需要远端新状态时才执行 `git fetch origin`；**未 fetch 的 `origin/main` 可能过时**。

区分权限：只读检查可主动进行；创建/修改项目文件依当前任务授权；`git commit` 和 `git push` 分别需要明确授权；PR 合并、删除、强制推送和额外依赖操作不得从普通“检查/同步”指令推定。不要切换到另一台电脑绕过权限或失败状态。

## 3. 什么时候需要同步另一台电脑？

**Git push 不会更新其他电脑的本地工作树。** 另一台电脑是否应同步，看**远端哪个分支发生变化**及**本机下一步的工作**，不是看到 push 就自动执行 pull。

| 已发生的远端事件 | 另一台电脑的正确动作 |
| --- | --- |
| 任意电脑向 `main` 推送新提交或合并 PR | 另一台电脑在下次使用 `main` **开展开发、验证、发布之前**检查并快进同步 |
| PC2（或 PC1）仅推送 `feature/xxx` | 另一台电脑无需更新自己的 `main`；需要评审/协作时 `fetch` 该分支 |
| GitHub PR 已创建但尚未合并 | 评审人 fetch PR 分支做审查；不要把它当作主干更新 |
| PR 合并进入 `main` | 两台电脑下一次使用 `main` 时应更新 |
| 本机正有未提交改动、运行中的开发或需要保留的实验 | 先保护工作，再决定何时同步；不执行后台自动 `pull` |
| 远端没有本机需要的分支变化 | 可不更新；不因日期而强制重新安装或克隆 |

**推荐：事件通知 + 开工前检查 + 安全快进。** 不在无人确认目标分支与工作树状态时自动将远端变更写入本机。`git fetch` 更新远端跟踪引用，不修改工作树；`git pull` 会尝试更新当前分支/工作树，两者不同。

## 4. 主干安全更新 SOP（任意电脑）

只在仓库和远端已核实、当前分支为 `main`、没有未保存改动的条件下，执行：

```powershell
git status --short --branch
git remote -v
git fetch origin main
git merge-base --is-ancestor HEAD origin/main
git merge --ff-only origin/main
git status --short --branch
git rev-parse HEAD
git rev-parse origin/main
```

- `merge-base --is-ancestor` 的退出码必须为 0，才进入快进阶段；非 0 时暂停并诊断，不强行合并。
- `git merge --ff-only` 仅允许快进，不产生额外合并提交；在干净工作树中 `git pull --ff-only` 可作为简写，但要先确认远端/分支及状态。
- `fetch` / `merge` 失败时根据真实失败状态处理；网络故障、分支分叉和修改冲突不是同一类错误。
- 如果本地分支领先远端、发生分叉或有改动，停止自动更新并记录差异；**不要**擅自 `git reset --hard`、`git clean -fd`、强制 push、rebase、删除分支或覆盖历史。
- 需要保留改动时，先按文件清单和校验记录做定向备份，再在授权范围内选择功能分支、`git stash push -u` 或其他非破坏方法；**不要未经核对直接将旧 stash pop 到新 main**。
- 更新代码**不会**自动重新安装 Eagle 插件、重启 Chrome、迁移素材库或同步两台电脑的登录状态。

## 5. 功能分支 → 验证 → PR → main

建议新任务流程（具体权限以用户当前授权为准）：

```powershell
git switch main
git status --short --branch
git fetch origin main
git merge --ff-only origin/main
git switch -c feature/short-topic
```

1. 在功能分支修改源码、文档或测试；勿把试验代码长期堆在 `main`。
2. 先运行相关测试、按需做一轮真实场景验证，说明复现方法和已知缺口。
3. 获得**提交授权**后检查 staged 文件及敏感/本机数据范围，才执行 `git commit`；获得**推送授权**后才推送，例如 `git push -u origin feature/short-topic`。
4. 在 GitHub 发起 PR，审查差异、依赖、回归测试和 Windows CI，得到合并授权后合入 `main`。若尚未授权 PR 或合并，停留在本地/远端功能分支即可。
5. PC1、PC2 **分别**在下次使用 `main` 前做安全快进；完成验证并报告实际状态。无需重复克隆整个仓库。

PC1 默认承担主仓评审和发布，但 PC2 也可在获明确授权后推送独立功能分支。若特殊情况允许从 PC2 直接推 `main`，应使用与 PC1 相同的测试、审核与风险规则；PC1 随后同样需要同步 `main`。

## 6. 本机数据与发行边界

这些内容是**各机器的本机状态**，不是两个 Git 工作树之间可直接复制的代码：

- `config/local.json`：每台电脑自己的路径与运行配置，不进 Git；
- `runtime/`（Chrome Profile、日志、本机 Agent SOP、备份）、`data/`（商品索引与回执）、`output/`（图片）、`node_modules/` 和 `release/`：不随 `pull` 更新，不因切换分支而清理；
- Eagle 素材库及插件实际安装状态：单独维护、单独验证，不通过 Git 复制数据库；
- 公开仓库只允许受控白名单内的源码、通用文档与测试文件；提交前执行公开文件审核。

**PC1 / PC2 本机补充**应放在被 Git 忽略的 `runtime/agent-guides/`，不要把个人电脑路径、隧道凭据或本机采集素材写入公共 SOP。改变本机环境、增删依赖或批量清理需要对应任务授权。

## 7. 跨电脑同步后的验收

按实际变更范围至少核验：

```powershell
git status --short --branch
git rev-parse HEAD
git rev-parse origin/main
node --test tests/*.test.mjs
node scripts/capture.mjs --self-test
node scripts/ecom.mjs doctor
```

- 通过 Git SHA 一致确认**源代码同步**；通过实际测试结果确认**本机回归**。不要把 PC1 的通过记录当作 PC2 已经通过。
- 若 Chrome 项目浏览器处于 stopped，先用 `node scripts/browser.mjs status` 诊断；确有授权再启动专用 Chrome，然后复查 doctor。
- `doctor=ready` 仅意味着依赖/API 环境可用，不等于已在当前机器完成新商品采集、登录会话或 Eagle GUI 操作验收。
- 准备公共发布时再按 `docs/GITHUB-RELEASE.md` 完成白名单、插件构建、独立 ZIP、CI 和跨设备 E2E 门槛。
- 任何 Agent 的最终报告应包括：电脑、项目路径、分支、旧/新 SHA、是否有本机改动、远端是否同步、实际测试/诊断结果、保留的备份和仍待完成的事项。

## 8. 发生冲突时的停止条件

- **dirty main**：不直接拉取。先区分代码试验与本机数据，保留有价值的独有变更；再按授权整理或暂存。
- **diverged history**：不允许盲目 `pull`、`rebase` 或强制覆盖；先说明双方新提交与候选处理方式，交由有权限的维护者决定。
- **stash/备份存在**：仅作为恢复证据，先 `git stash show` 或审阅备份差异；不可对正式版无差别重放。
- **更新中断**：先查 `git status`、`HEAD`、`origin/main` 和文件状态，判断是否已经成功；避免不确定操作的重复写入。
- **工作流自动化**：可提醒或通知“main 已变化”，不允许默认无人值守修改工作树、重启软件、重跑有副作用的采集或自动 push。

## 9. 给接手 Agent 的交接范式

> 当前目标：[检查 / 更新 main / 开发功能 / 提交 / 推送 / PR 评审]。
> 电脑与仓库：[从真实连接读取]。先读本项目 `AGENTS.md`、本 SOP 和当前电脑本机指南。
> 确认当前分支与 dirty 状态；按权限做最少步骤。更新只能安全快进；分支开发与正式版隔离。
> 保留 `config/local.json`、`runtime/`、`data/`、`output/`、Eagle 真实素材及历史回执。
> 报告已检查、已修改、已验证及待办；不得将“已推送”误报为“另一台电脑已经更新”。

**维护原则：** 本文件是跨电脑 Git 协作的唯一公共规范；每台电脑只在本机忽略目录保留自己的连接、路径和历史恢复信息。新增流程先更新本文件，避免 PC1 和 PC2 维护两套相互矛盾的公共规则。
