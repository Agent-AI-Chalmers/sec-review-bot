# Trajectory fixtures

The `subagents.jsonl` and `summarization.jsonl` recordings are generated through the runtime with scripted models and in-memory file tools. Source files, findings, model names, and token usage are synthetic; no real repository review or paid model call is represented. Execution ancestry, middleware behavior, and serialization come from the actual framework.

- [`subagents.jsonl`](subagents.jsonl): a path-traversal review delegates source and test inspection to two parallel Subagents. Each Subagent reads one file and reports back, and the parent returns a structured verdict.
- [`summarization.jsonl`](summarization.jsonl): the reviewer reads source and tests, then Summarization middleware compacts the context before the final verdict. The original evidence, model-generated summary, and user-role context summary remain available.

Open either file in the UI trajectory viewer, or use it with the trajectory readers and Memory tools. The files contain complete event streams, including call starts, response references, and completion markers. Tool request IDs are distinct throughout each file.

Read message events in `seq` order. The parent and each Subagent start with their actual system message and user input. Agent labels distinguish the branches; `summarization` labels identify the summary instructions and model response.

The manifest also includes focused valid and invalid inputs for structural and whole-file validation.
