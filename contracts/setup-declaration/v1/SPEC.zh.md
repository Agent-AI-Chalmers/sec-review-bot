# Setup 声明 — v1

语言：[English](SPEC.md) | 中文

本文为 [SPEC.md](SPEC.md) 的中文译文；如有差异，以英文版为准。

仓库在默认分支的 `.sec-review/setup.yml` 中声明环境准备步骤。执行侧在 Docker 沙箱内、Agent 启动前运行这些步骤，用于安装依赖和准备工作区。步骤失败和声明无法解析的处理方式不同，见下文。

声明是可选的。未提供时，不运行这些准备步骤，Agent 使用基础沙箱环境。

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

- `setup`：必填；按顺序执行的步骤列表。

每个步骤：

| 字段 | 是否必填 | 含义 |
| --- | --- | --- |
| `run` | 是 | 在容器中执行的 shell 命令。必须是非空字符串。 |
| `working-directory` | 否 | 相对于仓库根的目录。必须留在根内（不得为绝对路径，也不得含 `..`）。默认为仓库根。 |
| `env` | 否 | 环境变量名到字符串值的映射，在 `run` 之前导出。变量名必须是可移植的 shell 标识符（`[A-Za-z_][A-Za-z0-9_]*`）。 |
| `timeout_seconds` | 否 | 每步超时。默认 300。必须是正整数；Execution Worker 会把生效值以 `SEC_REVIEW_SETUP_STEP_MAX_SECONDS`（默认 600）为上限。 |

## 合法性规则

解析是严格的。任何超出上述格式的内容都会被拒绝，而不是被静默忽略：

- 顶层必须是只含 `setup` 键的映射；
- `setup` 必须是映射的列表（每个映射表示一个步骤）；
- 每个步骤只能携带 `run`、`working-directory`、`env`、`timeout_seconds`；
- `run` 必填且必须是非空字符串；
- `working-directory` 若存在，必须是非空字符串、相对路径、且留在仓库根内（不得以 `/` 开头，不得含 `..` 片段）。这里按路径文本检查是否越出根目录，不解析符号链接。该检查不能阻止路径经符号链接指向仓库之外，因此不是沙箱隔离保障；声明来源仍必须可信；
- `env` 若存在，必须是字符串键到字符串值的映射，键需匹配上面的标识符模式。声明使用 **YAML 1.2 Core schema** 解析，因此键和值必须在该 schema 下是字符串：`on`、`yes`、`off`、`no`、`y`、`n` 都是普通字符串，而 `true`、`123`、`null` 不是字符串，会被拒绝。这条规则同样适用于 `run` 与 `working-directory`（见"标量与 YAML 方言"）；
- `timeout_seconds` 若存在，必须是正整数（布尔不算整数），并且必须以整数语法书写：浮点语法的值（`1.0`、`1e3`）会被拒绝，判定依据是标量的源文本——因为 JS 会将其解析为整数值的 number，而 Python 会解析为 float，若不检查，两侧会产生分歧。十六进制/八进制整数（`0x10`、`0o10`）与带符号十进制数两侧都接受。

**空白内容不是声明。** 空文件或只含空白的文件会被完全当作文件不存在：它合法，且表示"无声明"。这不是错误。

**只有普通文件才是声明。** GitHub Integration 通过 Contents API 读取该路径，仅当 GitHub 报告该条目为文件时才接受。目录条目、符号链接（其 API `content` 是目标路径，而非文件内容）或任何其他非文件条目，都会被当作文件不存在：“无声明”。因此不会跟随符号链接形式的声明——希望提供声明的仓库需将其保持为 `.sec-review/setup.yml` 这个普通文件。

**声明文本有大小上限。** 校验后的文本会内联进工作流 input，因此上限为 64 KiB（UTF-8）。GitHub Integration 在提交前拒绝超限文件；Execution Worker 与 input schema 携带同一上限。

## 两端如何校验

该格式由两个独立实现分别校验，结果必须一致：

- **Execution Worker** 解析器，Python（`agents/src/sec_review_agents/entrypoints/setup_declaration.py`）；
- **GitHub Integration** 校验器，TypeScript（`apps/github-integration/src/github/setup-declaration.ts`）。

它们在相同的规则上承担不同的职责：

- **GitHub Integration 在提交前检查声明内容**：它从目标仓库的默认分支读取文件、校验它，并在提交运行**之前**拒绝非法声明——附带仓库、ref 和路径。默认分支上的 `.sec-review/setup.yml` 写坏了，是维护者错误，应明确报错，不能悄悄改为不执行环境准备。
- Execution Worker 会在执行前再次校验声明。声明无效时，任务失败；声明有效但某个准备步骤执行失败时，停止后续准备步骤，将环境标记为 `incomplete`，然后继续审查。

