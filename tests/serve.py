#!/usr/bin/env python3
"""Serves tests/site on 127.0.0.1:8765 for the self-test. Nothing else, and nothing outside this machine.

/echo-cookie answers with the Cookie header the browser sent, so a test can see which cookies reached a site.
"""
import html
import http.server
import os
import threading

os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), "site"))


class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path.split("?")[0] == "/echo-cookie":
            body = (
                "<!doctype html><title>echo-cookie</title><body><pre id=c>"
                + html.escape(self.headers.get("Cookie", ""))
                + "</pre></body>"
            ).encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path.split("?")[0] == "/secret.html" and self.headers.get("Authorization") != "Basic dXNlcjpwYXNz":
            body = b"login needed"
            self.send_response(401)
            self.send_header("WWW-Authenticate", 'Basic realm="fixture"')
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()


class ProxyHandler(http.server.BaseHTTPRequestHandler):
    """A stand-in for a proxy server (port 8798): answers every request with a page that says so."""

    def do_GET(self):
        body = ("<!doctype html><title>via proxy</title><body>" + html.escape(self.path)).encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


threading.Thread(target=http.server.ThreadingHTTPServer(("127.0.0.1", 8798), ProxyHandler).serve_forever, daemon=True).start()
http.server.ThreadingHTTPServer(("127.0.0.1", 8765), Handler).serve_forever()
