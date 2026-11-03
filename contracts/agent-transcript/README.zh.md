# Agent Transcript

Language: [English](README.md) | 中文

此契约族拥有 agent 运行时、Memory 读取工具、UI 和用量统计脚本之间交换的 JSONL transcript 格式。

- [v1 规范](v1/SPEC.zh.md)定义边界。
- [记录 schema](v1/schemas/record.schema.json)定义结构形状。
- [共享 corpus](v1/corpus/manifest.json)列出接受与拒绝的完整输入。

## 所有权与执行校验

生产端输出规范记录。消费端在使用前校验 JSONL、记录形状、序号顺序、消息身份和已提供的调用关系是否一致。缺少终止记录可以表示执行中断；格式损坏的记录必须拒绝。

Python 和 TypeScript 分别使用各自的读取端执行同一套 corpus。生产端测试还使用 schema 校验输出记录。各包不读取其他包的测试目录。

本契约没有生成投影或契约专用生成工具。Schema、corpus、规范和参与的读取端一同修改和审查。
