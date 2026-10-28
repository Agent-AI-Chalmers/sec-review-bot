# 设置声明

语言：[English](README.md) | 中文

本文是 [README.md](README.md) 的中文译文。英文版是权威版本；如果两者不一致，以英文版为准。

本 family 持有仓库用来告诉审查沙箱在 agent 启动前如何准备自己的格式：`.sec-review/setup.yml` 声明。

使用这些文档：

- [v1/SPEC.md](v1/SPEC.zh.md)：格式、其合法性规则，以及相互独立的执行者。
- [v1/corpus](v1/corpus)：Python 与 TypeScript 测试套件共享的输入文件，以及记录必须接受和必须拒绝哪些用例的 manifest。

## 边界

声明跨越 **GitHub Integration**（生产者）与 **Execution Worker**（消费者）之间的边界：

- GitHub Integration 从 base 仓库的默认分支读取 `.sec-review/setup.yml`，按本格式校验它，并在提交运行前拒绝非法声明。
- Execution Worker 作为纵深防御对同一段文本再次校验，然后在沙箱内执行它。

本契约只涉及 *格式*。声明来自哪里——对其来源的信任——不在其中：那由 integration 读取默认分支来决定，绝不使用 fork 或载荷提供的 ref。

## 强制方式

本 family 没有 JSON Schema。真正要紧的规则是决策逻辑（`working-directory` 不能逃出仓库根、`env` 名不能夹带 shell 语法、timeout 为正整数），而不是结构形状，因此它们留在 Execution Worker 与 GitHub Integration 的解析器里，而不是留在可能与之不一致的 schema 里：

- Python（Execution Worker）：`agents/src/sec_review_agents/entrypoints/setup_declaration.py`
- TypeScript（GitHub Integration）：`apps/github-integration/src/github/setup-declaration.ts`

Execution Worker 与 GitHub Integration 都会在测试中执行共享语料。新增一条规则，就意味着向 [v1/corpus](v1/corpus) 新增一个用例，并让各自的执行者通过它，因此这些实现不会悄悄漂移。

空白内容也是边界的一部分：空或只含空白的声明是合法的，并且在各个实现中都表示"无声明"。

## 谁拥有本 family

Execution Worker 与 GitHub Integration 共同拥有声明格式，因为两者都强制它，且都必须就“什么是合法的声明”达成一致。规范与语料一起变更。
