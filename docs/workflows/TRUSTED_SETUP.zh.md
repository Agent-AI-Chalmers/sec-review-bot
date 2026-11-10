# 受信来源的环境准备

语言：[English](TRUSTED_SETUP.md) | 中文

本文为 [TRUSTED_SETUP.md](TRUSTED_SETUP.md) 的中文译文；如有差异，以英文版为准。

仓库可以在**默认分支**的 `.sec-review/setup.yml` 中声明如何准备审查环境。本文解释**为什么**只接受这一来源、如何处理 fork 请求，以及声明在哪些执行条件下运行。文件格式见独立的[setup-declaration](../../contracts/setup-declaration/README.zh.md)。

## 要解决什么问题

通用 Docker 沙箱镜像**不预装每个被审查仓库的依赖**。缺少依赖时，Agent 可能无法运行测试；让它临时猜测安装方式，也容易遇到工具版本不符、安装耗时或结果不稳定等问题。

仓库维护者可以提供明确的准备步骤，由执行侧在 Agent 启动前运行。**这些步骤会执行命令**，所以除了定义文件格式，还要规定哪些来源可以提供它。

## 哪些来源可以被信任

**不同来源的权限不同**。属于同一仓库的内容不会因此自动被信任。

| 来源               | 选择依据                            | 本项目的限制                                     |
| ------------------ | ----------------------------------- | ------------------------------------------------ |
| 默认分支           | 由目标仓库维护者管理                | GitHub Integration **只从这里读取声明**          |
| PR 的 head 或 fork | PR 作者可以修改，尚未合并到目标分支 | 不从这里读取声明；审查 fork 代码需要逐次明确批准 |
| Webhook 请求数据   | 可能指向其他分支                    | 不使用其中的引用代替 API 解析出的默认分支        |
| 声明内容           | 可以执行命令                        | 严格校验格式，在受限的沙箱内执行                 |
| 网络               | 仓库代码可能滥用网络访问            | 由部署配置规定，仓库或 fork 不能自行扩大权限     |

## 如何落实这些限制

### 只从默认分支读取声明

本项目从目标仓库的默认分支读取声明。PR 作者可控制的内容不会用作环境准备指令。

- **通过 API 解析默认分支。** Issue、PR 和仓库审查入口都根据仓库身份，向 GitHub 获取 `{default_branch, head_sha}`。解析失败就让任务失败，不使用 Webhook 中的引用兜底；请求里出现某分支的 SHA，并不能证明它是默认分支。
- **PR 使用 base 仓库。** 以 `base_repo_full_name` 标识目标仓库，不从 head 仓库或 fork 读取声明。虽然待审查工作区使用 PR head 的代码，准备步骤仍来自目标仓库的默认分支。

同理，也不从已检出的工作区读取声明。API 失败后改用请求数据或工作区，会改变受信来源，不能作为自动回退方案。

<!-- doc-time-sensitive: copilot-setup-default-branch; checked=2026-11-09; source=https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/customize-the-agent-environment -->

GitHub Copilot 要求 setup steps 文件存在于默认分支，见[官方说明](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/customize-the-agent-environment)。本项目的具体读取与校验规则由 GitHub Integration 实现。

### fork 审查需要逐次批准

fork PR 的 `opened`、`ready_for_review` 和 `synchronize` 事件不会自动触发审查。具有仓库写权限的维护者评论 `@<bot> review`，才会发起一次审查。每条评论单独授权本次任务，不保存为后续任务的批准记录。

这条评论是唯一的批准信号，本项目不复用 GitHub 其他功能中的批准状态。

批准后，声明仍从 base 仓库的默认分支读取，网络模式仍由部署配置决定。fork 不能替换这份声明，也不能修改部署网络策略；这不代表 fork 中待审查的代码不再具有风险。`from_fork` 只触发批准要求。它不判定内容是否恶意，也不放宽其他限制。

### 声明与仓库代码都在沙箱内运行

声明是可执行内容，其来源受控并不等于内容必然安全。执行侧为使用沙箱的阶段分别创建容器，使用唯一名称和 `--rm`；只挂载已声明的目录视图，也不通过宿主机环境继承跨仓库凭据或 App 私钥。

挂载接口只接受目录，不能直接挂载单个私钥文件；这条格式限制不等于能阻止秘密出现在目录、镜像或声明中。部署方仍需保证提供给沙箱的内容不含不应暴露的凭据。联网时，容器隔离也不能代替网络访问策略。

项目没有采用“永久断网沙箱加宿主机依赖缓存填充器”的方案。网络模式**由部署方选择**，默认为 **`none`**。

### 网络权限由部署方决定

<!-- doc-default: AGENT_DOCKER_NETWORK_MODE; source=agents/src/sec_review_agents/filesystem/docker_runtime.py -->

**部署方**通过 `AGENT_DOCKER_NETWORK_MODE` 控制沙箱网络，默认 `none`。仓库和 fork 不能通过声明修改该配置，也不能给自己授予超出部署策略的网络权限。

## 其他设计选择

以下选择涉及环境准备方式，与来源是否可信无关。

**通用镜像不预装各仓库依赖。** 镜像提供隔离环境和通用工具，仓库自己的安装步骤由声明描述，避免为不同语言、框架和仓库不断扩充镜像。

**Agent 不在 GitHub Actions 中执行。** 审查运行在执行节点的容器中；Actions 只负责触发任务，不承载耗时较长的模型调查和环境安装。

**使用本项目的声明格式。** `.sec-review/setup.yml` 只描述环境准备所需的信息。不直接读取 `.github/workflows/copilot-setup-steps.yml` 等其他系统的配置，以免为了提取安装命令而实现 Actions YAML、`uses:` 等额外语义。

**各沙箱分别准备环境。** Analyzer、Mitigator 和 Verifier 等 Agent 使用各自的沙箱，在执行时分别运行声明；仓库审查中，不同 case 也分别执行。沙箱之间不共享依赖缓存。声明应能重复执行且尽量快速。`SEC_REVIEW_SETUP_STEP_MAX_SECONDS` 限制每次执行中单步的最长耗时，不限制总执行次数。

**不根据仓库文件猜测安装命令。** 只有显式声明才触发环境准备，不根据 lockfile 或目录惯例自动运行安装脚本，也不提供默认开启的猜测兜底。没有声明时保留基础沙箱环境，不自动安装该仓库的依赖。
