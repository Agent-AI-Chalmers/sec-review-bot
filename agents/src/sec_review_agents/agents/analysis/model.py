from typing import Literal

from pydantic import BaseModel, Field, model_validator

from sec_review_agents.review_stages.types import ValidationLevel, Verdict
from sec_review_agents.utils.pydantic_types import NonEmptyText

VULNERABILITY_TYPE_PLACEHOLDERS = {"unspecified", "none", "unknown", "n/a", ""}


# Domain types

ScopeShape = Literal["local-defect", "shared-enforcement-point", "unresolved"]
RelatedPathRelationship = Literal["same-semantics", "different-semantics", "unresolved"]


# Agent structured output


class Location(BaseModel):
    """
    Use repository-relative paths only.
    Add `line` when a precise anchor is available; omit it when only file-level anchoring is justified.
    Keep `label` short and role-oriented so nearby fields can explain the deeper significance.
    """

    file: NonEmptyText = Field(
        description="Repository-relative file path for a code location relevant to the analysis."
    )
    line: int | None = Field(
        default=None,
        gt=0,
        description="1-based line number for the location when a precise anchor is available.",
    )
    label: str | None = Field(
        default=None,
        description="Optional short label describing why this location matters, such as entry point or sink.",
    )


class RelatedPath(BaseModel):
    """
    One other code site checked against this narrative's mechanism.
    """

    label: NonEmptyText = Field(
        description="Short identifier for the code site: a path, helper, stage, fallback, or entry point."
    )
    relationship: RelatedPathRelationship = Field(
        description=(
            "How this code site relates to the narrative's mechanism. Judge by failure class and boundary, not by "
            "code resemblance: `same-semantics` when it reaches the same failure class through the same classifier, "
            "dispatcher, guard, validator, or shared helper the narrative depends on, and `different-semantics` "
            "when it reaches a different failure class or a different boundary. Code that merely resembles the "
            "cited code, or that reaches the same boundary with a different outcome, is not `same-semantics`."
        )
    )
    note: str | None = Field(
        default=None,
        description="Brief explanation of why this site is same, different, or unresolved.",
    )

    model_config = {
        "extra": "forbid",
    }


class ControlReview(BaseModel):
    """
    Capture the control-coverage reasoning for this narrative.
    Use this when a guard, sanitizer, validator, allowlist, deny rule, policy, permission check,
    parser rule, crypto check, or other security control materially affects the verdict.
    """

    reachable_assets: list[str] = Field(
        default_factory=list,
        max_length=5,
        description=(
            "Assets, capabilities, paths, identities, state, or operations this narrative shows can be reached, "
            "protected, exposed, modified, or influenced."
        ),
    )
    security_controls: list[str] = Field(
        default_factory=list,
        max_length=5,
        description=(
            "Repository-verified controls relevant to this narrative, such as guards, sanitizers, validators, "
            "allowlists, deny rules, policy rules, permission checks, parser rules, or crypto checks."
        ),
    )
    control_limits: list[str] = Field(
        default_factory=list,
        max_length=5,
        description=(
            "Concrete limits of those controls: what asset, operation, path shape, caller class, state, ordering, "
            "or semantic case they do not cover or do not prove."
        ),
    )

    model_config = {
        "extra": "forbid",
    }


class FlowReview(BaseModel):
    """
    Capture source/sink-style flow facts when they materially explain this narrative.
    Use this as one review lens, not as the required shape for every security-relevant behavior.
    """

    source_facts: list[str] = Field(
        default_factory=list,
        max_length=5,
        description="Concrete facts about attacker influence, input origin, reachability, or required preconditions.",
    )
    sink_facts: list[str] = Field(
        default_factory=list,
        max_length=5,
        description="Concrete facts about the decisive operation, dangerous effect, or security-relevant endpoint.",
    )

    model_config = {
        "extra": "forbid",
    }


class SupportReview(BaseModel):
    """
    Capture what supports this narrative and what evidence is still missing.
    Keep this neutral: it is not a source/sink flow container.
    """

    supported_inferences: list[str] = Field(
        default_factory=list,
        max_length=5,
        description=(
            "Evidence-backed reasoning steps that connect concrete repository facts to the narrative verdict. "
            "Use this for conditional, semantic, or cross-file conclusions that are supported by checked facts "
            "but are not direct repository facts or standalone findings."
        ),
    )
    proof_gaps: list[str] = Field(
        default_factory=list,
        max_length=5,
        description="Specific unresolved gaps that materially limit this narrative or its scope.",
    )

    model_config = {
        "extra": "forbid",
    }


