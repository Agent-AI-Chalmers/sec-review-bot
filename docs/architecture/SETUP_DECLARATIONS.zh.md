# 设置声明

语言：[English](SETUP_DECLARATIONS.md) | 中文

本文是 [SETUP_DECLARATIONS.md](SETUP_DECLARATIONS.md) 的中文译文。英文版是权威版本；如果两者不一致，以英文版为准。

仓库可以声明如何准备它被审查时所用的沙箱。该声明是仓库 **默认分支** 上 `.sec-review/setup.yml` 处的一个小型 YAML 文件。一次审查运行时，声明会在 agent 启动前于 Docker 沙箱内执行，因此 agent 一开始就处于依赖已安装好的环境。声明是可选的；没有声明的仓库会在无声明环境中被审查。

## 声明格式

该格式由它自己的契约规定：**[contracts/setup-declaration/v1/SPEC.md](../../contracts/setup-declaration/v1/SPEC.zh.md)**。那份规范、它旁边的共享测试语料，以及代码里的两个解析器一起变更。不要在这里重述逐字段的格式——本页讲的是声明如何到达沙箱、如何运行，以及信任与运维边界。

有两个格式层面的要点在架构层面值得说明：

- **空白内容表示"无声明"。** 空文件或只含空白的文件会被完全当作文件不存在；这不是错误。
- **非法内容会让运行失败。** 一个存在、非空白、且不符合格式的文件，是默认分支上的维护者错误。它会在运行被提交**之前**被拒绝，并附带仓库/ref/路径信息，运行被标记为失败（`SETUP_DECLARATION_INVALID`）。它不会静默降级为未 bootstrap 的环境——那会让 agent 在一个依赖从未安装的仓库上做判断。这与非法 `.sec-review/config.yml` 的处理方式一致。

## 规则归谁管

**GitHub integration 掌管内容规则**，因为它是 runner workflow input 的生产者，必须产出满足 runner 契约的东西。它会用与 runner 相同的 allow-list 校验声明，并以可归因的方式拒绝非法声明。runner 随后会再次解析文本作为纵深防御，并执行它。两端测试都会跑同一份语料（`contracts/setup-declaration/v1/corpus/`），因此两套实现不会悄悄漂移。

本地运行（`run-local-*`）会通过 runner 自己的解析器校验文件，因此本地声明会以与仓库默认分支声明相同的方式失败。

## 声明如何到达沙箱

声明以 **内联文本** 承载，而不是文件路径：

1. GitHub integration 从 base 仓库的默认分支读取 `.sec-review/setup.yml`，校验它，并把它的 **内容** 放进 workflow input 的可选顶层字符串字段 `setup_declaration`。
2. runner 将该字符串沿 workflow 向下传递。input bundle 中没有声明文件，manifest 中没有对应字段，容器中也没有对应挂载。
3. 在 agent 运行前，每个 stage 解析该字符串并在沙箱内执行其步骤。

由于内容是内联的，不存在"声明文件未找到"这一路径；声明特有的失败模式只有"提交前被判为非法"和"某一步在执行时失败"。

## 执行语义

- **仅限 Docker。** 只有 Docker 后端会执行声明，因为它的容器是长驻的，一次 bootstrap 会服务于整个 stage。在其他后端上声明不生效。
- **尽力而为。** 某一步失败会停止其余步骤并把环境标记为不完整，但审查仍会继续。
- **记录而非静默。** stage 会在其其他产物旁写入 `environment.json`，包含 `setup_status`（`not_declared`、`completed` 或 `incomplete`）、`environment_incomplete`，以及每个步骤的退出码和截断后的输出。输出是截断的，**不是脱敏的**：运维可见，且可能包含安装命令里的 registry URL 或 token。
- **不交给 agent。** 声明及其结果不会放进 agent 的上下文；agent 依据仓库进行推理。

bootstrap 期间可用的网络是部署方的基线（`AGENT_DOCKER_NETWORK_MODE`），仓库无法放宽它。当基线拒绝网络时，需要联网的声明会以环境不完整告终。

### 运维说明

- **隔离。** 声明在与 agent 相同的容器、相同的用户、相同的网络下运行。它可以修改 `/workspace` 以及 agent 之后会读取的任何内容。声明只有能这样做才有用，因此不会再对它加沙箱。为一个新的 `setup_declaration` 来源开口子，等于把在 agent 容器内执行代码的能力交给该来源；请保持"只从默认分支读取"的规则。
- **输出持久化。** `environment.json`（含每步截断后的输出）写入运维本地的 artifact 目录（`.agent-artifacts` / `SEC_REVIEW_AGENT_ARTIFACT_ROOT`），不会发送到 GitHub。预期的读者是运维，因此输出不做脱敏；一个会把 registry token 回显出来的声明会把它持久化在那里。请把 artifact 目录视为包含凭据的运维数据。
- **空声明。** 存在但只含空白的 `.sec-review/setup.yml` 会被当作不存在，因此一个装饰性的文件不会让运行失败。

## 信任边界

对声明来源的信任由 **上游** 决定，即 GitHub integration：它从 base 仓库的默认分支读取声明，绝不从 fork 或载荷提供的 ref 读取。runner 不会就来源对声明做认证；它严格解析文本并执行。带外提供声明的调用方——例如 `run-local-*` 命令——自行负责其来源。

## 本地运行

`run-local-issue`、`run-local-pr` 和 `run-local-repository` 命令接受 `--setup-declaration <path>`。它们读取该文件一次并以内联方式传递其内容，方式与 integration 相同。声明只在 Docker 后端上执行；在任何其他后端上，命令会给出警告并将其忽略。

`.sec-review/config.yml` 是仓库的触发配置（`trigger_mode`、`paths_ignore`）。它与 `.sec-review/setup.yml` 相互独立，由 GitHub integration 读取，而不是由 runner 读取。
