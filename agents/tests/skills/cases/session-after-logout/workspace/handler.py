sessions = {}


def logout(token):
    return {"delete_cookie": True}


def account(token):
    return sessions.get(token)
