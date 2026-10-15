#!/usr/bin/env python3
"""Synthetic stranger journey: the first ten minutes of a new person, against production.

Runs as the `stranger-journey` CronJob (every 12 h, and once after every Deploy Dev).
Each run signs up a throwaway account on a `.invalid` address, so it never
counts as a real signup (every Growth funnel script drops `*.invalid`).

  1. signup      POST /api/auth/register, then login
  2. workspace   the "My Workspace" pod exists
  3. welcome     Scout greets with the structural 'starts' payload (#2194)
  4. answer      Scout replies to Hamza's day-2 question (verbatim, 2026-09-12)
  5. card        within 3 Scout turns, a connect_local_agent approval card
  6. approve     resolving it returns the BYO connect path for this pod and name
  7. byo         the calls the BYO page makes on load succeed for that path, and
                 the seat is listed in the pod (the rendered page itself is not
                 checked here; that needs a browser)
  8. cleanup     the seat is uninstalled and the pod deleted with its messages.
                 The bare account row stays: there is no self-delete route, and
                 the admin delete removes only the user row. It is
                 eng-smoke-journey-*@ops.commonly.invalid, which Growth's
                 filters exclude. A scoped purge is TASK-260; none exists yet.

Every step prints one JSON line {journey, step, ok, ms, budget_ms, ...}; the last
line is {journey, result}. Exit 0 only if every hard step passed inside its
budget. Soft checks (Scout's wording) are logged as `soft` and never fail the
run, so an LLM phrasing change cannot page anyone. Runbook:
docs/runbooks/alerting.md#stranger-journey. Pass criteria come from Growth's
acceptance scripts (2026-10-14/15).
"""

import datetime
import json
import os
import secrets
import sys
import time
import urllib.error
import urllib.request

API = os.environ.get('JOURNEY_API', 'https://api.commonly.me').rstrip('/')
EMAIL_DOMAIN = os.environ.get('JOURNEY_EMAIL_DOMAIN', 'ops.commonly.invalid')
TRIGGER = os.environ.get('JOURNEY_TRIGGER', 'manual')
# Cloudflare rejects Python's default User-Agent (error 1010).
UA = 'commonly-sre-journey/1.0'

# Hamza's second day-2 message, verbatim. On 2026-09-12 Scout answered it with a
# generic explainer that said it did not know whether a public SDK exists, and
# he left. A good answer now points at the connect path.
DAY2_QUESTION = (
    'use, I need to use it in my cli to to work and develop it? , or even use my cli '
    'tool with agents, (my cli allows agnets to use it to build some good stuff) can we use it?'
)
FOLLOW_UPS = ['Claude Code', 'macOS']
GOOD_ANSWER_MARKERS = ('agent run', 'agents/byo', 'MCP', 'connect page')
WELCOME_LABELS = ('Connect an agent I already use', 'Start a pod for a project')

BUDGET_S = {'signup': 15, 'workspace': 60, 'welcome': 90, 'answer': 60, 'card': 240, 'approve': 15, 'byo': 15}


class StepFailed(Exception):
    pass


def emit(**fields):
    print(json.dumps({'journey': 'stranger', 'trigger': TRIGGER, **fields}), flush=True)


def call(method, path, body=None, token=None):
    req = urllib.request.Request(
        API + path, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={'User-Agent': UA, 'Content-Type': 'application/json',
                 **({'Authorization': f'Bearer {token}'} if token else {})})
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            return res.status, json.loads(res.read() or b'null')
    except urllib.error.HTTPError as err:
        try:
            return err.code, json.loads(err.read() or b'null')
        except ValueError:
            return err.code, None


def run_step(name, fn):
    started = time.monotonic()
    budget = BUDGET_S[name]
    try:
        detail = fn() or {}
    except StepFailed as err:
        emit(step=name, ok=False, ms=int((time.monotonic() - started) * 1000), budget_ms=budget * 1000, error=str(err))
        raise
    ms = int((time.monotonic() - started) * 1000)
    over = ms > budget * 1000
    emit(step=name, ok=not over, ms=ms, budget_ms=budget * 1000, **detail,
         **({'error': 'over budget'} if over else {}))
    if over:
        raise StepFailed(f'{name} took {ms} ms, budget {budget * 1000} ms')
    return detail


