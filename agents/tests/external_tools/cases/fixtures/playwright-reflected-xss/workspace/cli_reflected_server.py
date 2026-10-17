from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse


class Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        value = parse_qs(urlparse(self.path).query).get("q", [""])[0]
        body = (
            "<!doctype html><html><head><title>Search</title></head>"
            f"<body><main>{value}</main></body></html>"
        ).encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: object) -> None:
        return


ThreadingHTTPServer(("127.0.0.1", 8780), Handler).serve_forever()
