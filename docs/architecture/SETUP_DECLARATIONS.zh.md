# 设置声明

语言：[English](SETUP_DECLARATIONS.md) | 中文

本文是 [SETUP_DECLARATIONS.md](SETUP_DECLARATIONS.md) 的中文译文。英文版是权威版本；如果两者不一致，以英文版为准。

仓库可以声明如何准备它被审查时所用的沙箱。该声明是仓库 **默认分支** 上 `.sec-review/setup.yml` 处的一个小型 YAML 文件。一次审查运行时，声明会在 agent 启动前于 Docker 沙箱内执行，因此 agent 一开始就处于依赖已安装好的环境。声明是可选的；没有声明的仓库会在无声明环境中被审查。

## 声明格式

```yaml
setup:
  - run: pip3 install --no-input uv
    timeout_seconds: 300
  - run: uv sync --frozen
    working-directory: agents
    timeout_seconds: 600
```

顶层：

- `setup`：必填；一串按顺序执行的步骤。

每个步骤：

| Key | Required | Meaning |
| --- | --- | --- |
| `run` | yes | 在容器中执行的 shell 命令。 |
| `working-directory` | no | 相对于仓库根的目录。必须留在根内（不得为绝对路径，也不得含 `..`）。默认为仓库根。 |
| `env` | no | 环境变量名到值的映射，在 `run` 之前导出。变量名必须是合法的 shell 标识符。 |
| `timeout_seconds` | no | 每步超时。默认 300，并以 `SEC_REVIEW_SETUP_STEP_MAX_SECONDS`（默认 600）为上限。 |

解析是严格的：任何超出该 schema 的内容——未知键、非列表的 `setup`、非法的环境变量名、缺失 `run` 的步骤——都会拒绝整份声明，而不是将其忽略。

## 声明如何到达沙箱

声明以 **内联文本** 承载，而不是文件路径：

1. GitHub integration 从 base 仓库的默认分支读取 `.sec-review/setup.yml`，并把它的 **内容** 放进 workflow input 的可选顶层字符串字段 `setup_declaration`。
2. runner 将该字符串沿 workflow 向下传递。input bundle 中没有声明文件，manifest 中没有对应字段，容器中也没有对应挂载。
3. 在 agent 运行前，每个 stage 解析该字符串并在沙箱内执行其步骤。

由于内容是内联的，唯一的失败模式是解析错误。不存在"声明文件未找到"这一路径。

## 执行语义

- **仅限 Docker。** 只有 Docker 后端会执行声明，因为它的容器是长驻的，一次 bootstrap 会服务于整个 stage。在其他后端上声明不生效。
- **尽力而为。** 某一步失败会停止其余步骤并把环境标记为不完整，但审查仍会继续。
- **记录而非静默。** stage 会在其其他产物旁写入 `environment.json`，包含 `setup_status`（`not_declared`、`completed` 或 `incomplete`）、`environment_incomplete`，以及每个步骤的退出码和截断后的输出。输出是截断的，**不是脱敏的**：运维可见，且可能包含安装命令里的 registry URL 或 token。
- **不交给 agent。** 声明及其结果不会放进 agent 的上下文；agent 依据仓库进行推理。

bootstrap 期间可用的网络是部署方的基线（`AGENT_DOCKER_NETWORK_MODE`），仓库无法放宽它。当基线拒绝网络时，需要联网的声明会以环境不完整告终。

## 信任边界

对声明来源的信任由 **上游** 决定，即 GitHub integration：它从 base 仓库的默认分支读取声明，绝不从 fork 或载荷提供的 ref 读取。runner 不会就来源对声明做认证；它严格解析文本并执行。带外提供声明的调用方——例如 `run-local-*` 命令——自行负责其来源。

## 本地运行

`run-local-issue`、`run-local-pr` 和 `run-local-repository` 命令接受 `--setup-declaration <path>`。它们读取该文件一次并以内联方式传递其内容，方式与 integration 相同。声明只在 Docker 后端上执行；在任何其他后端上，命令会给出警告并将其忽略。

`.sec-review/config.yml` 是仓库的触发配置（`trigger_mode`、`paths_ignore`）。它与 `.sec-review/setup.yml` 相互独立，由 GitHub integration 读取，而不是由 runner 读取。
