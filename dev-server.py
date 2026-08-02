#!/usr/bin/env python3
"""Static file server for local development.

Identical to `python3 -m http.server` except that it tells the browser never to
cache. Without this, ES modules get served from the HTTP cache after an edit and
you debug code that is no longer on disk.
"""

import os
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()

    def log_message(self, fmt, *args):
        if not args or not str(args[0]).startswith("GET"):
            super().log_message(fmt, *args)


def main():
    port = int(os.environ.get("PORT") or (sys.argv[1] if len(sys.argv) > 1 else 3000))
    root = os.path.join(os.path.dirname(os.path.abspath(__file__)), "app")
    handler = partial(NoCacheHandler, directory=root)
    with ThreadingHTTPServer(("127.0.0.1", port), handler) as httpd:
        print(f"serving {root} on http://localhost:{port}")
        httpd.serve_forever()


if __name__ == "__main__":
    main()
