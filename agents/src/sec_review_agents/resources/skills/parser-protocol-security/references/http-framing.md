# HTTP/1.1 Framing

- For HTTP/1.1 framing, require a relevant multi-recipient topology and receiver behavior. Malformed `Content-Length` or `Transfer-Encoding` alone is not a confirmed request-smuggling path.
- Consistent rejection or a single authoritative parser is a counterexample.
- Establish connection reuse, forwarding transformations and how leftover bytes become another request.
- Do not apply HTTP/1.1 conclusions to HTTP/2, HTTP/3 or gRPC without their own protocol and downgrade behavior.
