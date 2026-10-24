"""Local test server that disables browser caching, so a reload always runs the current files: python3 tools/serve.py [port]"""
import http.server, sys

class NoCache(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

http.server.ThreadingHTTPServer(('', int(sys.argv[1]) if len(sys.argv) > 1 else 8741), NoCache).serve_forever()
