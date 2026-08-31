from sec_review_agents.agents.memory_extractor.model import StagedTranscripts
from sec_review_agents.resources.loader import load_prompt_resource

MEMORY_EXTRACTOR_SYSTEM_PROMPT = load_prompt_resource(
    "memory/extract-system.md"
).strip()


def build_extractor_prompt(staged_transcripts: StagedTranscripts) -> str:
    transcript_lines: list[str] = []
    current_thread: str | None = None
    for thread, label, mounted in staged_transcripts.entries:
        if thread != current_thread:
            current_thread = thread
            transcript_lines.append(f"- Thread `{thread}`")
        transcript_lines.append(f"  - {label}: `{mounted}`")
    return "\n".join(
        [
            "### Transcript Inputs",
            "",
            "The staged review transcripts are mounted at `/transcripts`.",
            "",
            "Read these transcript files in order:",
            "",
            chr(10).join(transcript_lines),
            "",
            "### Task",
            "",
            (
                "Inspect the listed transcripts. If they contain durable reusable "
                "security-review experience, return one short Markdown observation."
            ),
            "",
            "If there is no durable observation, return no observation.",
        ]
    )
