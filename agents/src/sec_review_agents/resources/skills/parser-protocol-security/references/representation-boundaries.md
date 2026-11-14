# Representation Boundaries

- Trace the same bytes or logical value through decoding, normalization, validation, storage and final consumption.
- Identify which representation each guard sees and which representation the sink interprets. A guard on one spelling does not constrain a later decoded or normalized spelling unless equivalence is established.
- Normalize once at an owned boundary when the protocol and policy require it, then validate the representation actually consumed. Repeated canonicalization is not a universal repair.
- Include duplicate keys, case folding, Unicode, separators and numeric forms only when the actual parser or protocol gives them different meanings.
- For Go `encoding/json` v1 struct decoding, field names can match case-insensitively and later duplicate keys can replace or merge earlier values. `DisallowUnknownFields` does not reject these recognized aliases or duplicates. Compare the value inspected by any upstream guard with the final decoded field; custom unmarshaling and other JSON implementations require their own semantics.
- A message valid in one protocol context can be substituted into another. Check that the consumer binds it to its intended context (audience, token type, purpose); for signed tokens, also read `/skills/cryptography-security/references/verification-contracts.md`.

Report both interpretations and the security decision they separate. Preserve uncertainty when downstream parsing, transformation order or platform semantics are unknown.
