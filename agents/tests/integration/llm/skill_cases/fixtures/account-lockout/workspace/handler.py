from auth import verify_password

locked = set()


def login(user, password):
    if user in locked:
        return False
    if not verify_password(user, password):
        locked.add(user)
        return False
    return True
