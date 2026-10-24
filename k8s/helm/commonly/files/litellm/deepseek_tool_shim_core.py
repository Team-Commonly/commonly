"""DeepSeek tool shim: the transformation. Loaded by deepseek_tool_shim.py.

codex groups tools into `namespace` tools (its MCP servers, its sub-agent
tools) and adds hosted tools such as `web_search`. DeepSeek accepts only
`function` tools and rejects the whole request otherwise:

    tools[4].type: unknown variant `namespace`, expected `function`

flatten_request turns each namespaced tool into a plain function tool and
drops hosted tools, and returns the request's own map from flat name back to
(namespace, name). restore_calls uses that map to give each call in the
response back its name + namespace, which is how codex resolves it.

The map belongs to one request: flat names are allocated unique against every
function name in that request, and nothing is shared between requests, so a
later request's plain function is never mistaken for an earlier flattened one.
"""
import hashlib

SEPARATOR = '__'
# DeepSeek's function names: ^[a-zA-Z0-9_-]{1,64}$
MAX_NAME_LENGTH = 64


def _fit(name, salt=''):
    if len(name) <= MAX_NAME_LENGTH and not salt:
        return name
    digest = hashlib.sha256(f'{name}\0{salt}'.encode()).hexdigest()[:8]
    return f'{name[:MAX_NAME_LENGTH - 9]}_{digest}'


class _Allocator:
    """Hands out flat names that are unique within one request."""

    def __init__(self, taken):
        self.taken = set(taken)
        self.by_pair = {}
        self.original_by_flat = {}

    def flat(self, namespace, name):
        pair = (namespace, name)
        if pair in self.by_pair:
            return self.by_pair[pair]
        candidate = _fit(f'{namespace}{SEPARATOR}{name}')
        salt = 0
        while candidate in self.taken:
            salt += 1
            candidate = _fit(f'{namespace}{SEPARATOR}{name}', str(salt))
        self.taken.add(candidate)
        self.by_pair[pair] = candidate
        self.original_by_flat[candidate] = pair
        return candidate


def flatten_request(data):
    """Rewrite a /v1/responses request body in place.

    Returns {flat name: (namespace, name)} for this request.
    """
    tools = data.get('tools') if isinstance(data.get('tools'), list) else []
    items = data.get('input') if isinstance(data.get('input'), list) else []
    # Plain functions keep their names; every flat name must avoid them.
    allocator = _Allocator(
        t.get('name') for t in tools
        if isinstance(t, dict) and t.get('type') == 'function' and t.get('name'))
    if 'tools' in data and isinstance(data['tools'], list):
        flattened = []
        for tool in tools:
            if not isinstance(tool, dict):
                continue
            kind = tool.get('type')
            if kind == 'function':
                flattened.append(tool)
            elif kind == 'namespace':
                namespace = tool.get('name') or ''
                for inner in tool.get('tools') or []:
                    if isinstance(inner, dict) and inner.get('type') == 'function' and inner.get('name'):
                        flattened.append({**inner, 'name': allocator.flat(namespace, inner['name'])})
            # Any other type is a hosted tool (web_search, ...) DeepSeek cannot run.
        data['tools'] = flattened
    # Earlier turns' calls come back as input items; they must name the
    # flattened tool or the model sees calls to tools it was never given.
    for item in items:
        if isinstance(item, dict) and item.get('type') == 'function_call' and item.get('namespace'):
            item['name'] = allocator.flat(item.pop('namespace'), item.get('name') or '')
    choice = data.get('tool_choice')
    if isinstance(choice, dict) and choice.get('type') != 'function':
        data['tool_choice'] = 'auto'
    return allocator.original_by_flat


def _restore_one(obj, original_by_flat):
    if isinstance(obj, dict):
        if obj.get('type') == 'function_call' and obj.get('name') in original_by_flat:
            obj['namespace'], obj['name'] = original_by_flat[obj['name']]
        return
    if getattr(obj, 'type', None) == 'function_call' and getattr(obj, 'name', None) in original_by_flat:
        namespace, name = original_by_flat[obj.name]
        obj.name = name
        setattr(obj, 'namespace', namespace)


def restore_calls(obj, original_by_flat, depth=0):
    """Map this request's flat call names back to name + namespace, in place.

    Walks dicts, lists and pydantic objects, because a streamed event nests the
    call (output_item.added -> item, response.completed -> response.output[]).
    """
    if not original_by_flat or obj is None or depth > 8 or isinstance(obj, (str, bytes, int, float, bool)):
        return obj
    _restore_one(obj, original_by_flat)
    if isinstance(obj, dict):
        children = list(obj.values())
    elif isinstance(obj, (list, tuple)):
        children = obj
    elif hasattr(obj, '__dict__'):
        children = list(vars(obj).values())
    else:
        children = ()
    for child in children:
        restore_calls(child, original_by_flat, depth + 1)
    return obj
