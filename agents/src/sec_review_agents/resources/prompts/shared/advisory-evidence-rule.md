# Advisory Evidence Rule

- Treat external advisories as external facts: aliases, affected versions, fixed versions or refs, references, and public vulnerability descriptions.
- Do not treat advisory facts as proof that the prepared workspace is affected, fixed, or equivalent to the advisory fix.
- External advisory commit refs are orientation data, not automatically local workspace evidence.
- Use advisory fixed refs only to guide focused version, ref, or code checks. Do not chase advisory refs through git history unless the task explicitly asks for history analysis and the object is locally available.
- If current code appears to contain a similar guard, deny rule, sanitizer, or check, do not call it equivalent to the advisory fix unless repository evidence proves the same affected object set and boundary.
- If the exact fix diff, ref, object, or package version cannot be verified from available workspace evidence, record that proof gap instead of broad history exploration.
