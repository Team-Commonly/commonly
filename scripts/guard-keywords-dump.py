"""Print the injection guard's always-block keywords as JSON, for the guard-name canary.

Run inside the litellm container, so the list is the one the serving guard
loads (its own config, its own litellm version), never a copy:

  kubectl exec -i -n NS deploy/litellm -c litellm -- /app/.venv/bin/python3 -I - < scripts/guard-keywords-dump.py

`-I` keeps /app (a source tree that shadows the installed package) off
sys.path. Prints {"guard", "litellm", "categories": {category: [keyword, ...]}},
or {"error": "..."} when the guard or its lists can't be read; the canary treats
that as an unread list (inconclusive), never as an empty one. Only
always_block_keywords are read: they are the matches a name alone can complete.
See scripts/guard-name-canary.js.
"""
import json
import os

GUARD = os.environ.get('GUARD_NAME', 'injection-guard')
CONFIG = os.environ.get('LITELLM_CONFIG_PATH', '/app/config.yaml')

try:
    import yaml
    import litellm
    from importlib.metadata import version

    with open(CONFIG) as f:
        config = yaml.safe_load(f)
    guards = [g for g in (config.get('guardrails') or []) if g.get('guardrail_name') == GUARD]
    if not guards:
        raise LookupError('guardrail %s not in %s' % (GUARD, CONFIG))
    params = guards[0].get('litellm_params') or {}
    base = os.path.join(os.path.dirname(litellm.__file__), 'proxy', 'guardrails',
                        'content_filter_data', 'categories')
    categories = {}
    for entry in params.get('categories') or []:
        name = entry.get('category')
        with open(os.path.join(base, name + '.yaml')) as f:
            data = yaml.safe_load(f) or {}
        categories[name] = [k['keyword'] for k in (data.get('always_block_keywords') or [])
                            if isinstance(k, dict) and k.get('keyword')]
    if not categories:
        raise LookupError('guardrail %s declares no categories' % GUARD)
    print(json.dumps({'guard': GUARD, 'litellm': version('litellm'), 'categories': categories}))
except Exception as err:  # noqa: BLE001 - every failure is reported, never raised
    print(json.dumps({'error': ('%s: %s' % (type(err).__name__, err))[:300]}))
