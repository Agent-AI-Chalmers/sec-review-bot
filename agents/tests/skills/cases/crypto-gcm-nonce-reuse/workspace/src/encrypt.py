from cryptography.hazmat.primitives.ciphers.aead import AESGCM

NONCE = bytes(12)


def encrypt_for_client(key: bytes, plaintext: bytes) -> bytes:
    return AESGCM(key).encrypt(NONCE, plaintext, None)
