#!/usr/bin/env python3
"""
PopDEX Trade Replay - local dev server + API proxy.

Serves the static site AND forwards any request under /api/ to the real
https://api.popdex.xyz, server-to-server, then returns the response to the
browser as if it came from this same origin. Browsers only enforce CORS on
cross-origin requests, so once everything looks like it's coming from
http://localhost:8000, the "Could not reach PopDEX" CORS failure goes away.

Usage:
    python proxy_server.py [port]

Then open http://localhost:8000 (or whatever port you pass).
"""
import http.server
import socketserver
import urllib.request
import urllib.error
import sys
import time

UPSTREAM = "https://api.popdex.xyz"
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000


class ProxyHandler(http.server.SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"  # keep-alive, avoids a fresh TCP+TLS handshake per request

    def do_GET(self):
        if self.path.startswith("/api/"):
            self._proxy()
        else:
            super().do_GET()

    def _proxy(self):
        target_url = UPSTREAM + self.path
        req = urllib.request.Request(
            target_url,
            headers={"Accept": "application/json", "User-Agent": "popdex-trade-replay-proxy"},
        )

        attempts = 2  # one retry on transient network failures
        last_err = None
        for attempt in range(1, attempts + 1):
            try:
                with urllib.request.urlopen(req, timeout=25) as resp:
                    body = resp.read()
                    status = resp.status
                    content_type = resp.headers.get("Content-Type", "application/json")
                self.send_response(status)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(body)
                return
            except urllib.error.HTTPError as e:
                # PopDEX itself responded with an error status - forward it as-is
                # so js/api.js can parse the code/msg envelope instead of treating
                # it as a network failure.
                body = e.read()
                status = e.code
                content_type = e.headers.get("Content-Type", "application/json") if e.headers else "application/json"
                self.send_response(status)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(body)
                return
            except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
                last_err = e
                sys.stderr.write(
                    f"[PROXY ERROR] attempt {attempt}/{attempts} for {self.path} -> {type(e).__name__}: {e}\n"
                )
                if attempt < attempts:
                    time.sleep(0.5)
                    continue

        error_body = ('{"code":50015,"msg":"Proxy could not reach api.popdex.xyz after %d attempts: %s"}'
                      % (attempts, str(last_err))).encode()
        self.send_response(502)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(error_body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(error_body)

    def log_message(self, format, *args):
        # Keep default logging (helpful for seeing proxied calls) but tag proxy hits.
        if self.path.startswith("/api/"):
            sys.stderr.write("[PROXY] %s -> %s\n" % (self.path, UPSTREAM + self.path))
        super().log_message(format, *args)


if __name__ == "__main__":
    class ThreadingHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
        daemon_threads = True  # so Ctrl+C actually exits promptly

    with ThreadingHTTPServer(("", PORT), ProxyHandler) as httpd:
        print(f"Serving PopDEX Trade Replay on http://localhost:{PORT}")
        print(f"Proxying /api/* -> {UPSTREAM}")
        httpd.serve_forever()
