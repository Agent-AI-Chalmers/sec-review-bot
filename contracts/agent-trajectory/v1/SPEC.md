# Agent Trajectory v1

Language: English | [中文](SPEC.zh.md)

A trajectory records an agent execution for inspection, Memory extraction, and usage accounting. It preserves messages, their sources, and execution relationships independently of any particular agent framework or observability service.

The [record schema](schemas/record.schema.json) defines structural requirements. The [corpus manifest](corpus/manifest.json) defines shared acceptance cases.

## File and Record Format

A trajectory uses UTF-8 JSONL: one JSON object per line. Newlines inside message content are escaped within that object. Each record has a positive integer `seq` and an `event` name. Sequence numbers increase within one file and need not be contiguous.

Records are separated by LF (`U+000A`); CRLF is also accepted. Unicode separators such as `U+0085`, `U+2028`, and `U+2029` inside JSON strings are content, not record boundaries.

Messages use `event: "message"`. Their envelope carries provenance and execution relationships; `message` carries the message itself. Producers write one canonical representation. Readers validate this format before using the records.

## Messages and Sources

| Field                  | Meaning                                                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `message.id`           | Message identity, unique within the trajectory; repeated observations of the same message retain this identity and are recorded once |
| `message.role`         | `system`, `user`, `assistant`, or `tool`                                                                                             |
| `message.content`      | Original text or structured content blocks; a block's `type` describes its content kind, not the message role                        |
| `agent`                | Agent responsible for the message's conversation or execution branch, when known                                                     |
| `source`               | Message origin or purpose, when known; `summarization` identifies summary-related material                                           |
| `call_id`              | Model invocation that generated this response, when applicable                                                                       |
| `run_id`, `parent_ids` | Execution identity and ordered ancestry from root to immediate parent, when available                                                |

`agent` and `source` have the same meaning across producers. Framework-specific metadata may be retained as additional evidence, but readers do not need it to interpret these fields. Missing labels mean unknown provenance, not an implicit root agent.

Preserve tool status, structured results, reasoning, and other available message data without replacing the original content with a display-oriented rendering. Preview formatting does not change stored content or the original text offered for copying.

## Sequence and Conversation Context

`seq` describes the flat reading order. When the initial system instruction is available, place it before that agent's user input, followed by responses and tool interactions. A changed system instruction appears before the invocation that uses it. Concurrent Subagents may interleave; provenance and ancestry distinguish their branches.

A trajectory is an execution history, not a complete request snapshot for every model invocation. A message stored once may be used in multiple requests. Sequence numbers alone do not establish which messages were included in a particular request or imply a shared context across agents.

Retain observed history even when it is later removed from the active conversation or replaced by a summary. Do not fabricate a system instruction when execution stops before it becomes available.

- **Subagent**: Retain its available instructions, input, responses, and tool interactions with its own provenance and execution ancestry.
- **Summarization middleware**: Retain the summary request and model response, including available usage. Also retain the summary inserted into the continuing conversation; this is a distinct message with a different purpose.
- **Summary interpretation**: A summary is a fallible navigation aid, not independent evidence or a new user instruction. Original evidence remains available for checking it.

## Model Calls and Tool Interactions

| Event               | Meaning                                                                              |
| ------------------- | ------------------------------------------------------------------------------------ |
| `model_calls_start` | Start of model-call recording for the execution                                      |
| `model_call_start`  | Start of a model invocation, identified by `call_id`                                 |
| `model_call_end`    | Successful return from that invocation; `message_id` references its response message |
| `model_calls_end`   | End of recording, with execution status `completed`, `failed`, or `interrupted`      |

A response is stored once as a message. Its call-end record references it rather than duplicating the response or its usage. A call that fails or is interrupted may have a start without an end; do not manufacture a successful response for it.

Model call IDs identify invocations within the trajectory. Tool requests use `message.tool_calls[].id`; tool results use `message.tool_call_id`. These tool IDs associate requests and results within an execution branch. They do not replace model call IDs or execution ancestry. If the available relationships are ambiguous, leave the association unresolved rather than selecting an arbitrary result.

The following abbreviated example shows a completed invocation:

```jsonl
{"seq":1,"event":"model_calls_start"}
{"seq":2,"event":"message","agent":"reviewer","message":{"id":"s1","role":"system","content":"Review the change."}}
{"seq":3,"event":"message","agent":"reviewer","message":{"id":"u1","role":"user","content":"Inspect the patch."}}
{"seq":4,"event":"model_call_start","call_id":"c1","agent":"reviewer"}
{"seq":5,"event":"message","call_id":"c1","agent":"reviewer","message":{"id":"a1","role":"assistant","content":"A check is needed.","usage_metadata":{"input_tokens":10,"output_tokens":2,"total_tokens":12,"cache_read_input_tokens":null,"cache_creation_input_tokens":null,"reasoning_tokens":null}}}
{"seq":6,"event":"model_call_end","call_id":"c1","message_id":"a1"}
{"seq":7,"event":"model_calls_end","status":"completed"}
```

## Usage and Completeness

Message `usage_metadata` describes the model invocation that generated that response. Count each observed invocation at most once, using the response referenced by its call-end record when available. Without a call end, an unambiguous recorded response may contribute known usage without establishing successful completion. Historical messages supplied as context are not new invocations. Re-reading their content is already included in the new invocation's reported input usage.

