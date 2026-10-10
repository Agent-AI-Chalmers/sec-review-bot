# Control Plane API

语言：[English](README.md) | 中文

本文是 [README.md](README.md) 的中文译文。英文版是权威版本；如果两者不一致，以英文版为准。

本族收录 Control Plane 与其调用方交换的形状。它覆盖两个凭据不同的面：控制台消费的读取面，以及 GitHub 集成调用的 store 操作。

从这些文档开始：

- [v1/observed-run.schema.json](v1/observed-run.schema.json)：读取响应返回的、已脱敏的形状。
- [v1/review-run-record.schema.json](v1/review-run-record.schema.json)：经 `POST /v1/store` 交换的协调记录。
- [v1/fixtures](v1/fixtures)：可执行示例，包含本契约必须拒绝的形状。

## 边界

Control Plane 通过 `observeRun()` 产出每个 observed run，通过 `rowToRecord()` 产出每条记录。两侧调用方都不 import 这个包，因此各自为所读的形状保留了自己的类型；这些 schema 就是让三份描述保持一致的东西。

记录携带 `failure_message`，而脱敏后的读取形状刻意丢弃了它，因此它只跨越 service token 那条边界。

## 公开边界

消费者可以依赖：

- observed run 的字段名与必填字段；
- 两条状态轴 `execution_status` 与 `publication_status`，它们是彼此独立的值；
- `artifact_storage` 的三种变体：不存在、不可用，或可用且带有已存储的 bundle。

以下不属于本契约：

- 内部存储记录，例如经 `POST /v1/store` 交换的行形状；
- 扁平状态，它只出现在那些存储记录上；
- 控制台为展示而派生的任何内容，例如相对时间或各阶段耗时。

## 没有 schema 的部分

有三个载荷没有 schema：admission 信封、publication claim 结果、以及 publication step 记录。它们改由 `apps/github-integration/test/control-plane/client-mirrored-types.ts` 在编译期与 Control Plane 自己的类型绑定。

为它们写 schema，只会得到第二份**运行时没人校验**的描述：集成侧解析响应后直接做类型断言，所以 schema 要先在那个调用点接上校验器才谈得上执行。在接上校验器之前，编译期的绑定就是它们的执行方式；只补 schema 文件不接校验，等于什么都没变。

## 执行方式

控制台在构建期把自己的 `Run` 类型钉在本 fixture 上：如果 fixture 增加、删除或改名了某个字段，控制台会停止编译，直到它的类型跟上。该检查位于 `apps/control-plane-ui/test/observed-run-fixture-types.ts`，比较的是**键集合**而不是值，因为 TypeScript 会放宽 JSON 字符串，值层面的赋值会拒绝一个正确的 fixture。

值层面的一半由 Control Plane 在 `control-plane/test/observed-run-contract.test.ts` 中承担：它按键集合把自己的响应类型与 schema 对照，按 manifest 的声明校验每个 fixture，并校验 `observeRun()` 的真实输出。因此，schema 枚举之外的某个状态、被破坏的 pattern、或格式错误的 timestamp 都会让测试失败，而不是流到控制台。
