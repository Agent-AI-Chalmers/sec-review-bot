# Bundled Skill LLM Cases

Each directory under `fixtures/` is one security case. Keep the security facts and expected result in `case.json`; when the case needs repository evidence, put files under `workspace/` exactly as the model should see them.

## Adding a case

1. Copy an existing case directory and rename it with a lowercase kebab-case ID.
2. Make the JSON `id` match the directory name.
3. Select the bundled `skill` and one Markdown filename from that skill's `references/` directory. CWE classification uses the same format and can set `cwe_id` and `parent_category_id` in `expected`.
4. Write the review `task`, the repository/runtime `facts`, and the narrow expected result. Use `explanation_pattern` only when the case must mention a specific mechanism, source, sink, or guard.
5. Add only the modes that answer a useful question:
   - `prompted` explicitly names the skill and reference and requires successful read evidence. Use this by default.
   - `natural` exposes skills normally without naming one. It requires successful reads of the case's skill and reference, then checks the case result.
   - `contrast` runs the same prompt with and without skills. The skills-enabled result must satisfy the oracle; the baseline is recorded but is not required to fail.

The loader rejects unknown fields, duplicate IDs, unknown skills, and unknown references. A workspace is optional for cases decided entirely from declared facts. Keep detailed security reasoning in the case facts and expected fields, not in the runner.

Deterministic coverage also requires every bundled domain reference to have at least one JSON behavior case. `scanner-finding-triage` is exempt because its cases run through the separate triage workflow. One case per reference is only a maintenance floor; important rule groups should still use positive, counterexample, unresolved-boundary, and natural-discovery cases where they answer distinct questions.

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
  "expected": {
    "verdict": "confirmed"
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
