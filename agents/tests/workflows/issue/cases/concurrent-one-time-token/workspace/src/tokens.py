def consume_token(db, token_id, perform_privileged_action):
    with db.transaction() as tx:
        token = tx.query_one("SELECT used FROM one_time_tokens WHERE id = ?", token_id)
        if token.used:
            return False
        perform_privileged_action()
        tx.execute("UPDATE one_time_tokens SET used = true WHERE id = ?", token_id)
        return True
