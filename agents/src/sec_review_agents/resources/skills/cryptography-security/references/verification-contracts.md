# Verification And Authenticated Results

- Bind verification to allowed algorithms, the intended key, and every required cryptographic operation. Reject failures before acting on authenticated claims or data.
- Limited parsing needed to locate verification inputs is distinct from authorizing or executing unverified content.
- Signature validity does not establish issuer, audience, token type, session meaning or application authorization; inspect the consumer's policy.
Do not turn missing rotation, PKI operations or a preferred algorithm list into findings without a sourced repository-specific contract and exploit path.

## Secret-Dependent Observations

- For secret keys, MACs or authentication tokens, trace whether secret-dependent branches, memory addresses or operand-dependent operations expose information through an attacker-observable timing or cache channel. Public-input variability alone is not secret leakage; establish the secret, observation capability and feasible queries before reporting.
- A constant-time comparison protects only that operation. Inspect length handling, decoding, error paths and surrounding work; a safe comparison does not make the caller constant-time. Tie native-code conclusions to the deployed compiler, optimization and processor, and account for runtime/JIT transformations where applicable.
- An instruction scan cannot establish secret dependence or rule out cache leakage. A clean statistical timing test does not prove absence of leaks; retain the tested inputs, build and environment and state untested limits. Timing differences alone do not establish secret recovery or its impact.
- For attacker-supplied CBC ciphertext, distinguish observable padding validity from authentication failure, including timing when error messages match. In an encrypt-then-MAC construction, verify the ciphertext's MAC before decrypting or processing padding. Separately check that unauthenticated plaintext is not consumed; uniform errors alone prove neither property. Follow the actual protocol's construction rather than declaring every CBC use vulnerable.
