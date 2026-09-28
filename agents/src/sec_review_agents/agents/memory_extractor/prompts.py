from sec_review_agents.agents.memory_extractor.model import StagedTranscripts
from sec_review_agents.resources.loader import load_prompt_resource

MEMORY_EXTRACTOR_SYSTEM_PROMPT = load_prompt_resource("memory/extract-system.md")


def build_extractor_prompt(staged_transcripts: StagedTranscripts) -> str:
    transcript_lines = [
        f"- {label}: `{mounted}`" for label, mounted in staged_transcripts.entries
    ]
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
