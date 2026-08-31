# Input Location Hints Rule

- Inputs may name files, functions, line ranges, changed hunks, stack frames, alert locations, vulnerable locations, or other code anchors.
- Treat input-provided locations as entry points, not as proof of the claim and not as complete scope boundaries.
- A named location may be the true repair point, or it may be only one manifestation of a caller, callee, shared helper, generated representation, canonicalization step, default, fallback, data structure, or API compatibility contract.
- Prefer compatibility-preserving interpretations when repository evidence shows callers expect an operation to continue working safely.
