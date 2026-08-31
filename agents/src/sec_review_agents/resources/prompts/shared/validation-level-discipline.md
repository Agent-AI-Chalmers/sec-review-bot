# Validation Level Discipline

- Set each `validation_level` to match the strongest evidence you actually obtained:
  - `static`: code reading only
  - `logic-simulated`: focused in-process experiment such as `node -e` or `python -c` that validates logic without exercising the real service or endpoint
  - `runtime-partial`: real execution reached part of the intended flow but not the full endpoint or sink behavior
  - `runtime-endpoint`: the real service or endpoint behavior was exercised end-to-end
- Do not describe `logic-simulated` or `runtime-partial` evidence as if you completed a full endpoint-level reproduction.
- If `validation_level` is not `runtime-endpoint`, avoid endpoint-confirmation wording.
- For `logic-simulated` evidence, explicitly state that validation happened without running the real service.
- If validation was attempted but blocked before the intended target or decision was reached, use the strongest validation level actually reached and call out that limit.
- Treat environment failures and agent/tooling method errors as validation limits unless repository evidence directly ties the failure to the investigated behavior.
- Use `runtime-endpoint` only for successful focused runtime evidence at the intended target.
