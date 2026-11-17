"""Render the VM's env files from the live chart. Run through render-env-from-k8s.sh.

Reads the backend, litellm and commonly-bot Deployments in one namespace,
resolves every env entry of their main container the way the kubelet does (value
literals with $(VAR) references, secretKeyRef, configMapKeyRef), and writes:

  backend.env       names in backend.env.example, from the backend container
  litellm.env       names in litellm.env.example, from the litellm container
  backup.env        names in backup.env.example, from the backend container
  commonly-bot.env  names in commonly-bot.env.example, from the commonly-bot container
  commonly-bot-state/runtime.json
                    the commonly-bot-config ConfigMap's runtime.json: the
                    bot's accounts and their runtime tokens, so a secret too

Values are written single-quoted, so compose does no ${...} interpolation on
them. In a single-quoted env_file value compose v2 keeps every byte (newlines,
$, #, backslashes) except that \\' stands for a quote; a value with a backslash
right before a quote or at its end cannot be written that way and is skipped.

Secrets are read inside this process and never printed: the report is counts of
names per outcome. --list-names adds the names (never values).
"""
import argparse
import base64
import json
import os
import re
import subprocess
import sys
import tempfile
from datetime import datetime, timezone

TARGETS = [
    # (output file, example file, deployment, container)
    ('backend.env', 'backend.env.example', 'backend', 'backend'),
    ('litellm.env', 'litellm.env.example', 'litellm', 'litellm'),
    ('backup.env', 'backup.env.example', 'backend', 'backend'),
    ('commonly-bot.env', 'commonly-bot.env.example', 'commonly-bot', 'commonly-bot'),
]

# (ConfigMap, key, output path under --out-dir). Copied verbatim, at 0600 in a
# 0700 directory; the backend's non-Kubernetes provisioner keeps writing it.
CONFIG_FILES = [
    ('commonly-bot-config', 'runtime.json', os.path.join('commonly-bot-state', 'runtime.json')),
]

NAME_RE = re.compile(r'^([A-Z_][A-Z0-9_]*)=')
REF_RE = re.compile(r'\$\$|\$\(([A-Za-z_][A-Za-z0-9_]*)\)')


class RenderError(Exception):
    pass


class Kube:
    """kubectl in one context and namespace. KUBECTL overrides the binary (tests)."""

    def __init__(self, context, namespace, kubectl=None):
        self.base = [kubectl or os.environ.get('KUBECTL', 'kubectl'),
                     '--context', context, '--namespace', namespace]
        self.cache = {}

    def get(self, kind, name, missing_ok=False):
        key = (kind, name)
        if key not in self.cache:
            proc = subprocess.run(self.base + ['get', kind, name, '-o', 'json'],
                                  capture_output=True, text=True, check=False)
            if proc.returncode != 0:
                if 'NotFound' in proc.stderr or 'not found' in proc.stderr:
                    self.cache[key] = None
                else:
                    # kubectl's stderr names the object, never a secret's data.
                    raise RenderError('kubectl get %s %s failed: %s' % (kind, name, proc.stderr.strip()))
            else:
                self.cache[key] = json.loads(proc.stdout)
        obj = self.cache[key]
        if obj is None and not missing_ok:
            raise RenderError('%s %s not found' % (kind, name))
        return obj


def expand_refs(value, resolved):
    """Kubernetes $(VAR) expansion against earlier entries; $$ is a literal $."""
    def sub(match):
        if match.group(0) == '$$':
            return '$'
        name = match.group(1)
        return resolved[name] if name in resolved else match.group(0)
    return REF_RE.sub(sub, value)


def resolve_container_env(kube, deployment, container):
    """Returns (resolved {name: value}, skipped {name: reason})."""
    dep = kube.get('deployment', deployment)
    containers = dep['spec']['template']['spec'].get('containers', [])
    match = [c for c in containers if c.get('name') == container]
    if not match:
        raise RenderError('deployment %s has no container %s' % (deployment, container))
    spec = match[0]
    resolved, skipped = {}, {}
    if spec.get('envFrom'):
        skipped['(envFrom)'] = 'envFrom is not rendered'
    for entry in spec.get('env', []):
        name = entry['name']
        skipped.pop(name, None)
        resolved.pop(name, None)
        if 'value' in entry or 'valueFrom' not in entry:
            resolved[name] = expand_refs(entry.get('value', ''), resolved)
            continue
        source = entry['valueFrom']
        if 'secretKeyRef' in source or 'configMapKeyRef' in source:
            kind = 'secret' if 'secretKeyRef' in source else 'configmap'
            ref = source['secretKeyRef' if kind == 'secret' else 'configMapKeyRef']
            optional = bool(ref.get('optional'))
            obj = kube.get(kind, ref['name'], missing_ok=optional)
            data = (obj or {}).get('data') or {}
            if ref['key'] not in data:
                if kind == 'configmap' and ref['key'] in ((obj or {}).get('binaryData') or {}):
                    skipped[name] = 'binary configmap data'
                    continue
                if optional:
                    skipped[name] = 'optional reference, absent in the cluster'
                    continue
                raise RenderError('%s: required %s key is missing' % (name, kind))
            raw = data[ref['key']]
            if kind == 'secret':
                try:
                    raw = base64.b64decode(raw).decode('utf-8')
                except (ValueError, UnicodeDecodeError):
                    skipped[name] = 'secret value is not UTF-8 text'
                    continue
            resolved[name] = raw
        elif 'fieldRef' in source:
            skipped[name] = 'fieldRef (pod metadata) has no VM equivalent'
        elif 'resourceFieldRef' in source:
            skipped[name] = 'resourceFieldRef has no VM equivalent'
        else:
            skipped[name] = 'unknown valueFrom source'
    return resolved, skipped


