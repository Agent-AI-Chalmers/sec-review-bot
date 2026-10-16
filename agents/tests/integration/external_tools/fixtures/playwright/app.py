from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse


def render_page(request_path: str) -> str:
    query = parse_qs(urlparse(request_path).query)
    reflected_value = query.get("q", [""])[0]
    return f"""<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Playwright CLI case</title></head>
  <body><p id="result">{reflected_value}</p></body>
</html>
"""


class PageHandler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        body = render_page(self.path).encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: object) -> None:
        return


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", 8770), PageHandler).serve_forever()
