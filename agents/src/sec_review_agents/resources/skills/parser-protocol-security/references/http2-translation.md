# HTTP/2 Validation And Translation

- HTTP/2 framing removes HTTP/1.1 line framing but does not remove interpretation risk at intermediaries. Inspect every protocol translation and the message the next hop actually receives.
- Treat mismatched `content-length` and DATA length, prohibited connection-specific fields, invalid pseudo-headers, and invalid field names or values as malformed according to the protocol. A processing intermediary must not forward a malformed message.
- Before translating to HTTP/1.1, reject field values that can introduce HTTP/1 delimiters or otherwise produce a different downstream message. Normalizing and forwarding an invalid message can create request smuggling.
- Consistent rejection, end-to-end HTTP/2 without a disagreeing consumer, or a translator that constructs one validated HTTP/1.1 message is a counterexample.

Report only when attacker-controlled HTTP/2 input reaches a disagreeing or unsafe downstream interpretation with a concrete cross-request or authorization effect.