def quote_env_value(value):
    """A compose env_file single-quoted value, or None when one can't hold it."""
    if '\0' in value or re.search(r"\\(?='|$)", value):
        return None
    return "'" + value.replace("'", "\\'") + "'"


def example_names(path):
    names = []
    with open(path, encoding='utf-8') as handle:
        for line in handle:
            match = NAME_RE.match(line)
            if match:
                names.append(match.group(1))
    return names


def write_private(path, text):
    directory = os.path.dirname(os.path.abspath(path))
    fd, tmp = tempfile.mkstemp(dir=directory, prefix='.render-', suffix='.tmp')
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'w', encoding='utf-8') as handle:
            handle.write(text)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise
    os.chmod(path, 0o600)


def render(kube, vm_dir, out_dir):
    """Renders every target. Returns a report: {file: {outcome: [names]}}."""
    envs = {}
    rendered = []
    report = {}
    for out_name, example, deployment, container in TARGETS:
        key = (deployment, container)
        if key not in envs:
            envs[key] = resolve_container_env(kube, deployment, container)
        resolved, skipped = envs[key]
        wanted = example_names(os.path.join(vm_dir, example))
        outcome = {'written': [], 'not set in the cluster': [], 'not representable': []}
        for reason in sorted(set(skipped.values())):
            outcome['skipped: ' + reason] = []
        lines = ['# Rendered by render-env-from-k8s.sh at %s from deployment/%s.'
                 % (datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'), deployment),
                 '# Secrets: keep at mode 0600, never commit or print.']
        for name in wanted:
            if name in resolved:
                quoted = quote_env_value(resolved[name])
                if quoted is None:
                    outcome['not representable'].append(name)
                    continue
                lines.append('%s=%s' % (name, quoted))
                outcome['written'].append(name)
            elif name in skipped:
                outcome['skipped: ' + skipped[name]].append(name)
            else:
                outcome['not set in the cluster'].append(name)
        outcome['outside the example (k8s-only or unused)'] = sorted(
            n for n in list(resolved) + list(skipped) if n not in wanted)
        rendered.append((os.path.join(out_dir, out_name), '\n'.join(lines) + '\n'))
        report[out_name] = outcome
    for configmap, key, rel_path in CONFIG_FILES:
        data = (kube.get('configmap', configmap).get('data') or {})
        if key not in data:
            raise RenderError('configmap %s has no %s' % (configmap, key))
        try:
            accounts = json.loads(data[key]).get('accounts') or {}
        except (ValueError, AttributeError):
            raise RenderError('configmap %s: %s is not a JSON object' % (configmap, key)) from None
        rendered.append((os.path.join(out_dir, rel_path), data[key]))
        report[rel_path] = {'accounts copied': sorted(accounts)}
    # Write only after every target resolved, so a failure leaves no half set.
    for path, text in rendered:
        directory = os.path.dirname(os.path.abspath(path))
        os.makedirs(directory, mode=0o700, exist_ok=True)
        if directory != os.path.abspath(out_dir):
            os.chmod(directory, 0o700)
        write_private(path, text)
    return report


def print_report(report, list_names, stream):
    for out_name, outcome in report.items():
        stream.write('%s:\n' % out_name)
        for label, names in outcome.items():
            if not names and label != 'written':
                continue
            stream.write('  %-44s %d\n' % (label, len(names)))
            if list_names and label not in ('written', 'accounts copied'):
                for name in names:
                    stream.write('      %s\n' % name)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('--context', required=True, help='kubectl context')
    parser.add_argument('--namespace', required=True, help='namespace of the backend, litellm and commonly-bot Deployments')
    parser.add_argument('--out-dir', help='where to write the env files (default: deploy/vm)')
    parser.add_argument('--list-names', action='store_true', help='also print the names in each skipped group')
    args = parser.parse_args(argv)
    os.umask(0o077)
    vm_dir = os.path.dirname(os.path.abspath(__file__))
    out_dir = args.out_dir or vm_dir
    try:
        report = render(Kube(args.context, args.namespace), vm_dir, out_dir)
    except RenderError as err:
        sys.stderr.write('render-env-from-k8s: %s\nNo file was written.\n' % err)
        return 1
    print_report(report, args.list_names, sys.stdout)
    return 0


if __name__ == '__main__':
    sys.exit(main())