GitHub Integration 通常会在提交任务前拒绝无效声明。Worker 再次校验，是为了防止其他调用方绕过检查，也能发现两端校验结果不一致的情况。

该契约没有 JSON Schema。真正要紧的规则——`working-directory` 不能逃出根、`env` 名不能夹带 shell 语法、timeout 必须是正整数——是决策逻辑，而不是数据结构。把它们表达为 JSON Schema 会产生第二份定义（"schema 说合法、解析器说不行"），而这正是本仓库契约规则明确要避免的：schema 只管数据结构，跨字段与策略规则留在执行这些检查的代码里。

## 语料

[`corpus/`](corpus) 存放两套实现测试共享的输入文件，[`corpus/manifest.json`](corpus/manifest.json) 记录每一侧必须接受和必须拒绝的用例。Python 与 TypeScript 测试套件都执行同一批文件，因此两套实现的差异能够通过测试发现。

该语料是检验格式规则的共同依据。新增一条规则，就意味着在这里新增一个用例，并让两端实现都通过它：只有两个实现**必须得到相同分类**的用例才属于这里。

### 标量与 YAML 方言

两端实现都用 **YAML 1.2 Core schema** 解析声明：

- Execution Worker 在 PyYAML 之上使用 `yamlcore` 的 Core schema loader；
- GitHub Integration 使用 `yaml` 库并设置 `schema: 'core'`。

两侧都采用同一 YAML schema，并对源文本和类型作额外检查，以便对声明是否有效作出一致判断。特别地，在 Core schema 下 `on`、`yes`、`off`、`no`、`y`、`n` 都是**普通字符串**，不是布尔值——所以 `run: on` 就是命令字符串 `on`，`env: { yes: ok }` 会设置 `yes=ok`。未加引号的 `true`/`false` 是布尔值，`123` 是数字，`null`/`~` 是 null；它们在任何字符串位置（`run`、`working-directory`、`env` 的键与值）都会被拒绝，因为不是字符串。加引号总能强制成字符串（`run: "on"`），但对 Core schema 的这些词并非必须。

**显式标签会被拒绝。** 两侧都不接受显式标注的节点（`!!bool`、`!!int`、`!!str`、`!!seq`、`!!set` 等）。声明使用普通 Core schema，它已经会解析布尔、数字与 null，永远不需要显式标签；而且两个库对显式标签的处理并不一致（当标签对应的标量不匹配时，`yaml` 会静默回退为原始字符串，例如 `!!bool on` 解析为 `"on"`，而 `yamlcore`/PyYAML 会抛错）。拒绝一切显式标签，可让两端实现保持完全一致，并把畸形标签变成干净的声明错误，而不是内部异常栈。隐式解析不受影响：未加标签的 `on` 仍是字符串 `on`，未加标签的 `true` 仍是布尔值。

选 Core schema 的理由：

- 它是现代默认（YAML 1.1 的隐式类型——`on` 当布尔、`1_000` 和 `12:30` 当数字、日期当时间戳——已被有意移除）；
- 它符合实践（GitHub Actions 的工作流就直接写裸 `on:` 键）；

唯一不是 schema 差异的规则，是 `env` 的 **键** 解析为非字符串（`true`、`123`、`null`）。GitHub Integration 的 `toJS()` 会把这种键转换为字符串，得到看起来合法的名字，而 Execution Worker 保留其真实类型并拒绝，因此 GitHub Integration 也在语法树上、转换为字符串前拒绝它。这样在整个键空间上，“GitHub Integration 接受了它”与“Execution Worker 能解析它”就是同一句话。

语料覆盖这条边界：`valid-yaml12-word-strings.yml` 验证 Core schema 中这些词仍解析为字符串；`invalid-non-string-run.yml`、`invalid-non-string-working-directory.yml`、`invalid-env-value-boolean.yml`、`invalid-env-non-string-key.yml` 验证真正的布尔值和数字会被拒绝。

每个实现都有测试验证 schema 的解析行为，因此库若改变了标量解析，会直接让测试失败，而不是未被发现地改变接受和拒绝规则。

## 信任

声明是 **可执行的仓库内容**。对其 *来源* 的信任由上游决定，即 GitHub Integration：它从目标仓库的默认分支读取声明，绝不从 Fork 或请求中指定的 Git 引用读取。本契约只管 *格式*；它不说明声明来自哪里。通过其他入口提供声明的调用方自行负责其来源。

由于声明在与 Agent 相同的容器、相同的用户、相同的网络下运行，它可以修改工作区以及 Agent 之后会读取的任何内容。这是有意的——声明只有能就地安装依赖才有用——但这也意味着，为声明新增一个来源，就是在 Agent 容器中新增一条任意代码执行路径。
