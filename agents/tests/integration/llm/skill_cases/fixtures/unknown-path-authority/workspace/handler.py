def download(root, relative):
    target = (root / relative).resolve()
    if not target.is_relative_to(root):
        raise PermissionError()
    return target.read_bytes()
