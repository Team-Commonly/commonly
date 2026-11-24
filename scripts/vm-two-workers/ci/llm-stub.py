"""A stand-in for LiteLLM in the two-worker proof: every chat completion
answers after STUB_DELAY_MS (default 3000) +-30%, every GET answers 200 (the
healthcheck reads /health/readiness). Standard library only."""
import json
import os
import random
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DELAY = int(os.environ.get('STUB_DELAY_MS', '3000')) / 1000


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *args):
        pass

    def send(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self.send(200, {'data': [{'id': 'stub', 'object': 'model'}]})

    def do_POST(self):
        length = int(self.headers.get('Content-Length') or 0)
        try:
            body = json.loads(self.rfile.read(length) or b'{}')
        except ValueError:
            body = {}
        time.sleep(DELAY * random.uniform(0.7, 1.3))
        self.send(200, {
            'id': f'stub-{random.randrange(1 << 30)}',
            'object': 'chat.completion',
            'created': int(time.time()),
            'model': body.get('model', 'stub'),
            'choices': [{'index': 0, 'finish_reason': 'stop',
                         'message': {'role': 'assistant', 'content': f'Noted ({random.randrange(1 << 20)}).'}}],
            'usage': {'prompt_tokens': 1200, 'completion_tokens': 12, 'total_tokens': 1212},
        })


ThreadingHTTPServer.daemon_threads = True
ThreadingHTTPServer(('0.0.0.0', 4000), Handler).serve_forever()
