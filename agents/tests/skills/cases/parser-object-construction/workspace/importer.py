import pickle


def import_job(request):
    return pickle.loads(request.body)
