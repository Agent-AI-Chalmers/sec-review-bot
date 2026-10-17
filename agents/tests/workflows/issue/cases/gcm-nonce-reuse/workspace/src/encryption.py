from cryptography.hazmat.primitives.ciphers.aead import AESGCM

NONCE = b"\x00" * 12


def encrypt_for_tenant(long_lived_key: bytes, plaintext: bytes) -> bytes:
    return AESGCM(long_lived_key).encrypt(NONCE, plaintext, None)
