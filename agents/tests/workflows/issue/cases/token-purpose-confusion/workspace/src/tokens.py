def verify_session(token, signing_key):
    claims = verify_signature(  # noqa: F821 - external repository helper
        token, signing_key
    )
    if claims["issuer"] != "accounts":
        raise ValueError("bad issuer")
    return claims["subject"]
