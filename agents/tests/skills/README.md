# Skill Tests

This directory owns deterministic skill preparation, selection, materialization, oracle, and LLM behavior tests. Each security scenario under `cases/<case-id>/` has a `case.json`; when a case needs repository evidence, its files live under `workspace/` exactly as the model should see them.

The LLM case modes are `prompted`, `discovery`, and `compare`. Skills do not have a synthetic capability mode: their deterministic capability is already covered by preparation, materialization, backend exposure, and read-evidence tests.

## Adding a case

1. Copy an existing case directory and rename it with a lowercase kebab-case ID.
2. Make the JSON `id` match the directory name.
3. Select the bundled `skill` and one Markdown filename from that skill's `references/` directory.
4. Write the review `task` and repository/runtime `facts`. Add only the oracles the case needs: `decision` for the security conclusion, `classification` for CWE IDs, and `command_argument` for the exact child-parser argument boundary. The runner selects the matching specialized output model; do not add case-specific fields to the common read output. A discovery-only case may omit `oracles`. A `decision` requires at least two independent `explanation_requirements`, all of which must appear. Use `confirmed` when the security failure and impact are established, `rejected` when known facts break the claimed security relation, and `unresolved` when material facts are unavailable. An `unresolved` decision requires at least two `proof_gap_requirements`; the other verdicts must not define them.
5. Add only the modes that answer a useful question:
   - `prompted` explicitly names the skill and reference and requires successful read evidence. Use this by default.
   - `discovery` does not name a skill or reference path. The model sees the normal skill catalog and must choose and read the expected resources from the case wording. This proves selection only for that wording; it does not prove that realistic repository code will trigger the same choice.
   - `compare` runs the same prompt with and without skills. The skills-enabled run must read the expected skill and reference and satisfy the oracle; the baseline is recorded but is not required to fail. This mode produces a comparable output pair. It does not automatically decide that the skills-enabled result is better; that judgment belongs to a human review or a separately defined blinded judge.

The loader rejects unknown fields, duplicate IDs, unknown skills, and unknown references. A workspace is optional for cases decided entirely from declared facts. Keep detailed security reasoning in the case facts and oracle requirements, not in the runner.

Do not add a case merely to give every reference a green marker. References and model cases have separate maintenance records; a reference does not need a matching case. Admit model cases only when their facts and oracle test a decision-changing rule. An unresolved case that merely lists every relevant fact as unavailable is not evidence of domain knowledge by itself.

## Minimal example

```json
{
  "id": "example-case",
  "skill": "os-boundary-security",
  "reference": "filesystem-path-policy.md",
  "modes": ["prompted"],
  "task": "Assess whether the requested file can escape the export root.",
  "facts": [
    "The request controls the relative path.",
    "The service reads the resolved file with service-account permissions."
  ],
  "oracles": {
    "decision": {
      "verdict": "confirmed",
      "explanation_requirements": [
        "attacker-controlled path",
        "outside the export root"
      ]
    }
  }
}
```

Run deterministic validation with:

```bash
uv run python -m pytest -q tests/skills/test_case_fixtures.py
```

Run the real-model cases with an available deployment:

```bash
LLM_TEST_DEPLOYMENT=<deployment> RUN_LLM_SKILL_CASES=1 \
  uv run python -m pytest -q -s tests/skills/test_llm.py
```
