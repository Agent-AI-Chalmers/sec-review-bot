from pathlib import Path


def json_safe(value):
    if value is None or isinstance(value, (str, int, float, bool)):
        return value

    if isinstance(value, Path):
        return str(value)

    if isinstance(value, dict):
        return {str(key): json_safe(inner_value) for key, inner_value in value.items()}

    if isinstance(value, (list, tuple, set)):
        return [json_safe(item) for item in value]

    if hasattr(value, "model_dump"):
        try:
            return json_safe(value.model_dump(by_alias=True))
        except TypeError:
            return json_safe(value.model_dump())

    if hasattr(value, "dict"):
        try:
            return json_safe(value.dict())
        except Exception:
            pass

    return str(value)
