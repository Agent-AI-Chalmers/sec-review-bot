# Control Plane API

语言：[English](README.md) | 中文

本文是 [README.md](README.md) 的中文译文。英文版是权威版本；如果两者不一致，以英文版为准。

本族收录 Control Plane 与其调用方交换的形状。目前只覆盖读取面，即只读 Web 控制台查询 review run 时收到的形状；store 的那些操作在被契约化之后也归入本族。

从这些文档开始：

- [v1/observed-run.schema.json](v1/observed-run.schema.json)：单个 observed run 的形状。
- [v1/fixtures](v1/fixtures)：可执行示例，包含本契约必须拒绝的形状。

## 边界

Control Plane 通过 `observeRun()` 产出每个 observed run。控制台不 import 这个包，因此它为同一形状保留了自己的类型；本目录中的 fixture 就是让两者保持一致的东西。

## 公开边界

消费者可以依赖：

- observed run 的字段名与必填字段；
- 两条状态轴 `execution_status` 与 `publication_status`，它们是彼此独立的值；
- `artifact_storage` 的三种变体：不存在、不可用，或可用且带有已存储的 bundle。

以下不属于本契约：

- 内部存储记录，例如经 `POST /v1/store` 交换的行形状；
- 扁平状态，它只出现在那些存储记录上；
- 控制台为展示而派生的任何内容，例如相对时间或各阶段耗时。

## 执行方式

控制台在构建期把自己的 `Run` 类型钉在本 fixture 上：如果 fixture 增加、删除或改名了某个字段，控制台会停止编译，直到它的类型跟上。该检查位于 `apps/control-plane-ui/test/observed-run-fixture-types.ts`，比较的是**键集合**而不是值，因为 TypeScript 会放宽 JSON 字符串，值层面的赋值会拒绝一个正确的 fixture。

值层面的一半由 Control Plane 在 `control-plane/test/observed-run-contract.test.ts` 中承担：它按键集合把自己的响应类型与 schema 对照，按 manifest 的声明校验每个 fixture，并校验 `observeRun()` 的真实输出。因此，schema 枚举之外的某个状态、被破坏的 pattern、或格式错误的 timestamp 都会让测试失败，而不是流到控制台。
