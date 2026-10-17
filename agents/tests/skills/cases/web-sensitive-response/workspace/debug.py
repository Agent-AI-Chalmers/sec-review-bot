import os


def diagnostics(request):
    return {"database": os.environ["DATABASE_URL"]}