`message.usage_metadata` is the canonical per-call token record, distinct from envelope `metadata`. It is optional or `null` when unavailable. A non-null object contains exactly the following fields; each value is a nonnegative safe integer or `null`. A missing measurement is `null`, not zero. Explicitly reported zero stays `0`.

This contract follows OpenTelemetry GenAI token-accounting semantics: inclusive input/output totals with cache and reasoning represented as subsets. Its JSON field names and record structure are project-owned, not a copy of OpenTelemetry attribute or metric names. OpenTelemetry GenAI conventions evolve independently; an upstream naming change does not change this contract. Producers map their source vocabulary to the fields defined below.

| Field                         | Meaning                                                              |
| ----------------------------- | -------------------------------------------------------------------- |
| `input_tokens`                | Inclusive input, including cache reads and cache creation            |
| `output_tokens`               | Inclusive output, including reasoning                                |
| `total_tokens`                | `input_tokens + output_tokens` when both are known; otherwise `null` |
| `cache_read_input_tokens`     | Cache-read subset of input                                           |
| `cache_creation_input_tokens` | Cache-creation subset of input, disjoint from cache reads            |
| `reasoning_tokens`            | Reasoning subset of output                                           |

Known cache subsets cannot sum to more than known input; known reasoning cannot exceed known output. Consumers reject impossible subsets, inconsistent totals, missing fields in a non-null usage object, and framework-specific detail keys inside canonical usage. Counts are bounded by `9007199254740991` for Python/JavaScript interoperability. Cache and reasoning counts are subsets and must not be added to inclusive totals.

Producers normalize at their adapter boundary. LangChain totals and OpenAI prompt/completion totals are already inclusive. Anthropic ordinary input excludes its separately reported cache buckets; add those buckets once. Langfuse ordinary input/output buckets exclude cache/reasoning buckets; add those once. Absent optional buckets contribute nothing to this adapter-specific sum but do not establish reported subset values. An absent ordinary bucket leaves its inclusive total unknown. Derive `total_tokens` from normalized components; warn on a conflicting source total and retain original provider observations outside canonical usage. A source total alone cannot establish input/output or a canonical total.

Consumers read canonical usage without interpreting provider metadata or LangChain detail maps. Aggregate each field only when every covered call has a known value for that field; otherwise that field's aggregate is unknown. No observed calls means unknown totals. A lower-bound partial sum may be exposed separately with an explicit label, never as the complete total. Derived uncached input and ratios remain unknown if any required operand is unknown. Complete usage accounting requires finished call recording and all six fields known for every covered invocation; known input/output totals alone do not establish cache or reasoning coverage.

The agents runtime owns framework/provider conversion and trajectory usage validation. Repository scripts own run discovery, workflow-specific effective-patch selection, and report rendering. Langfuse query code owns its external-source conversion; its normalized field meanings match this contract and the Review Runs token totals.

Run-level aggregate usage belongs in a separate metrics artifact or an explicitly distinguished aggregate record. Do not attach it to an individual response. Where only aggregate usage is available, preserve it without inventing per-call allocation.

When assessing completeness, distinguish these conclusions within the stated observation scope:

- **Execution completed**: The agent execution reached its normal end.
- **Call recording complete**: All model invocations in the stated execution scope were captured, including Subagent and summarization invocations.
- **Usage complete**: Call recording is complete and every invocation has the required reported usage.

A completion marker alone does not prove call or usage completeness. Accounting reports identify known coverage limits, such as missing usage, unfinished calls, or a missing terminal marker. They may report available totals without claiming complete usage; consumers are not expected to discover invocations outside their observation scope.

## Partial and External Trajectories

External producers may lack system instructions, call boundaries, ancestry, or per-call usage. Preserve what they actually provide and treat unavailable information as unknown; readable messages remain useful without establishing complete accounting.

Readers reject malformed JSONL and records that violate this format. An interrupted trajectory containing valid records remains readable. Accounting reports distinguish known usage from a claim of complete accounting. Inconsistent references must not be treated as complete accounting. No consumer should infer successful tool execution from a request without its result.

## Whole-File Rules

The input is UTF-8 JSONL. Each nonblank line is one record. Sequence numbers are positive safe integers and strictly increase. Message IDs are unique within a file. Optional additional data is retained without changing the meaning of defined fields.

When call lifecycle events are supplied, recording begins with `model_calls_start`. Each model call start has a distinct `call_id`. A call end follows its start and references an already recorded response with the same `call_id`. An execution recording end follows its recording start, and no records follow it. An unfinished recording is valid input with incomplete execution coverage.

Message-only trajectories are valid but cannot establish complete model-call coverage. Records must not be repaired or inferred to make an invalid file valid.

`metadata` is an optional JSON object containing supplementary observations. It does not define message identity, role, provenance, call relationships, or usage. Defined top-level fields and `message` fields remain authoritative; consumers must not fill them from metadata. Producers may preserve original observations unchanged; metadata keys are not part of the contract.

## Producer and Consumer Obligations

Producers write the canonical message roles and source fields, retain original content, and record each message once. Per-call usage belongs to the response that incurred it. Run aggregates are separate from response usage.

Consumers validate the supplied file before using it. Invalid input produces an explicit error; missing optional information does not by itself invalidate a trajectory.

Consumer obligations follow their purpose. Display consumers may project messages and recorded usage without assessing execution or accounting completeness. Accounting consumers retain the execution records needed for their calculations and state known coverage limits. Neither kind of consumer may infer missing facts or claim completeness beyond the available evidence.
