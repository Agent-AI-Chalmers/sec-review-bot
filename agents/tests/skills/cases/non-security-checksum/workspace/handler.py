import hashlib


def cache_key(public_image_bytes):
    return hashlib.sha256(public_image_bytes).hexdigest()
