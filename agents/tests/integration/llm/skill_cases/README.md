# Bundled Skill LLM Cases

Each directory under `fixtures/` is one security case. Keep the security facts and any required oracles in `case.json`; when the case needs repository evidence, put files under `workspace/` exactly as the model should see them.

## Adding a case

1. Copy an existing case directory and rename it with a lowercase kebab-case ID.
2. Make the JSON `id` match the directory name.
3. Select the bundled `skill` and one Markdown filename from that skill's `references/` directory.
4. Write the review `task` and repository/runtime `facts`. Add only the oracles the case needs: `decision` for the security conclusion, `classification` for CWE IDs, and `exact_output` for fields whose exact value matters. A discovery-only case may omit `oracles`. Under `decision`, use `explanation_requirements` for independent concepts that must all appear. For unresolved cases, use `proof_gap_requirements` for material missing facts. `explanation_pattern` remains for older fixtures but is a weak single-regex check and should not support new correctness claims.
5. Add only the modes that answer a useful question:
   - `prompted` explicitly names the skill and reference and requires successful read evidence. Use this by default.
   - `discovery` does not name a skill or reference path. The model sees the normal skill catalog and must choose and read the expected resources from the case wording. This proves selection only for that wording; it does not prove that realistic repository code will trigger the same choice.
   - `contrast` runs the same prompt with and without skills. The skills-enabled result must satisfy the oracle; the baseline is recorded but is not required to fail.

The loader rejects unknown fields, duplicate IDs, unknown skills, and unknown references. A workspace is optional for cases decided entirely from declared facts. Keep detailed security reasoning in the case facts and oracle requirements, not in the runner.

Do not add a case merely to give every reference a green marker. References and model cases have separate maintenance records; a reference does not need a matching case. Admit model cases only when their facts and oracle test a decision-changing rule. An unresolved case that merely lists every relevant fact as unavailable is not evidence of domain knowledge by itself.

## Minimal example

```json
{
  "schema_version": 1,
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
uv run pytest -q tests/skills/test_skill_case_fixtures.py
```

Run the real-model cases with an available deployment:

```bash
LLM_TEST_DEPLOYMENT=<deployment> RUN_LLM_SKILL_CASES=1 \
  uv run pytest -q -s tests/integration/llm/test_skill_cases.py
```
