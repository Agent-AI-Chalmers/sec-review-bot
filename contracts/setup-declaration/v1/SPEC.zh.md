# 设置声明 — v1

语言：[English](SPEC.md) | 中文

本文是 [SPEC.md](SPEC.md) 的中文译文。英文版是权威版本；如果两者不一致，以英文版为准。

设置声明告诉审查沙箱在 agent 启动前如何准备自己。它是仓库放在 **默认分支** 上 `.sec-review/setup.yml` 处的一个小型 YAML 文件。一次审查运行时，声明会在 agent 启动前于 Docker 沙箱内执行，因此 agent 一开始就处于依赖已安装好的环境。

声明是可选的。没有声明的仓库会在无声明环境中被审查。

## 格式

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
| `run` | yes | 在容器中执行的 shell 命令。必须是非空字符串。 |
| `working-directory` | no | 相对于仓库根的目录。必须留在根内（不得为绝对路径，也不得含 `..`）。默认为仓库根。 |
| `env` | no | 环境变量名到字符串值的映射，在 `run` 之前导出。变量名必须是可移植的 shell 标识符（`[A-Za-z_][A-Za-z0-9_]*`）。 |
| `timeout_seconds` | no | 每步超时。默认 300。必须是正整数；runner 会把生效值以 `SEC_REVIEW_SETUP_STEP_MAX_SECONDS`（默认 600）为上限。 |

## 合法性规则

解析是严格的。任何超出上述格式的内容都会被拒绝，而不是被静默忽略：

- 顶层必须是只含 `setup` 键的映射；
- `setup` 必须是映射的列表（每个映射是一个 step）；
- 每个 step 只能携带 `run`、`working-directory`、`env`、`timeout_seconds`；
- `run` 必填且必须是非空字符串；
- `working-directory` 若存在，必须是非空字符串、相对路径、且留在仓库根内（不得以 `/` 开头，不得含 `..` 片段）。包含性是对声明路径的词法检查，不解析软链接：仓库内部的软链接不会被这条规则跟随（声明是受信内容，因此这是包含性约束，不是沙箱）；
- `env` 若存在，必须是字符串键到字符串值的映射，键需匹配上面的标识符模式。键和值都必须是*在两种 YAML 方言下都为字符串*：YAML 1.1 会读成布尔值的 plain 标量（`on`、`yes`、`off`、`no` 等）会被拒绝，即便 YAML 1.2 把它读成字符串。如果那确实是想要的名称或值，就要加引号（`"on"`）。同一条更严格的读法也适用于 `run` 与 `working-directory`（见"标量与 YAML 方言"）；
- `timeout_seconds` 若存在，必须是正整数（布尔不算整数）。

**空白内容不是声明。** 空文件或只含空白的文件会被完全当作文件不存在：它合法，且表示"无声明"。这不是错误。

**声明文本有大小上限。** 校验后的文本会内联进 workflow input，因此上限为 64 KiB（UTF-8）。integration 在提交前拒绝超限文件；runner 与 input schema 携带同一上限。超过这个量的声明做的事情太多了。

## 两个执行者

该格式由两个相互独立、且必须一致的实现共同强制：

- **Runner** 解析器，Python（`agents/src/sec_review_agents/entrypoints/setup_declaration.py`）；
- **GitHub integration** 校验器，TypeScript（`apps/github-integration/src/github/setup-declaration.ts`）。

它们在相同的规则上承担不同的职责：

- **integration 在生产端掌管内容规则**：它从 base 仓库的默认分支读取文件、校验它，并在提交运行**之前**拒绝非法声明——附带仓库、ref 和路径。默认分支上的 `.sec-review/setup.yml` 写坏了，是维护者错误，应当大声失败，而不是静默降级成未 bootstrap 的环境。
- **runner 作为纵深防御再次校验**，然后再执行。某一 *step* 失败是尽力而为的 `incomplete` 环境（审查仍会继续）；而声明在 runner 处**无法解析**会让运行失败，因为它要求的环境根本无法准备。integration 先拒绝，正是让"runner 处无法解析"成为兜底的原因：这种情况只应发生在两个执行者产生分歧时（见"标量与 YAML 方言"），或带外调用方送入了未经验证的文本。

