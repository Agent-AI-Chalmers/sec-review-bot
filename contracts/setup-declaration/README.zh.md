# Setup 声明

语言：[English](README.md) | 中文

本文为 [README.md](README.md) 的中文译文；如有差异，以英文版为准。

仓库通过 `.sec-review/setup.yml` 说明如何在 Agent 启动前准备审查环境。本目录定义这份声明的格式。

相关文件：

- [SPEC](v1/SPEC.zh.md)：格式、有效性规则，以及两端分别如何校验。
- [v1/corpus](v1/corpus)：Python 和 TypeScript 测试共用的输入文件；清单记录每个用例必须被接受还是拒绝。

## 双方分别负责什么

声明由 **GitHub Integration** 读取并提交，由 **Execution Worker** 接收和执行：

- GitHub Integration 从目标仓库的默认分支读取 `.sec-review/setup.yml`，按本规范校验；声明无效时，在提交任务前报错。
- Execution Worker 再次校验同一段文本，作为额外防护，通过后在沙箱内执行。

本契约只规定格式，不决定来源是否可信。GitHub Integration 通过只读取默认分支、而不读取 Fork 或请求中指定的引用来限制来源。

## 如何校验

GitHub Integration 和 Execution Worker 分别在提交前与执行前应用相同的格式规则。两端测试使用共享的 [v1/corpus](v1/corpus) 检查接受与拒绝行为，包括路径范围和 YAML 标量处理。新增规则时，必须添加两端都通过的语料用例；本契约不另外维护 JSON Schema。

空文件或只含空白的内容是有效输入，两端都将其视为“没有声明”。

## 由谁维护

Execution Worker 和 GitHub Integration 共同维护这份格式，因为两端都要校验并对有效性作出相同判断。修改时同步更新规范和测试输入。
