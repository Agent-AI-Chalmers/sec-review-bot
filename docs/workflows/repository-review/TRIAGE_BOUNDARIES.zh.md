# Triage Boundaries

语言：[English](TRIAGE_BOUNDARIES.md) | 中文

本文是 [TRIAGE_BOUNDARIES.md](TRIAGE_BOUNDARIES.md) 的中文译文。英文版是权威版本；如果两者不一致，以英文版为准。

triage 的输入来自 discovery 阶段。discovery 负责高召回地产生安全候选信号，但 candidate 不是漏洞结论，其中会混有重复项、弱信号、前端/后端同一问题的不同视角，以及明显不值得继续分析的噪音。

triage 阶段不确认漏洞，而是把这些 candidates 整理成后续 analyzer 更容易处理的问题单元：

- 哪些 candidate 明显不值得继续分析，可以 suppress；
- 哪些 candidate 描述同一个问题，可以合并成一个 case；
- 哪些 candidate 还不能在浅层阶段否定，应该保守 keep。

下游契约仍然接收 `cases` 和 `suppressed_candidates`。agent 不直接手写这些结果；它只编辑 workbench 里的 groups，系统在 constraints 通过后从 groups 导出结果。

## Discovery 和 Triage 的边界

高召回不等于把所有“有安全味道”的内容都交给 triage。discovery 应该尽量只生产漏洞域内的候选：具体仓库代码里的 attacker-controlled input、权限边界、危险 sink、敏感数据影响或可信侧状态变更。

CI 扫描频率、security bot coverage、schema 审计字段、placeholder 文案、泛化配置硬化这类安全流程或最佳实践建议，最好在 discovery 阶段就不要产出。

但即使 discovery 已经收紧，triage 仍然需要 suppress。有些候选在单文件、局部视野里合理可疑，但放到更完整的 inventory 或代码语义里就没有独立 case 价值。例如：

- 客户端传了 `filename`、`userId`、`total`，但真正是否成漏洞取决于服务端是否重新鉴权、校验或重算。
- schema 里有弱信号，例如 `password TEXT`，但同批或全局已经有 register/login 的运行时代码证据覆盖同一个明文密码问题。
- UI 暴露了 `/admin` 链接，但真正的安全边界是 admin API 是否做 server-side role check。
- localStorage 或 React state 可以被用户改写，但可信侧服务端状态并不受它影响。

因此，`merge` 和 `suppress` 的分工不是“相关就合并，不相关才舍弃”：

- `merge`: 多个 item 共同描述同一个 root cause、sink、信任边界或修复点；合并后导出的 case 更完整、更准确。
- `suppress`: item 本身不是漏洞域问题，或只是弱旁证/重复信号，或被更强 root-cause item 覆盖后没有独立分析或修复价值。
- `keep`: item 有具体仓库落点，浅层阶段不能否定，也不能明显并入其他 keep group。

理想状态是：discovery 不大量生产非漏洞域噪音；triage 仍保留 suppress 能力，用来处理局部可疑但全局不成立、无独立价值或过度声称的候选。

## Suppress 边界

triage 是 recall-first 阶段。suppress 的门槛高，keep 的门槛低。

判断边界可以用一个问题概括：这个 item payload 是否给了 analyzer 一个具体、仓库内的落点？

如果答案是否定的，例如只是泛化地说“缺少校验”“可能信息泄露”“不够安全”，却没有任何具体文件位置、route、action、数据字段、source/sink、权限边界或 sensitive effect，那么可以 suppress。

如果答案是肯定的，即使证据很弱，也通常应保守 keep。因为这时 item 已经提供了一个 repository-specific anchor，后续 analyzer 可以围绕这个落点检查跨文件鉴权、session 行为、数据流、schema、调用方或危险 sink。

因此，triage suppress 更像“没有可分析对象的清理”，不是“漏洞不成立的最终判断”。

## Merge 边界

Merge 只在候选明显描述同一个问题时发生。好的 merge 通常具备这些特征：

- 同一个 root cause；
- 同一个危险 sink；
- 同一个信任边界；
- 同一个修复点；
- 前端/后端分别描述同一个 trust failure；
- 一个 item 明显是另一个 item 的子方面。

不要因为这些弱信号就 merge：

- 同 CWE；
- 同文件但不同操作；
- 同 endpoint family；
- 都是 `missing validation`；
- 都是 logging / hardening / policy 类泛化问题；
- 一个弱 companion 只提供上下文颜色，没有增强同一 root cause、sink 或 trust boundary。

如果 merge certainty 不高，保守拆开。

triage 的 over-merge 更容易表现成“宽泛 issue 主题”合并：例如把多个独立 endpoint 的 missing validation、多个无直接数据流关系的客户端信号、或一组同 feature 的弱安全建议合成一个大 case。
