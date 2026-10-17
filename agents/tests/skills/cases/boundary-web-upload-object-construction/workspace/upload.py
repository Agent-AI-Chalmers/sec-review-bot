import pickle


def upload(request):
    return pickle.loads(request.files["import"].read())