# Verdicts that assert something to repair, so the narrative owes the control point whose
# behavior decides its outcome. `plausible-risk` counts: the concern is unconfirmed, but the
# control point that would decide it is already identifiable, and the field description says
# so. `no-actionable-finding` and `inconclusive` assert no such outcome, so they owe only the
# scope analysis.
FINDING_VERDICTS = frozenset(
    {"plausible-risk", "confirmed-defect", "confirmed-vulnerability"}
)


# ScopeReview asks whether the issue is a local defect or lies in a shared
# control point used by multiple execution paths.
class ScopeReview(BaseModel):
    """
    Capture repair-relevant scope and the control point that decides the outcome.
    """

    scope_shape: ScopeShape = Field(
        default="unresolved",
        description=(
            "Whether the repair-relevant scope is best understood as a single local defect, "
            "a shared enforcement point affecting multiple reachable paths, or still unresolved. "
            "Choose `shared-enforcement-point` when the narrative's mechanism is implemented by a boundary that "
            "other reachable entries also depend on, even when only one entry is reported or only one entry is wrong."
        ),
    )
    outcome_deciding_control_point: str | None = Field(
        default=None,
        description=(
            "Short identifier of the single control point whose behavior decides this narrative's outcome, for "
            "example `checkAccess`. Name the symbol that decides the outcome, not where the error "
            "is raised and not which callers are affected; describe what that outcome is and how it is decided in "
            "`scope_analysis`. Required for `plausible-risk`, `confirmed-defect`, and `confirmed-vulnerability`: a "
            "`plausible-risk` names the control point that would decide the outcome if the concern is real. "
            "`no-actionable-finding` and `inconclusive` record what they examined in `scope_analysis` instead."
        ),
    )
    scope_analysis: NonEmptyText = Field(
        description=(
            "Explain, in this order: how the control point decides the outcome, why the repair-relevant scope "
            "is local or shared, and, when the scope is still unresolved, what evidence would settle it. List the "
            "entries that reach the control point in `related_paths` rather than repeating them here."
        ),
    )
    # Whether a control point must be named is validated on Narrative: it depends on
    # the narrative verdict, which this nested model cannot see.
    model_config = {
        "extra": "forbid",
    }


class CweMapping(BaseModel):
    """
    Capture optional CWE mapping only when this narrative cleanly maps to a CWE entry.
    """

    cwe_id: str | None = Field(
        default=None,
        pattern=r"^CWE-\d+$",
        description="Optional CWE identifier when the narrative maps cleanly to a CWE entry.",
    )
    cwe_name: str | None = Field(
        default=None,
        description="Human-readable CWE name corresponding to `cwe_id` when one is supplied.",
    )
    cwe_rationale: str | None = Field(
        default=None,
        description="Brief explanation of why the selected CWE maps to this narrative.",
    )

    model_config = {
        "extra": "forbid",
    }

    @model_validator(mode="after")
    def validate_cwe_mapping(self) -> CweMapping:
        if self.cwe_id and not self.cwe_name:
            raise ValueError("cwe_name is required when cwe_id is present.")

        if self.cwe_id and not self.cwe_rationale:
            raise ValueError("cwe_rationale is required when cwe_id is present.")

        return self