该契约没有 JSON Schema。真正要紧的规则——`working-directory` 不能逃出根、`env` 名不能夹带 shell 语法、timeout 必须是正整数——是决策逻辑，而不是结构形状。把它们表达为 JSON Schema 会产生第二份定义（"schema 说合法、解析器说不行"），而这正是本仓库契约规则明确要避免的：schema 只管结构形状，跨字段与策略规则留在强制它们的代码里。

## 语料

[`corpus/`](corpus) 存放两套实现测试共享的输入文件，[`corpus/manifest.json`](corpus/manifest.json) 记录每一侧必须接受和必须拒绝的用例。Python 与 TypeScript 测试套件都执行同一批文件，因此两套实现不会悄悄漂移。

该语料是格式的可执行边界。新增一条规则，就意味着在这里新增一个用例，并让两个执行者都通过它：只有两个实现**必须得到相同分类**的用例才属于这里。

### 标量与 YAML 方言

两个执行者使用不同的 YAML 库，而这两个库实现不同的标量解析规则：

- runner 使用 PyYAML（YAML 1.1），其中 `on`、`yes`、`off`、`no` 解析为布尔值；
- integration 使用 `yaml` 库（YAML 1.2），其中同样的词解析为字符串。

两个库无法在每一个有歧义的标量上达成一致（每个库的"version"选项只是把一个分歧换成另一个），语料也不能收录"类型本身就是被检验对象"的标量——两个执行者会读出不同的类型。因此执行者不依赖两个库达成一致，而是对所有**必须为字符串**的位置，在两侧都采用*更严格*（YAML 1.1）的读法：

- `env` 的 *键* 与 *值*；
- `run`；
- `working-directory`。

在这些位置，YAML 1.1 会解析成布尔值的 **plain** 标量（`on`、`yes`、`off`、`no` 及其大小写变体）会被**双方**拒绝，即便 integration 所用的 YAML 1.2 库会把它读成字符串。加引号的 `"on"` 在两种方言中都是字符串，会被接受。两种方言下都为非字符串的值——未加引号的布尔（`true`）、数字（`123`）和 `null`——已由值级类型检查拒绝。这样在整个字符串值表面上，"integration 接受了它" 与 "runner 能解析它" 就是同一句话：integration 无法接受一个 runner 随后拒绝执行的声明。

`timeout_seconds` 是唯一的数字位置，不受影响：它必须是正整数，而类布尔词在两种方言中都不是整数。

因此给作者的实用规则是：**任何可能被读成非字符串的值都要加引号**——`run: "on"`、`working-directory: "no"`、`env: { FLAG: "off" }`。语料同时覆盖边界两侧：未加引号的类布尔标量对应 `invalid-boolean-like-run.yml`、`invalid-boolean-like-working-directory.yml` 与 `invalid-boolean-like-env-value.yml`；类布尔键对应 `invalid-env-boolean-like-key.yml`；加引号形式对应 `valid-quoted-boolean-like-values.yml` 与 `valid-quoted-boolean-like-env-key.yml`。

每个实现都用一个测试钉住自己的方言，因此升级库若改变了标量解析，会直接让测试失败，而不是悄悄移动这条边界。

## 信任

声明是 **可执行的仓库内容**。对其 *来源* 的信任由上游决定，即 GitHub integration：它从 base 仓库的默认分支读取声明，绝不从 fork 或载荷提供的 ref 读取。本契约只管 *格式*；它不说明声明来自哪里。带外提供声明的调用方自行负责其来源。

由于声明在与 agent 相同的容器、相同的用户、相同的网络下运行，它可以修改工作区以及 agent 之后会读取的任何内容。这是有意的——声明只有能就地安装依赖才有用——但这也意味着，为声明新增一个来源，就是在 agent 容器中新增一条任意代码执行路径。
