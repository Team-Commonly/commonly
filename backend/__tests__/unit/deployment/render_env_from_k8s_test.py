"""Tests for deploy/vm/render_env_from_k8s.py against a fake kubectl.

  python3 -I render_env_from_k8s_test.py <path to render_env_from_k8s.py>
  python3 -I render_env_from_k8s_test.py <module path> --emit <dir>

--emit renders the fixture's backend.env into <dir> and writes expected.json
(name -> exact value), for singleVmCompose.test.js to read back through
`docker compose config` and prove compose parses the quoting byte for byte.
"""
import base64
import importlib.util
import io
import json
import os
import shutil
import stat
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True  # keep deploy/vm free of __pycache__
MODULE_PATH = sys.argv[1]
spec = importlib.util.spec_from_file_location('render_env_from_k8s', MODULE_PATH)
render_mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(render_mod)

# A fake PEM-shaped value (multi-line, base64 punctuation). The marker is
# assembled at run time so secret scanners don't read the fixture as a key.
PEM_MARK = 'RSA PRIVATE' + ' KEY'
PEM = '-----BEGIN ' + PEM_MARK + '-----\nMIIEsentinelAAA+/=\nline2==\n-----END ' + PEM_MARK + '-----\n'
# Every value carries SENTINEL so the tests can prove nothing printed one.
SENTINEL = 'zz-sentinel-'
TRICKY = {
    'JWT_SECRET': SENTINEL + "it's $HOME ${X} $(Y) $$ # not a comment",
    'GITHUB_APP_PRIVATE_KEY': SENTINEL + PEM,
    'HOSTED_MCP_HIDDEN_ENTRIES': SENTINEL + '["google-calendar","a b"]',
    'SMTP2GO_FROM_NAME': SENTINEL + ' padded \t tab, unicode é✓, back\\slash \\n ',
}


RUNTIME_JSON = json.dumps({'accounts': {
    'acct-one': {'runtimeToken': SENTINEL + 'rt1', 'userToken': SENTINEL + 'ut1',
                 'agentName': 'commonly-bot', 'instanceId': 'acct-one'},
    'acct-two': {'runtimeToken': SENTINEL + 'rt2', 'userToken': None,
                 'agentName': 'commonly-bot', 'instanceId': 'acct-two'},
}}, indent=2) + '\n'


def secret(name, data):
    return {'kind': 'Secret', 'metadata': {'name': name},
            'data': {k: base64.b64encode(v.encode()).decode() for k, v in data.items()}}


def deployment(container, env, extra_containers=()):
    containers = [{'name': c, 'env': [{'name': 'IGNORED', 'value': 'x'}]} for c in extra_containers]
    containers.append({'name': container, 'env': env})
    return {'kind': 'Deployment', 'spec': {'template': {'spec': {'containers': containers}}}}


def fixture():
    backend_env = [
        {'name': 'NODE_ENV', 'value': 'development'},
        {'name': 'MONGO_URI', 'valueFrom': {'secretKeyRef': {'name': 'database-credentials', 'key': 'mongo-uri'}}},
        {'name': 'PG_HOST', 'value': 'pg.cluster.local'},
        {'name': 'LOG_LEVEL', 'value': 'info'},
        {'name': 'FRONTEND_URL', 'value': 'https://app.example.test'},
        {'name': 'BACKEND_URL', 'value': '$(FRONTEND_URL)/api and $$(FRONTEND_URL)'},
        {'name': 'K8S_NAMESPACE', 'value': 'ns-should-not-appear'},
        {'name': 'POD_NAME', 'valueFrom': {'fieldRef': {'fieldPath': 'metadata.name'}}},
        {'name': 'LITELLM_CHAT_MODEL', 'valueFrom': {'configMapKeyRef': {'name': 'models', 'key': 'chat'}}},
        {'name': 'STRIPE_SECRET_KEY', 'valueFrom': {'secretKeyRef': {'name': 'api-keys', 'key': 'stripe', 'optional': True}}},
        {'name': 'DISCORD_GUILD_ID', 'valueFrom': {'secretKeyRef': {'name': 'no-such-secret', 'key': 'x', 'optional': True}}},
        {'name': 'GITHUB_CONNECT_APP_ID', 'value': SENTINEL + 'ends with backslash\\'},
    ] + [{'name': n, 'valueFrom': {'secretKeyRef': {'name': 'api-keys', 'key': n.lower()}}} for n in TRICKY]
    litellm_env = [
        {'name': 'LITELLM_MASTER_KEY', 'valueFrom': {'secretKeyRef': {'name': 'api-keys', 'key': 'master'}}},
        {'name': 'PG_PASSWORD', 'valueFrom': {'secretKeyRef': {'name': 'database-credentials', 'key': 'pg'}}},
        {'name': 'DATABASE_URL', 'value': 'postgresql://u:$(PG_PASSWORD)@h/db'},
        {'name': 'OPENAI_API_KEY', 'valueFrom': {'secretKeyRef': {'name': 'api-keys', 'key': 'openai', 'optional': True}}},
    ]
    bot_env = [
        {'name': 'NODE_ENV', 'value': 'development'},
        {'name': 'COMMONLY_BASE_URL', 'value': 'http://backend.ns.svc:5000'},
        {'name': 'COMMONLY_AGENT_POLL_MS', 'value': '5000'},
        {'name': 'LITELLM_API_KEY', 'valueFrom': {'secretKeyRef': {'name': 'api-keys', 'key': 'bot-key'}}},
        {'name': 'COMMONLY_SOCIAL_POST_TO_FEED', 'valueFrom': {'secretKeyRef': {
            'name': 'api-keys', 'key': 'social-feed', 'optional': True}}},
    ]
    api_keys = {n.lower(): v for n, v in TRICKY.items()}
    api_keys['master'] = SENTINEL + 'master'
    api_keys['bot-key'] = SENTINEL + 'bot-key'
    return {
        'deployment/backend': deployment('backend', backend_env, extra_containers=['skills-init']),
        'deployment/litellm': deployment('litellm', litellm_env, extra_containers=['codex-auth-rotator']),
        'secret/api-keys': secret('api-keys', api_keys),
        'secret/database-credentials': secret('database-credentials', {
            'mongo-uri': 'mongodb+srv://u:' + SENTINEL + 'pw@host/db?retryWrites=true', 'pg': SENTINEL + 'pg'}),
        'configmap/models': {'kind': 'ConfigMap', 'data': {'chat': 'model-a'}},
        'deployment/commonly-bot': deployment('commonly-bot', bot_env),
        'configmap/commonly-bot-config': {'kind': 'ConfigMap', 'data': {'runtime.json': RUNTIME_JSON}},
    }


