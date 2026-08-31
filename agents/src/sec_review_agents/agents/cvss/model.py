from typing import Literal

from pydantic import BaseModel, Field, model_validator

CVSS_VECTOR_ORDER = (
    "AV",
    "AC",
    "AT",
    "PR",
    "UI",
    "VC",
    "VI",
    "VA",
    "SC",
    "SI",
    "SA",
)


# Agent structured output


class CvssMetricRationale(BaseModel):
    """
    Explain one chosen CVSS base metric value with brief evidence-grounded reasoning.
    Keep the rationale specific to the selected metric rather than summarizing the whole case.
    """

    metric: Literal["AV", "AC", "AT", "PR", "UI", "VC", "VI", "VA", "SC", "SI", "SA"]
    rationale: str = Field(
        description="Brief evidence-grounded reason for the chosen metric value."
    )


class CvssV4ScoringOutput(BaseModel):
    """
    Keep `overview`, all metric values, and `metric_rationales` mutually consistent.
    Provide exactly one rationale for each base metric in the CVSS vector, with no duplicates or omissions.
    Express scoring uncertainty through conservative metric choices, metric rationales, or `not-scored`;
    do not add a separate confidence label.
    Use `scoring_status=not-scored` when the current case is not an independently scoreable vulnerability.
    """

    scoring_status: Literal["scored", "not-scored"] = Field(
        default="scored",
        description=(
            "`scored` when the current case itself has a CVSS-scoreable exploit path and impact; "
            "`not-scored` when the case is hardening, defense-in-depth, an impact amplifier, or otherwise "
            "not independently scoreable."
        ),
    )
    overview: str = Field()
    not_scored_reason: str | None = Field(
        default=None,
        description=(
            "Required when scoring_status is `not-scored`; explain why the current case is not an "
            "independently CVSS-scoreable vulnerability."
        ),
    )
    av: Literal["N", "A", "L", "P"] | None = Field(alias="AV", default=None)
    ac: Literal["L", "H"] | None = Field(alias="AC", default=None)
    at: Literal["N", "P"] | None = Field(alias="AT", default=None)
    pr: Literal["N", "L", "H"] | None = Field(alias="PR", default=None)
    ui: Literal["N", "P", "A"] | None = Field(alias="UI", default=None)
    vc: Literal["H", "L", "N"] | None = Field(alias="VC", default=None)
    vi: Literal["H", "L", "N"] | None = Field(alias="VI", default=None)
    va: Literal["H", "L", "N"] | None = Field(alias="VA", default=None)
    sc: Literal["H", "L", "N"] | None = Field(alias="SC", default=None)
    si: Literal["H", "L", "N"] | None = Field(alias="SI", default=None)
    sa: Literal["H", "L", "N"] | None = Field(alias="SA", default=None)
    metric_rationales: list[CvssMetricRationale] = Field(
        default_factory=list,
        max_length=11,
    )

    @model_validator(mode="after")
    def validate_metric_rationales(self) -> CvssV4ScoringOutput:
        if self.scoring_status == "not-scored":
            if not str(self.not_scored_reason or "").strip():
                raise ValueError(
                    "not_scored_reason is required when scoring_status=not-scored."
                )
            metric_values = {
                "AV": self.av,
                "AC": self.ac,
                "AT": self.at,
                "PR": self.pr,
                "UI": self.ui,
                "VC": self.vc,
                "VI": self.vi,
                "VA": self.va,
                "SC": self.sc,
                "SI": self.si,
                "SA": self.sa,
            }
            present_values = [
                metric for metric, value in metric_values.items() if value is not None
            ]
            if present_values:
                raise ValueError(
                    f"metric values must be empty when scoring_status=not-scored; present={present_values}"
                )
            if self.metric_rationales:
                raise ValueError(
                    "metric_rationales must be empty when scoring_status=not-scored."
                )
            return self

        metric_values = {
            "AV": self.av,
            "AC": self.ac,
            "AT": self.at,
            "PR": self.pr,
            "UI": self.ui,
            "VC": self.vc,
            "VI": self.vi,
            "VA": self.va,
            "SC": self.sc,
            "SI": self.si,
            "SA": self.sa,
        }
        missing_values = [
            metric for metric, value in metric_values.items() if value is None
        ]
        if missing_values:
            raise ValueError(
                f"scored CVSS outputs must include every base metric; missing={missing_values}"
            )
        if len(self.metric_rationales) != len(CVSS_VECTOR_ORDER):
            raise ValueError(
                "scored CVSS outputs must include exactly one rationale for each base metric."
            )

        seen = {item.metric for item in self.metric_rationales}
        missing = [metric for metric in CVSS_VECTOR_ORDER if metric not in seen]
        if missing:
            raise ValueError(
                f"metric_rationales must include every base metric exactly once; missing={missing}"
            )

        if len(seen) != len(self.metric_rationales):
            raise ValueError(
                "metric_rationales must not contain duplicate metric entries."
            )

        return self


# Public exports

__all__ = [
    "CVSS_VECTOR_ORDER",
    "CvssV4ScoringOutput",
]
