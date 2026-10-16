# Key Derivation And Context Separation

- Identify the KDF, input keying material, salt, output length and context information. Do not treat a generic hash call as an interchangeable KDF without the protocol's construction and assumptions.
- For HKDF, extraction and expansion have distinct roles. Context information can bind output to a protocol, purpose, tenant or algorithm; omitting it is security relevant when distinct outputs are required but all other derivation inputs are equal.
- Prove whether two consumers actually receive the same derived bytes and whether their primitive or authorization contracts require separation. Reusing a master secret does not by itself prove derived-key reuse.
- Passwords and low-entropy user secrets require a password-oriented derivation or verifier construction; HKDF does not add password guessing cost.

Report the concrete derivation collision or missing required binding and its effect. Do not impose one universal salt, label or hierarchy on protocols that define another safe construction.
