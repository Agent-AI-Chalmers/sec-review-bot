# Agent Framework Selection

语言：[English](FRAMEWORK_SELECTION.md) | 中文

本文是 [FRAMEWORK_SELECTION.md](FRAMEWORK_SELECTION.md) 的中文译文。英文版是权威版本；如果两者不一致，以英文版为准。

本文记录 runner 为什么现在使用 LangChain `create_agent` 加项目自己的 middleware 来构造各阶段 agent，而不是直接使用高层的 `deepagents.create_deep_agent`，也不是直接下沉到原始 LangGraph。

## 当前定位

本项目把 `deepagents` 当作工具箱使用，而不是当作顶层应用框架使用。

项目复用了它比较有用的底层部分：

- filesystem middleware 和 backend protocol 形状
- sandbox protocol 思路
- skills middleware 以及 `<source>/<skill>/SKILL.md` 的发现约定
- 文件读取、搜索、编辑、上传和执行操作的结果类型

但安全审查 workflow 的运行方式，仍然由本项目自己负责。

## 为什么不直接用 `create_deep_agent`

早期搓 demo 时考虑过直接使用 `deepagents.create_deep_agent`。它的价值很直接：能很快给出一个完整的 coding-agent 形态。但项目继续往安全审查系统推进后，关键问题就不只是“agent 能不能读文件、调工具”，而是“哪个阶段承担什么职责、拿到什么上下文、暴露哪些工具、最后产出什么结构化结果”。

从这个角度看，`create_deep_agent` 是一个带有有用默认选项的高层 harness。它在底层 agent loop 之上组装了一组 middleware 和运行时约定。本项目需要的是把这些部件按阶段重新组合，而不是直接接受一个通用 agent 形状。

所以当前设计复用了 `deepagents` 里有用的 middleware 和 backend protocol，同时用 LangChain `create_agent` 显式构造每个 stage agent。这个选择不是否定 `deepagents`，而是避免让一个通用 harness 替安全审查 workflow 决定阶段职责。

事后来看，这个选择是对的。memory 机制就是一个例子：它不是直接用默认 memory middleware 那么简单，而是包括运行后产出经验、离线整理经验碎片，以及更接近 Claude Code memory 的渐进式披露组织方式，让 agent 先看到有界的启动索引，再按需读取相关 topic。

## 为什么不直接用原始 LangGraph

LangGraph 是这一类 agent 系统下面更底层的图运行时。如果 workflow 形状已经非常稳定，项目想完全自己控制每个 node、edge、retry、state field 和 reducer，那么下沉到 LangGraph 是合理的。

但对现在这个项目来说还偏早。当前主要工程问题仍然在每个阶段的安全审查语义和运行时边界上。LangChain `create_agent` 能让 agent loop 和 middleware 集成保持紧凑，同时把真正需要定制的地方留给项目自己控制。

## 为什么 workflow 执行使用 Temporal

执行系统使用 Temporal。

![滑动窗口的 repository case workflow timeline](../../assets/screenshots/repository-case-sliding-window-timeline.png)

> *Timeline 截图仅用于说明调度形态；图中的 workflow / activity 名称可能来自旧运行或早期命名，不代表当前 API 名称。*

这张 timeline 展示了一次 repository review 中，runner workflow 如何准备多个 repository case workflow，以及 Temporal 如何跟踪滑动窗口下 workflow / activity 随时间推进的过程。

选择 Temporal 的原因：

- runner run 是长流程，排队、运行中、完成和失败状态应该由执行系统持有。
- Temporal task queue 是 runner 执行的唯一队列。
- Temporal workflow history 是后续拆分持久化步骤的事实来源，不再需要手写 checkpoint 文件。
- 内部 workflow / activity 编排需要跨 prepare / analysis / mitigation / verification / delivery 阶段的持久化调度、重试、超时和失败传播。

从 [Temporal 官网](https://temporal.io/) 可以看到另一种合理的 Temporal + agent 设计：把 agent loop 放进 workflow definition，由 workflow 持久化 message history，再通过 activity 调用 LLM 和工具。这样做能让 agent loop 本身也具备 durable execution。

但本项目没有选择这条路。Temporal 是 durable workflow orchestration，不是 agent reasoning layer。本项目用 Temporal 负责阶段、activity、重试、产物和失败传播，而不是把一个自由循环的 agent 直接塞进 workflow definition。系统的核心单元是有明确阶段、输入契约和结构化输出的安全审查 workflow；Temporal 管可靠性和调度，agent 管判断和生成。

## 后续方向

如果某个 stage 稳定到 agent loop 基本固定，后面可以继续下沉到原始 LangGraph。那会更适合主要问题已经变成精确 graph state、retry 和 node ownership 的代码。

但这不是当前瓶颈。类似的项目边界仍然放在自己的 runtime 里更容易演进，而不是藏进更大的 harness。
