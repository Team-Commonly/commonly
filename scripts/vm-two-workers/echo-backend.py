"""A stand-in backend for lb-smoke.sh: answers with its name and the headers
that reached it. MODE=503 answers 503 to everything except /count (a backend
draining). /count reports how many POSTs reached it. Standard library only."""
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

NAME = os.environ['NAME']
MODE = os.environ.get('MODE', 'ok')
POSTS = {'n': 0}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def answer(self, method):
        if self.path == '/count':
            return self.reply(200, {'posts': POSTS['n']})
        if method == 'POST':
            POSTS['n'] += 1
            self.rfile.read(int(self.headers.get('Content-Length') or 0))
        if MODE == '503':
            return self.reply(503, {'error': 'draining'})
        return self.reply(200, {
            'backend': NAME,
            'method': method,
            'cf_connecting_ip': self.headers.get('CF-Connecting-IP'),
            'x_forwarded_for': self.headers.get('X-Forwarded-For'),
            'x_forwarded_proto': self.headers.get('X-Forwarded-Proto'),
        })

    def do_GET(self):
        self.answer('GET')

    def do_POST(self):
        self.answer('POST')


ThreadingHTTPServer(('0.0.0.0', 5000), Handler).serve_forever()
