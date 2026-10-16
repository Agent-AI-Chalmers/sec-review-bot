# Password Verifiers

- First establish that the value protects user passwords and may be exposed to offline guessing. Do not apply password-storage rules to public-data checksums, cache keys or integrity tags.
- Store salted password verifiers using a password hashing scheme with a configurable cost. Verify the actual library mode, parameters and per-password salt handling from repository dependencies.
- A separate server-held secret can add defense in depth, but its absence alone is not a vulnerability when the stored verifier otherwise meets the product's security requirements.
- Authentication rate limiting does not replace offline verifier protection after database disclosure.

Report the deployed verifier construction and offline threat. Avoid fixed universal work factors or algorithm-deprecation tables that can age independently of the source standard and repository version.