class Narrative(BaseModel):
    """
    Keep all fields aligned to one repository-grounded analysis narrative at the stated `priority`.
    A narrative is a review direction with its own evidence and verdict; it may conclude no actionable finding.
    When `verdict=confirmed-vulnerability`, use a concrete `vulnerability_type` and include at least one
    `location`, `flow_review.source_facts`, and `flow_review.sink_facts`.
    A `confirmed-defect` includes at least one `location`; source and sink facts stay optional because no
    attacker-influenced flow has to exist for a defect to be confirmed.
    Keep `description`, `support_review`, and overall wording consistent with `validation_level`; do not write
    as though end-to-end behavior was exercised when validation stayed static or partial.
    Use `flow_review` for source/sink-style facts when attacker influence, preconditions, dangerous operations,
    or security-relevant effects materially explain the narrative.
    Use `support_review` for evidence-backed reasoning and concrete missing evidence; do not use it as a substitute
    for direct flow or control facts.
    Use `control_review` when a guard, sanitizer, validation, deny rule, allowlist, policy, authorization check,
    parser rule, crypto check, or boundary materially affects the verdict; state reachable assets, verified
    controls, and concrete control limits separately.
    Use `scope_review` to record whether repair-relevant scope is local, shared, or unresolved and which control
    point decides the outcome; list the related code sites that informed that judgment in `related_paths`.
    Use `cwe_mapping` only when a CWE mapping is justified; if `cwe_mapping.cwe_id` is present, also provide the
    matching `cwe_mapping.cwe_name` and a brief `cwe_mapping.cwe_rationale`.
    """

    priority: int = Field(
        ge=1,
        description="Priority rank for this narrative where smaller numbers indicate higher priority (`1` is highest).",
    )
    verdict: Verdict = Field(
        description="Evidence-grounded outcome for this narrative.",
    )
    title: NonEmptyText = Field(
        description="Short title naming the review direction or confirmed defect being described."
    )
    description: NonEmptyText = Field(
        description="Concise evidence-based explanation of the narrative, scoped to the current repository and trigger."
    )
    vulnerability_type: str = Field(
        default="Unspecified",
        description=(
            "Normalized vulnerability or defect category for this narrative. "
            "Use a concrete vulnerability class when one is confirmed."
        ),
    )
    validation_level: ValidationLevel = Field(
        default="static",
        description=(
            "How directly this narrative was validated beyond repository reading. "
            "Use `static` for code-only analysis, `logic-simulated` for focused in-process experiments such as "
            "a small `node -e` or `python -c` reproduction that does not exercise the real endpoint, "
            "`runtime-partial` for real execution that reaches only part of the intended flow, and "
            "`runtime-endpoint` only when the actual service or endpoint behavior was exercised end-to-end."
        ),
    )
    locations: list[Location] = Field(
        default_factory=list,
        max_length=3,
        description="Up to three code locations that best anchor this narrative in the repository.",
    )
    flow_review: FlowReview = Field(
        default_factory=FlowReview,
        description=(
            "Source/sink-style flow review for this narrative. Keep empty when the narrative is better explained "
            "by controls, scope, parser behavior, state, policy, or invariant behavior."
        ),
    )
    support_review: SupportReview = Field(
        default_factory=SupportReview,
        description="Supported reasoning and proof gaps for this narrative.",
    )
    control_review: ControlReview = Field(
        default_factory=ControlReview,
        description=(
            "Control-coverage review for this narrative. Use when verified controls or claimed boundaries "
            "materially affect the verdict; keep empty when no repository control is relevant."
        ),
    )
    scope_review: ScopeReview = Field(
        description="Repair-relevant scope review for this narrative.",
    )
    related_paths: list[RelatedPath] = Field(
        default_factory=list,
        max_length=5,
        description=(
            "Small checked set of code sites that materially informed the scope judgment; use it only for the "
            "entries that changed, constrained, or clarified that judgment, not as a catch-all list of every "
            "related vector. When the narrative names a mechanism rather than a cited location, check the boundary "
            "that implements the mechanism before concluding `local-defect`."
        ),
    )
    cwe_mapping: CweMapping = Field(
        default_factory=CweMapping,
        description="Optional CWE mapping for this narrative.",
    )

    model_config = {
        "extra": "forbid",
    }

    @model_validator(mode="after")
    def validate_narrative(self) -> Narrative:
        if self.verdict == "confirmed-vulnerability":
            if not self.flow_review.source_facts:
                raise ValueError(
                    "narratives with verdict=confirmed-vulnerability must include at least one source fact."
                )

            if not self.flow_review.sink_facts:
                raise ValueError(
                    "narratives with verdict=confirmed-vulnerability must include at least one sink fact."
                )

            if not self.locations:
                raise ValueError(
                    "narratives with verdict=confirmed-vulnerability must include at least one location."
                )

            if (
                self.vulnerability_type.strip().lower()
                in VULNERABILITY_TYPE_PLACEHOLDERS
            ):
                raise ValueError(
                    "narratives with verdict=confirmed-vulnerability require a concrete vulnerability_type."
                )

        # A confirmed defect must point somewhere. Source and sink facts belong to
        # attacker-influenced flows, but "this code is wrong" without a location leaves the
        # reader an unlocatable claim. `plausible-risk` stays exempt because incomplete
        # evidence is what that verdict states.
        if self.verdict == "confirmed-defect" and not self.locations:
            raise ValueError(
                "narratives with verdict=confirmed-defect must include at least one location."
            )

        if (
            self.verdict in FINDING_VERDICTS
            and not (self.scope_review.outcome_deciding_control_point or "").strip()
        ):
            raise ValueError(
                f"narratives with verdict={self.verdict} require "
                "scope_review.outcome_deciding_control_point: name the control point whose behavior decides "
                "the outcome."
            )

        # A `same-semantics` path says another entry reaches the same failure class through
        # the same boundary, which is what a shared scope means. Claiming a local defect
        # while listing one contradicts the label the mitigator reads.
        # The reverse is deliberately not enforced: a shared boundary can be argued from
        # sibling throws in the same file without listing a same-semantics path.
        if self.scope_review.scope_shape == "local-defect" and any(
            path.relationship == "same-semantics" for path in self.related_paths
        ):
            raise ValueError(
                "scope_review.scope_shape=local-defect contradicts a same-semantics related path: another entry "
                "reaches the same failure class through the same boundary, so claim shared-enforcement-point or "
                "drop the entry."
            )

        return self


