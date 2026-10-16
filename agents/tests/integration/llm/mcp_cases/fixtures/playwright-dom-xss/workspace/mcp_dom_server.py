from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PAGE = """<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>DOM XSS case</title></head>
  <body>
    <h1>Fragment preview</h1>
    <div id="result"></div>
    <script>
      const value = decodeURIComponent(window.location.hash.slice(1));
      document.getElementById("result").innerHTML = value;
    </script>
  </body>
</html>
"""


class PageHandler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        body = PAGE.encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: object) -> None:
        return


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", 8766), PageHandler).serve_forever()