def poll(fn, timeout_s, every_s=3):
    deadline = time.monotonic() + timeout_s
    while True:
        found = fn()
        if found:
            return found
        if time.monotonic() >= deadline:
            return None
        time.sleep(every_s)


def message_id(message):
    # PostgreSQL rows carry an integer id; the Mongo fallback carries an ObjectId.
    value = str(message.get('id') or '')
    return int(value) if value.isdigit() else 0


def author(message):
    user = message.get('userId')
    return message.get('username') or (user.get('username') if isinstance(user, dict) else '') or ''


def is_scout(message):
    return author(message).lower().startswith('scout')


class Journey:
    def __init__(self):
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%m%d%H%M%S')
        # eng-smoke-*@ops.commonly.invalid: the shape Growth's outside-user filter excludes.
        self.username = f'eng-smoke-journey-{stamp}'
        self.email = f'{self.username}@{EMAIL_DOMAIN}'
        self.password = secrets.token_urlsafe(18)
        self.token = None
        self.pod = None
        self.seat = None

    def messages(self):
        status, data = call('GET', f'/api/messages/{self.pod}?limit=50', token=self.token)
        if status != 200:
            return []
        items = data if isinstance(data, list) else (data or {}).get('messages', [])
        return sorted(items, key=message_id)

    def scout_after(self, after):
        return [m for m in self.messages() if message_id(m) > after and is_scout(m)]

    def post(self, content):
        status, data = call('POST', f'/api/messages/{self.pod}', {'content': content}, token=self.token)
        if status >= 300 or not data:
            raise StepFailed(f'posting a message returned {status}')
        return message_id(data)

    def signup(self):
        status, data = call('POST', '/api/auth/register',
                            {'username': self.username, 'email': self.email, 'password': self.password})
        if status >= 300:
            raise StepFailed(f'register returned {status}: {(data or {}).get("message") or (data or {}).get("error")}')
        status, data = call('POST', '/api/auth/login', {'email': self.email, 'password': self.password})
        self.token = (data or {}).get('token')
        if not self.token:
            raise StepFailed(f'login returned {status} without a token')
        return {'username': self.username}

    def workspace(self):
        def find():
            status, pods = call('GET', '/api/pods', token=self.token)
            pods = pods if isinstance(pods, list) else (pods or {}).get('pods', [])
            mine = [p for p in pods if p.get('name') == 'My Workspace']
            return (mine[0].get('_id') or mine[0].get('id')) if mine else None
        self.pod = poll(find, BUDGET_S['workspace'])
        if not self.pod:
            raise StepFailed('no "My Workspace" pod appeared')
        return {}

    def welcome(self):
        def find():
            for m in self.messages():
                payload = m.get('payload') or {}
                if is_scout(m) and payload.get('kind') == 'starts':
                    return m
            return None
        greeting = poll(find, BUDGET_S['welcome'])
        if not greeting:
            raise StepFailed("Scout posted no welcome with payload.kind 'starts'")
        text = json.dumps(greeting.get('payload'))
        missing = [label for label in WELCOME_LABELS if label not in text]
        if missing:
            raise StepFailed(f'welcome is missing start labels: {missing}')
        return {}

    def answer(self):
        asked = self.post(DAY2_QUESTION)
        replies = poll(lambda: self.scout_after(asked), BUDGET_S['answer'])
        if not replies:
            raise StepFailed("Scout did not answer Hamza's day-2 question")
        text = ' '.join(m.get('content') or '' for m in replies)
        self.after_answer = message_id(replies[-1]) or asked
        self.card = self.card_in(replies)
        return {'soft': {
            'points_at_connect': any(marker.lower() in text.lower() for marker in GOOD_ANSWER_MARKERS),
            'mentions_sdk': 'sdk' in text.lower(),
        }}

    @staticmethod
    def card_in(messages):
        for m in messages:
            payload = m.get('payload') or {}
            if payload.get('actionType') == 'connect_local_agent' and payload.get('approvalId'):
                return m
        return None

    def card_step(self):
        turns = 1
        for follow_up in FOLLOW_UPS:
            if self.card:
                break
            sent = self.post(follow_up)
            replies = poll(lambda: self.scout_after(sent), 90)
            if not replies:
                raise StepFailed(f'Scout did not reply to "{follow_up}"')
            turns += 1
            self.card = self.card_in(replies)
        if not self.card:
            raise StepFailed(f'no connect_local_agent card within {turns} Scout turns')
        params = (self.card.get('payload') or {}).get('params') or {}
        self.seat = params.get('name')
        if not self.seat:
            raise StepFailed('the connect card carries no params.name')
        return {'turns': turns, 'seat': self.seat, 'soft': {'seat_named_for_user': self.seat.startswith(self.username)}}

    def approve(self):
        approval = self.card['payload']['approvalId']
        status, data = call('POST', f'/api/approvals/{approval}/resolve', {'decision': 'approved'}, token=self.token)
        if status != 200:
            raise StepFailed(f'resolve returned {status}')
        result = ((data or {}).get('approval') or {}).get('executionResult') or {}
        path = result.get('connectPath') or ''
        expected = f'/v2/agents/byo?pod={self.pod}&name={self.seat}'
        if path != expected:
            raise StepFailed(f'connectPath was {path!r}, expected {expected!r}')
        return {}

    def byo(self):
        # The page keeps ?pod= only if the pod is one of yours and not a DM or
        # public pod, then loads hosted availability and machines
        # (V2AgentBYO.tsx). It does not create anything on load.
        status, pods = call('GET', '/api/pods', token=self.token)
        pods = pods if isinstance(pods, list) else (pods or {}).get('pods', [])
        pod = next((p for p in pods if (p.get('_id') or p.get('id')) == self.pod), None)
        if not pod:
            raise StepFailed('the connect path names a pod the BYO page would not keep')
        if pod.get('type') in ('agent-room', 'agent-dm', 'agent-admin') or pod.get('publicRead'):
            raise StepFailed(f"the BYO page would drop pod type {pod.get('type')!r}")
        for path in ('/api/hosted/availability', '/api/machines'):
            status, _ = call('GET', path, token=self.token)
            if status != 200:
                raise StepFailed(f'{path} returned {status}')
        status, data = call('GET', f'/api/registry/pods/{self.pod}/agents', token=self.token)
        agents = data if isinstance(data, list) else (data or {}).get('agents', [])
        names = {a.get('name') or a.get('agentName') or a.get('instanceId') for a in agents}
        if self.seat not in names:
            raise StepFailed(f'seat {self.seat!r} is not listed in the pod after approval')
        return {}

    def cleanup(self):
        if not (self.token and self.pod):
            return
        results = {}
        if self.seat:
            status, _ = call('DELETE', f'/api/registry/agents/{self.seat}/pods/{self.pod}', token=self.token)
            results['seat'] = status
        status, _ = call('DELETE', f'/api/pods/{self.pod}', token=self.token)
        results['pod'] = status
        emit(step='cleanup', ok=all(code < 300 for code in results.values()), status=results)


def main():
    journey = Journey()
    steps = [('signup', journey.signup), ('workspace', journey.workspace), ('welcome', journey.welcome),
             ('answer', journey.answer), ('card', journey.card_step), ('approve', journey.approve),
             ('byo', journey.byo)]
    started = time.monotonic()
    try:
        for name, fn in steps:
            run_step(name, fn)
    except StepFailed as err:
        emit(result='fail', failed_step=name, error=str(err), ms=int((time.monotonic() - started) * 1000))
        return 1
    finally:
        journey.cleanup()
    emit(result='pass', ms=int((time.monotonic() - started) * 1000))
    return 0


if __name__ == '__main__':
    sys.exit(main())
