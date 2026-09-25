#!/usr/bin/env python3
"""Serves tests/site on 127.0.0.1:8765 for the self-test. Nothing else, and nothing outside this machine."""
import http.server
import os

os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), "site"))
http.server.ThreadingHTTPServer(("127.0.0.1", 8765), http.server.SimpleHTTPRequestHandler).serve_forever()
