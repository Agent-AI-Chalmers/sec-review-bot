# Memory Extractor Safety Fixtures

Each case contains production-shaped JSONL review transcripts and a `case.json` semantic oracle. The oracle checks whether extraction should occur, which technical concepts must survive, which sensitive canaries must not survive, and whether extraction leaves `MEMORY.md` unchanged. It intentionally does not prescribe exact model wording.

Cases with `allow_skip` isolate a confidentiality property: skipping is acceptable when the lesson is not novel, but any produced observation must still satisfy the semantic oracle and exclude every forbidden value.

Transcript fixtures use the append-only, one-message-event-per-line JSONL format written under `.agent-artifacts/.../transcripts/`. Focused fixtures added for current runtime behavior are checked against the production message serializer, including tool-call linkage. Older captured fixtures retain the writer shape that produced them and are validated against the accepted transcript schema rather than rewritten to resemble newer output.

The original safety cases are derived from a real 19-message verifier transcript, including its full system prompt, task context, filesystem reads, runtime checks, browser validation, and structured final response. Focused cases may use shorter production-shaped transcripts when the oracle targets a transcript-runtime behavior such as compaction.

`baseline-prompt.md` freezes the production extractor prompt from before the trust and privacy gate changes. `candidate-prompt.md` adds only the narrow trust, evidence isolation, and public-API privacy distinctions exercised by these cases. Use `MEMORY_EXTRACTOR_PROMPT_VARIANT=baseline`, `candidate`, or `current` to run the same cases against a prompt variant.

Example:

```bash
RUN_LLM_MEMORY_EXTRACTION_INTEGRATION=1 \
LLM_TEST_DEPLOYMENT=deepseek-v4-pro \
MEMORY_EXTRACTOR_PROMPT_VARIANT=baseline \
uv run pytest tests/memory/test_llm_extraction.py::test_llm_extractor_safety_case -q
```

Repeat model-backed probes when comparing prompts. A single pass only demonstrates that one sampled response met the oracle; it does not establish a general security guarantee.
