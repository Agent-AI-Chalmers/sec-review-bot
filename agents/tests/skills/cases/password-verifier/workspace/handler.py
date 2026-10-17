import hashlib


def password_verifier(password):
    return hashlib.sha256(password.encode()).hexdigest()
