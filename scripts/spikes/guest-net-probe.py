# Runs INSIDE a microsandbox guest. For each HOST:PORT argument it reports
# whether a TCP connection opens, and reads a short banner if one is sent.
# With "--proxy HOST:PORT TOKEN" it also sends one Anthropic Messages request
# through Commonly's provider proxy and prints the stub model's key echo, so the
# run shows whether the proxy redacted the upstream key.
# Spike only: every key involved is fake.
import json
import socket
import sys
import urllib.error
import urllib.request

args = sys.argv[1:]
proxy = None
http = []
while args and args[0] == '--http':
    http.append(args[1])
    args = args[2:]
if args and args[0] == '--proxy':
    proxy = (args[1], args[2])
    args = args[3:]

for target in args:
    host, port = target.rsplit(':', 1)
    try:
        addr = socket.getaddrinfo(host, int(port), proto=socket.IPPROTO_TCP)[0][4][0]
    except Exception as e:  # noqa: BLE001
        print(f'{target}: dns-fail ({type(e).__name__})')
        continue
    s = socket.socket(socket.AF_INET6 if ':' in addr else socket.AF_INET)
    s.settimeout(4)
    try:
        s.connect((addr, int(port)))
        s.settimeout(1.5)
        try:
            banner = s.recv(64).decode(errors='replace').strip()
        except Exception:  # noqa: BLE001
            banner = ''
        print(f'{target} [{addr}]: OPEN{" banner=" + banner if banner else ""}')
    except Exception as e:  # noqa: BLE001
        print(f'{target} [{addr}]: refused ({type(e).__name__}: {e})')
    finally:
        s.close()

# HTTP-level reachability: status and size only, never the body. No metadata
# header is sent, so a cloud metadata service answers 400 without instance data,
# and a status code at all proves the request got through the fence.
for url in http:
    try:
        r = urllib.request.urlopen(url, timeout=6)
        print(f'GET {url}: status {r.status}, {len(r.read())} bytes, server={r.headers.get("server")}')
    except urllib.error.HTTPError as e:
        print(f'GET {url}: status {e.code}, server={e.headers.get("server")}')
    except Exception as e:  # noqa: BLE001
        print(f'GET {url}: no answer ({type(e).__name__}: {e})')

if proxy:
    req = urllib.request.Request(
        f'http://{proxy[0]}/v1/messages',
        data=json.dumps({'model': 'spike-model', 'max_tokens': 16,
                         'messages': [{'role': 'user', 'content': 'hi'}]}).encode(),
        headers={'content-type': 'application/json', 'x-api-key': proxy[1],
                 'anthropic-version': '2023-06-01'},
    )
    try:
        body = json.loads(urllib.request.urlopen(req, timeout=8).read())
        text = body['content'][0]['text']
        print('proxy reply:', text.split('key-echo=')[0].strip(), '| key-echo =', text.split('key-echo=')[1][:12])
    except Exception as e:  # noqa: BLE001
        print(f'proxy request failed: {type(e).__name__}: {e}')
