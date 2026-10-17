from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PAGE = b"""<!doctype html>
<html><head><title>Fragment preview</title></head>
<body><main id="preview"></main>
<script>document.querySelector('#preview').innerHTML = decodeURIComponent(location.hash.slice(1));</script>
</body></html>
"""


class Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(PAGE)))
        self.end_headers()
        self.wfile.write(PAGE)

    def log_message(self, format: str, *args: object) -> None:
        return


ThreadingHTTPServer(("127.0.0.1", 8781), Handler).serve_forever()
