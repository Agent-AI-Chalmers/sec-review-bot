# Agent 能力边界

语言：[English](CAPABILITY_BOUNDARIES.md) | 中文

本文是 [CAPABILITY_BOUNDARIES.md](CAPABILITY_BOUNDARIES.md) 的中文译文。英文版是权威版本；如果两者不一致，以英文版为准。

agent 处理的是这次交给它的仓库里、能通过 patch 修掉的安全问题。它不负责治理 git 历史、外部系统状态，也不负责需要组织协调的安全运营动作。

## 系统 scope 对应关系

默认情况下，agent 只处理仓库内能看见、能修改的问题：源码里的漏洞、仓库里的安全配置、以及可以通过仓库内控制修正的安全缺陷。

这意味着以下问题可以进入自动修复候选：

- 当前源码中的 injection、authorization、unsafe data exposure、input handling 等 application-layer 漏洞。
- 当前仓库文件中的安全相关配置缺陷，例如 Dockerfile 默认 root 用户、unsafe framework defaults、缺失的安全 header 配置。
- 当前源码中仍存在的 hardcoded secret、credential sample 或危险默认值。
- 可以通过当前文件 patch 阻止未来继续发生的泄露或误配置。

以下问题不属于 agent 可完整处理的范围，最多作为 manual follow-up、residual risk 或 out-of-automation-scope 事项表达：

- 只存在于 git history 中的 secret、敏感文件或历史 artifact。
- secret rotation、token revocation、credential invalidation。
- force push、history purge、fork cleanup、cache purge。
- 已发布 package、container image、CI log、registry 或部署环境中的历史副本清理。
- OS、network protocol、cloud infrastructure、deployment environment 层面的治理。
- comprehensive secret scanning、supply-chain scanning、dependency upgrade management。

## 核心判断

agent 可以修改的是本次运行提供的当前文件，并把这些修改固化为可审计的 patch。patch 能表达这些当前文件的变化，但不能表达已经发生过的历史传播是否被撤销。

agent 不应该把以下操作当成自动修复能力：

- 重写 git 历史，例如 `git rebase`、`git filter-repo`、`git filter-branch`。
- 删除、改写、重排既有 commit / tag / remote ref。
- force push 或任何需要仓库管理员协调的历史替换流程。
- 清理已经传播到 fork、clone、CI log、package registry、container registry、cache、部署环境或第三方系统里的历史数据。

换句话说，agent 的 patch 可以改变“从现在开始仓库长什么样”，但不能保证“过去没有发生过”。历史已经泄露的 secret、历史 commit 中的大文件、旧 artifact 中的敏感数据，通常需要人工治理和仓库管理员权限。

## 为什么不自动修 git 历史

历史重写不是普通代码修复，它有几个明显不同的性质：

- **影响范围超出 workspace**：本地工作区里的改动无法覆盖 remote、fork、clone、cache、registry、CI log 等外部状态。
- **需要组织协调**：force push、secret rotation、token revocation、fork cleanup、cache purge 通常需要权限、窗口期和人工确认。
- **容易破坏协作语义**：重写 commit 会影响 PR、branch、tag、release、downstream clone 和审计记录。
- **修复证据不可由普通 patch 表达**：一个 diff 可以证明当前文件不再含 secret，但不能证明所有历史副本都已清理。
- **容易诱导 agent 空转**：在重整过的本地仓库或 limited history workspace 中，agent 可能尝试大量 git 命令，却无法完成真实治理。

因此，git history remediation 应该被视为 manual administrative action，而不是 agent 自动 patch 的一部分。

## 分类决策表

| 问题类型 | 分析阶段 | 修复阶段 | 验证阶段 | 交付表达 |
| --- | --- | --- | --- | --- |
| 当前源码中的 application-layer 漏洞 | 可以基于 repository evidence 确认或驳回 | 可以修改当前源码形成 patch | 验证 patch 是否覆盖当前源码中的 in-scope claim | 交付 patch 和验证摘要 |
| 当前源码中的 hardcoded secret | 可以确认本次运行提供的当前文件中仍暴露 | 可以删除当前 secret、替换样例、增加防复发规则 | 验证当前文件不再暴露，并指出 rotation 是否仍需要人工处理 | 交付当前文件 patch，并表达 rotation / revocation follow-up |
| secret 只存在于 git history | 可以报告为历史治理问题，但不应伪装成普通源码缺陷 | 不重写历史；最多增加当前文件层面的防复发控制 | 不要求 patch 通过历史重写获得 full coverage | 表达 manual follow-up，例如 history purge、rotation、fork/cache cleanup |
| 仓库内安全配置缺陷 | 可以作为当前仓库配置缺陷确认 | 可以修改配置或相关启动文件 | 验证 patch 是否改变当前配置语义 | 交付 patch |
| cloud / deployment / OS / network 配置问题 | 只有仓库内配置直接决定时才进入候选；否则标为 out-of-scope | 不凭空修改外部环境 | 不把缺少外部治理证明当作源码 patch 失败 | 表达为 manual / external action |
| dependency CVE 或供应链升级 | 通常不作为默认自动修复目标，除非任务明确要求依赖升级 | 不自动大范围升级依赖或 lockfile | 不把未完成依赖治理当作当前 patch 缺陷 | 标注为 out-of-automation-scope 或 manual follow-up |
| 已发布 artifact / registry / cache 泄露 | 可以指出当前仓库证据能支持的风险 | 不声称通过源码 patch 清理外部副本 | 区分当前文件层面的 mitigation 与外部清理缺口 | 表达外部清理动作 |

## agent 仍然可以做什么

如果一个历史问题在当前仓库里还有能补的地方，agent 可以做这些防复发修复：

- 从当前文件删除仍存在的 secret、token、凭据或敏感样例。
- 增加 `.gitignore`、secret scanning 配置、pre-commit 配置或生成规则。
- 修改代码或配置，避免继续生成、提交、打印或打包敏感数据。
- 在结果中明确提示需要 secret rotation、token revocation、history purge、cache purge、fork cleanup 等人工动作。
