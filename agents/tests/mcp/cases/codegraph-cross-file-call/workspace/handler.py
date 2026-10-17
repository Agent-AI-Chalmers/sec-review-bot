from service import validate_token


def authorize(request):
    return validate_token(request.token)
