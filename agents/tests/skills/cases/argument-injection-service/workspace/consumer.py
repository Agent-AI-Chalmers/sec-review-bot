from renderer import render


def post_report(request):
    return render(request.json["name"])
