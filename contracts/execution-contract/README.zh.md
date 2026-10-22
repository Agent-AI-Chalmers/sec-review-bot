# Execution Runtime Contract

语言：[English](README.md) | 中文

本文是 [README.md](README.md) 的中文译文。英文版是权威版本；如果两者不一致，以英文版为准。

该契约是 Execution Gateway 与 Execution Worker 之间私有的跨进程边界，定义稳定的 Temporal workflow type，以及提交给该 workflow 的 JSON payload。

它不定义 HTTP API，也不定义 review input/result 形状；这些内容仍属于 [integration-contract](../integration-contract/README.zh.md)。
