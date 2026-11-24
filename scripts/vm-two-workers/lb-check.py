"""Checks api-lb (deploy/vm/api-lb/nginx.conf) from a client on its network.

Run by lb-smoke.sh, inside a container on the same Docker network as api-lb and
two stand-in backends (echo-backend.py) named backend and backend-2. Phases:

  spread    sticky by CF-Connecting-IP, both backends used, headers kept
  down      backend-2 stopped: every user still answered, by backend
  draining  backend-2 answers 503: GETs move to backend, a POST is sent once

Exits non-zero on the first failed check. Standard library only.
"""
import json
import sys
import urllib.error
import urllib.request

LB = 'http://api-lb:5000'
USERS = [f'198.51.100.{n}' for n in range(1, 41)]
OWNERS = '/state/owners.json'


def request(url, ip=None, method='GET', forwarded_for=None):
    headers = {'X-Forwarded-Proto': 'https'}
    if ip:
        headers['CF-Connecting-IP'] = ip
    if forwarded_for:
        headers['X-Forwarded-For'] = forwarded_for
    data = b'{"n":1}' if method == 'POST' else None
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=15) as res:
            return res.status, json.loads(res.read())
    except urllib.error.HTTPError as err:
        return err.code, {}


def call(ip, method='GET', forwarded_for=None):
    return request(f'{LB}/api/echo', ip=ip, method=method, forwarded_for=forwarded_for)


def check(ok, message):
    if not ok:
        print(f'FAIL: {message}')
        sys.exit(1)


def spread():
    owner = {}
    for ip in USERS:
        seen = set()
        for _ in range(3):
            status, body = call(ip)
            check(status == 200, f'{ip} got {status}')
            check(body['cf_connecting_ip'] == ip, f'CF-Connecting-IP changed: sent {ip}, backend saw {body}')
            check(body['x_forwarded_proto'] == 'https', f'X-Forwarded-Proto lost: {body}')
            seen.add(body['backend'])
        check(len(seen) == 1, f'{ip} moved between backends: {sorted(seen)}')
        owner[ip] = seen.pop()
    on_one = sum(1 for name in owner.values() if name == 'backend')
    check(0 < on_one < len(USERS), f'only one backend served: {on_one} of {len(USERS)} on backend')
    print(f'ok: {len(USERS)} users each stuck to one backend ({on_one} on backend, '
          f'{len(USERS) - on_one} on backend-2); CF-Connecting-IP and X-Forwarded-Proto unchanged')

    status, body = call(USERS[0], forwarded_for='203.0.113.9')
    hops = [part.strip() for part in body['x_forwarded_for'].split(',')]
    check(status == 200 and hops[0] == '203.0.113.9' and len(hops) == 2,
          f'X-Forwarded-For replaced, not appended: {body["x_forwarded_for"]}')
    print(f'ok: X-Forwarded-For appended to ({body["x_forwarded_for"]})')
    with open(OWNERS, 'w') as handle:
        json.dump(owner, handle)


def down():
    for ip in USERS:
        status, body = call(ip)
        check(status == 200 and body.get('backend') == 'backend', f'{ip} got {status} {body} with backend-2 gone')
    print(f'ok: all {len(USERS)} users answered by backend while backend-2 is stopped')


def draining():
    with open(OWNERS) as handle:
        owner = json.load(handle)
    on_two = [ip for ip, name in owner.items() if name == 'backend-2']
    check(on_two, 'no user was on backend-2')
    for ip in on_two:
        status, body = call(ip)
        check(status == 200 and body.get('backend') == 'backend', f'GET from {ip} got {status} {body}')
    print(f'ok: {len(on_two)} users of a 503-answering backend-2 got their GETs from backend')

    before = sum(request(f'http://{name}:5000/count')[1]['posts'] for name in ('backend', 'backend-2'))
    status, _ = call(on_two[0], method='POST')
    after = sum(request(f'http://{name}:5000/count')[1]['posts'] for name in ('backend', 'backend-2'))
    check(after - before == 1, f'a POST reached the backends {after - before} times')
    print(f'ok: a POST was sent to exactly one backend (answer {status})')


if __name__ == '__main__':
    {'spread': spread, 'down': down, 'draining': draining}[sys.argv[1]]()
