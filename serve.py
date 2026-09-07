#!/usr/bin/env python3
"""Local test server.  Run:  python serve.py   then open http://localhost:8080

Service workers are allowed on http://localhost, so the offline behaviour can
be tested here exactly as it will behave on the phone.
"""
import http.server, socketserver, os, sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
os.chdir(os.path.dirname(os.path.abspath(__file__)))

class H(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      '.wasm': 'application/wasm',
                      '.webmanifest': 'application/manifest+json'}
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()
    def log_message(self, *a): pass

socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(('', PORT), H) as httpd:
    print(f'Serving on http://localhost:{PORT}  (Ctrl-C to stop)')
    httpd.serve_forever()