class AnalysisOutput(BaseModel):
    """
    Keep `overview`, `overall_verdict`, and the narrative list mutually consistent.
    Treat `overview` as orientation, not as a compressed replacement for the full narrative set.
    Keep it narrower than the full narrative set: prefer one top-line repository-grounded assessment over an
    enumerated list of bypass classes, sibling surfaces, exploit variants, or downstream validation detail.
    Only include fine-grained sub-claims in `overview` when they are already directly established in analyzer
    evidence and are necessary to state the main conclusion.
    Use `no-actionable-finding` only when no confirmed narrative remains; no-actionable narratives may be included when
    they materially support the top-level conclusion. Any confirmed vulnerability should drive
    `overall_verdict=confirmed-vulnerability`, and any confirmed repository defect without a confirmed vulnerability should drive
    `overall_verdict=confirmed-defect`.
    Non-empty actionable verdicts should be backed by at least one narrative, ordered by unique `priority` values.
    """

    overview: NonEmptyText = Field(
        description=(
            "Compact top-line summary of the analyzer's current repository-grounded assessment. "
            "Use it as brief orientation for downstream stages rather than as a compressed full narrative set. "
            "Prefer a narrow issue-facing statement over enumerating bypass classes, sibling-path claims, exploit variants, "
            "or later-stage validation detail. Include such sub-claims only when they were directly established in analyzer "
            "evidence and are necessary to state the main conclusion."
        ),
    )
    overall_verdict: Verdict = Field(
        description=(
            "Top-level outcome for the analysis, chosen from the supported verdict set. "
            "Use `confirmed-vulnerability` when repository evidence confirms concrete attacker influence and dangerous effect; "
            "`confirmed-defect` when repository evidence confirms a concrete repository defect but attacker-relevant impact remains unresolved; "
            "`plausible-risk` when evidence is incomplete but still concerning; "
            "`inconclusive` when evidence is insufficient for a reliable outcome; "
            "and `no-actionable-finding` when the investigated claim does not map to an actionable concern in current code."
        ),
    )
    narratives: list[Narrative] = Field(
        default_factory=list,
        max_length=5,
        description="Evidence-grounded narratives considered by the analyzer, ordered by `priority` where `1` is highest, with at most five total narratives.",
    )

    @model_validator(mode="after")
    def validate_result(self) -> AnalysisOutput:
        has_confirmed_vulnerability = any(
            narrative.verdict == "confirmed-vulnerability"
            for narrative in self.narratives
        )
        has_confirmed_defect = any(
            narrative.verdict == "confirmed-defect" for narrative in self.narratives
        )
        priorities = [narrative.priority for narrative in self.narratives]

        if len(priorities) != len(set(priorities)):
            raise ValueError(
                "narrative priorities must be unique within one analysis result."
            )

        if self.overall_verdict == "no-actionable-finding" and (
            has_confirmed_vulnerability or has_confirmed_defect
        ):
            raise ValueError(
                "no-actionable-finding verdict cannot include confirmed narratives."
            )

        if self.overall_verdict != "no-actionable-finding" and not self.narratives:
            raise ValueError("non-empty verdicts require at least one narrative.")

        if (
            has_confirmed_vulnerability
            and self.overall_verdict != "confirmed-vulnerability"
        ):
            raise ValueError(
                "narratives with verdict=confirmed-vulnerability require overall_verdict=confirmed-vulnerability."
            )

        if (
            not has_confirmed_vulnerability
            and has_confirmed_defect
            and self.overall_verdict != "confirmed-defect"
        ):
            raise ValueError(
                "narratives with verdict=confirmed-defect require overall_verdict=confirmed-defect unless a narrative with verdict=confirmed-vulnerability is also present."
            )

        self.narratives = sorted(self.narratives, key=lambda item: item.priority)
        return self
