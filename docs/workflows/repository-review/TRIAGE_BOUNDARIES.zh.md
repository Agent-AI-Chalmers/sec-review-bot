# Triage 职责

语言：[English](TRIAGE_BOUNDARIES.md) | 中文

本文为 [TRIAGE_BOUNDARIES.md](TRIAGE_BOUNDARIES.md) 的中文译文；如有差异，以英文版为准。

初筛阶段 Discovery 尽量多地找出安全线索，再交给 Triage 整理。candidate 并不等于漏洞：其中可能包含重复报告、证据较弱的推测、同一问题的前后端视角，以及明显不值得继续分析的噪音。

Triage 阶段不确认漏洞，而是把这些 candidate 整理成后续 Analyzer 更容易处理的 case：

- 哪些 candidate 不值得继续分析，可以 suppress；
- 哪些 candidate 描述同一个问题，可以 merge 为一个 case；
- 哪些 candidate 暂时无法 suppress，应保守 keep，交给 Analyzer 调查。

下游仍接收 `cases` 和 `suppressed_candidates`。Agent 通过工具编辑工作台分组，不直接编写这些结果；程序在约束检查通过后，从分组状态导出结果。Triage 只根据输入中的 candidate 内容判断，不自行读取仓库文件。

## Discovery 和 Triage 的边界

追求召回率不意味着把所有与安全沾边的内容都保留下来。Discovery 应关注具体代码中的攻击者可控输入、权限边界、危险操作、敏感数据影响，或可信侧的状态变更。

仅建议提高 CI 扫描频率、扩大安全扫描覆盖范围、增加 schema 审计字段或加固配置，却没有指出具体的攻击路径、敏感操作或信任边界问题时，不应作为漏洞 candidate 输出。

即使初筛已限制范围，Triage 仍需要 suppress candidate。某个线索在单文件内看似可疑，但结合输入中其他 candidate 的证据后，可能没有独立调查价值。例如：

- 客户端提交 `filename`、`userId` 或 `total`，但是否存在漏洞取决于服务端是否重新鉴权、校验或计算。
- schema 中出现 `password TEXT`，但注册、登录的运行代码已经提供同一明文密码问题的更直接证据。
- UI 显示 `/admin` 链接，但真正决定访问权限的是管理 API 的服务端角色检查。
- 用户可以修改 localStorage 或 React 状态，但可信服务端的状态并不受其影响。

`merge` 和 `suppress` 分别解决不同问题：

- `merge`：多个 item 描述同一根因、危险操作、信任边界或修复点，merge 后能更完整地说明问题。
- `suppress`：item 不属于漏洞问题，或只是弱旁证、重复线索，被更直接的证据覆盖后没有独立分析或修复价值。
- `keep`：item 指向具体仓库代码，初步判断不足以 suppress，也无法明确并入其他保留组。

Discovery 尽量减少与漏洞无关的 candidate；Triage 再根据全部输入，suppress 不成立、没有独立价值或夸大问题的线索。

## 何时 suppress candidate

Triage 优先避免漏掉值得调查的问题，因此 suppress 需要较充分的理由，有具体线索时则倾向保留，避免过早 suppress。

判断边界可以用一个问题概括：这个 item payload 是否给了 Analyzer 一个具体、仓库内的落点？

如果答案是否定的，例如只是泛化地说“缺少校验”“可能信息泄露”“不够安全”，却没有任何具体文件位置、route、action、数据字段、source/sink、权限边界或 sensitive effect，那么可以 suppress。

如果答案是肯定的，即使证据很弱，也通常应保守 keep。因为这时 item 已经提供了一个 repository-specific anchor，后续 Analyzer 可以围绕这个落点检查跨文件鉴权、session 行为、数据流、schema、调用方或危险 sink。

因此，suppress candidate 主要是清理没有可分析对象或没有独立价值的线索，不是代替 Analyzer 最终判定漏洞是否成立。

## 何时 merge candidate

只有明显描述同一问题的 candidate 才应 merge。常见依据包括：

- 同一根因；
- 同一危险操作；
- 同一信任边界；
- 同一修复点；
- 前后端分别描述同一次信任校验失效；
- 一个 item 明显是另一个 item 的组成部分。

不要仅凭以下弱信号就 merge：

- CWE 相同；
- 文件相同，但操作不同；
- 接口属于同一类；
- 都被描述为 `missing validation`；
- 都涉及日志、加固或策略建议；
- 某个弱线索只补充背景，没有为同一根因、危险操作或信任边界增加证据。

无法确定时，优先分开。尤其不要仅按宽泛主题，把多个独立接口的校验问题、没有直接数据流关系的客户端线索，或同一功能中的一般安全建议合成一个大 case。
