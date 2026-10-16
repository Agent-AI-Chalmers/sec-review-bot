# Template And Expression Interpreters

- Distinguish data interpolation from compiling attacker input as template, expression, query, policy or code structure.
- Identify the interpreter grammar, available names/functions/objects, sandbox and final authority. Escaping for output encoding does not neutralize an expression language.
- An allowlisted fixed expression with attacker values passed as data is a counterexample. “Safe” literal evaluators can still have resource limits even when they cannot invoke code.
- Framework names and delimiters are leads; verify the actual engine and mode from repository dependencies.

Report only when attacker input controls executable interpreter structure or an enabled capability with a concrete read, write, code-execution, authorization or resource effect.