FAKE_KUBECTL = r'''#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
with open(os.environ['FAKE_KUBE_LOG'], 'a') as log:
    log.write(json.dumps(args) + '\n')
assert args[0:4] == ['--context', 'ctx-a', '--namespace', 'ns-a'], args
kind, name = args[5], args[6]
objects = json.load(open(os.environ['FAKE_KUBE_FIXTURE']))
obj = objects.get('%s/%s' % (kind, name))
if obj is None:
    sys.stderr.write('Error from server (NotFound): %s "%s" not found\n' % (kind, name))
    sys.exit(1)
print(json.dumps(obj))
'''


class FakeCluster:
    def __init__(self, objects):
        self.dir = tempfile.mkdtemp()
        self.kubectl = os.path.join(self.dir, 'kubectl')
        with open(self.kubectl, 'w') as handle:
            handle.write(FAKE_KUBECTL)
        os.chmod(self.kubectl, 0o755)
        self.fixture = os.path.join(self.dir, 'fixture.json')
        with open(self.fixture, 'w') as handle:
            json.dump(objects, handle)
        self.log = os.path.join(self.dir, 'log')
        os.environ['FAKE_KUBE_FIXTURE'] = self.fixture
        os.environ['FAKE_KUBE_LOG'] = self.log
        os.environ['KUBECTL'] = self.kubectl
        self.out = os.path.join(self.dir, 'out')
        os.mkdir(self.out)

    def run(self, *extra):
        stdout, stderr = io.StringIO(), io.StringIO()
        old = sys.stdout, sys.stderr
        sys.stdout, sys.stderr = stdout, stderr
        try:
            code = render_mod.main(['--context', 'ctx-a', '--namespace', 'ns-a', '--out-dir', self.out, *extra])
        finally:
            sys.stdout, sys.stderr = old
        return code, stdout.getvalue() + stderr.getvalue()

    def close(self):
        shutil.rmtree(self.dir)


def parse_single_quoted(text):
    """Compose v2's reading of a single-quoted env_file value (probed on 2.40):
    bytes kept verbatim, \\' is a quote, \\\\ is kept as two backslashes."""
    out, i = {}, 0
    lines = text.split('\n')
    while i < len(lines):
        line = lines[i]
        i += 1
        if not line or line.startswith('#'):
            continue
        name, rest = line.split('=', 1)
        assert rest.startswith("'"), line
        body, j = rest[1:], 0
        value = ''
        while True:
            if j >= len(body):
                value += '\n'
                body, j = lines[i], 0
                i += 1
                continue
            ch = body[j]
            if ch == '\\' and j + 1 < len(body) and body[j + 1] in "'\\":
                value += "'" if body[j + 1] == "'" else '\\\\'
                j += 2
            elif ch == "'":
                break
            else:
                value += ch
                j += 1
        out[name] = value
    return out


