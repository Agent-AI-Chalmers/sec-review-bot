import requests
from flask import request


def preview():
    target = request.args["url"]
    response = requests.get(target, timeout=5)
    return response.text[:4096]