class RenderTest(unittest.TestCase):
    def setUp(self):
        self.cluster = FakeCluster(fixture())
        self.code, self.output = self.cluster.run()

    def tearDown(self):
        self.cluster.close()

    def read(self, name):
        with open(os.path.join(self.cluster.out, name)) as handle:
            return handle.read()

    def test_writes_every_file_at_0600(self):
        self.assertEqual(self.code, 0, self.output)
        for name in ('backend.env', 'litellm.env', 'backup.env', 'commonly-bot.env',
                     os.path.join('commonly-bot-state', 'runtime.json')):
            mode = stat.S_IMODE(os.stat(os.path.join(self.cluster.out, name)).st_mode)
            self.assertEqual(mode, 0o600, name)
        self.assertEqual(sorted(os.listdir(self.cluster.out)),
                         ['backend.env', 'backup.env', 'commonly-bot-state', 'commonly-bot.env', 'litellm.env'])
        state = os.path.join(self.cluster.out, 'commonly-bot-state')
        self.assertEqual(stat.S_IMODE(os.stat(state).st_mode), 0o700)
        self.assertEqual(os.listdir(state), ['runtime.json'])

    def test_copies_the_bot_accounts_file_verbatim_and_its_env(self):
        with open(os.path.join(self.cluster.out, 'commonly-bot-state', 'runtime.json')) as handle:
            self.assertEqual(handle.read(), RUNTIME_JSON)
        self.assertIn('accounts copied', self.output)
        bot = parse_single_quoted(self.read('commonly-bot.env'))
        self.assertEqual(bot, {'COMMONLY_AGENT_POLL_MS': '5000', 'LITELLM_API_KEY': SENTINEL + 'bot-key'})
        code, listed = self.cluster.run('--list-names')
        self.assertEqual(code, 0)
        self.assertNotIn('acct-one', listed)

    def test_a_missing_bot_config_writes_nothing(self):
        objects = fixture()
        del objects['configmap/commonly-bot-config']
        cluster = FakeCluster(objects)
        try:
            code, output = cluster.run()
            self.assertEqual(code, 1)
            self.assertIn('No file was written', output)
            self.assertEqual(os.listdir(cluster.out), [])
        finally:
            cluster.close()

    def test_never_prints_a_value(self):
        self.assertNotIn(SENTINEL, self.output)
        self.assertNotIn('model-a', self.output)
        self.assertIn('written', self.output)

    def test_resolves_literals_secrets_configmaps_and_refs(self):
        env = parse_single_quoted(self.read('backend.env'))
        for name, value in TRICKY.items():
            self.assertEqual(env[name], value, name)
        self.assertEqual(env['LOG_LEVEL'], 'info')
        self.assertEqual(env['LITELLM_CHAT_MODEL'], 'model-a')
        self.assertEqual(env['BACKEND_URL'], 'https://app.example.test/api and $(FRONTEND_URL)')
        self.assertTrue(env['MONGO_URI'].startswith('mongodb+srv://'))

    def test_keeps_only_example_names(self):
        env = parse_single_quoted(self.read('backend.env'))
        for name in ('NODE_ENV', 'PG_HOST', 'K8S_NAMESPACE', 'POD_NAME', 'IGNORED'):
            self.assertNotIn(name, env)
        self.assertEqual(list(parse_single_quoted(self.read('backup.env'))), ['MONGO_URI'])
        litellm = parse_single_quoted(self.read('litellm.env'))
        self.assertEqual(sorted(litellm), ['LITELLM_MASTER_KEY'])

    def test_absent_optional_refs_and_unrepresentable_values_are_skipped(self):
        env = parse_single_quoted(self.read('backend.env'))
        for name in ('STRIPE_SECRET_KEY', 'DISCORD_GUILD_ID', 'GITHUB_CONNECT_APP_ID'):
            self.assertNotIn(name, env)
        self.assertIn('not representable', self.output)
        self.assertIn('optional reference, absent in the cluster', self.output)
        code, listed = self.cluster.run('--list-names')
        self.assertEqual(code, 0)
        self.assertIn('GITHUB_CONNECT_APP_ID', listed)
        self.assertNotIn(SENTINEL, listed)

    def test_a_missing_required_secret_writes_nothing(self):
        objects = fixture()
        del objects['secret/database-credentials']
        cluster = FakeCluster(objects)
        try:
            code, output = cluster.run()
            self.assertEqual(code, 1)
            self.assertIn('No file was written', output)
            self.assertEqual(os.listdir(cluster.out), [])
        finally:
            cluster.close()

    def test_quote_rule(self):
        self.assertEqual(render_mod.quote_env_value("a'b"), "'a\\'b'")
        self.assertIsNone(render_mod.quote_env_value('ends\\'))
        self.assertIsNone(render_mod.quote_env_value("x\\'y"))
        self.assertIsNone(render_mod.quote_env_value('nul\0'))
        self.assertEqual(render_mod.quote_env_value('a\\nb'), "'a\\nb'")


def emit(directory):
    cluster = FakeCluster(fixture())
    try:
        code, output = cluster.run()
        if code != 0:
            raise SystemExit(output)
        shutil.copy(os.path.join(cluster.out, 'backend.env'), os.path.join(directory, 'backend.env'))
        with open(os.path.join(cluster.out, 'backend.env')) as handle:
            expected = parse_single_quoted(handle.read())
        for name, value in TRICKY.items():
            assert expected[name] == value, name
        with open(os.path.join(directory, 'expected.json'), 'w') as handle:
            json.dump(expected, handle)
    finally:
        cluster.close()


if __name__ == '__main__':
    if len(sys.argv) > 3 and sys.argv[2] == '--emit':
        emit(sys.argv[3])
    else:
        unittest.main(argv=[sys.argv[0]], verbosity=1)
