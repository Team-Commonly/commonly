"""LiteLLM callback: lets codex drive DeepSeek through /v1/responses.

codex groups tools into `namespace` tools (its MCP servers, its sub-agent
tools) and adds hosted tools such as `web_search`. DeepSeek accepts only
`function` tools and rejects the whole request otherwise:

    tools[4].type: unknown variant `namespace`, expected `function`

For the model groups in SHIM_MODEL_GROUPS only, the request hook flattens each
namespace into plain function tools named `<namespace>__<tool>` and drops the
hosted tools DeepSeek cannot run. The response hooks map a call to a flattened
name back to `name` + `namespace`, which is how codex resolves a namespaced
call. Every other model group passes through untouched.

Mounted next to config.yaml (/app/) because LiteLLM resolves callback modules
relative to the config file's directory.
"""
import hashlib

from litellm.integrations.custom_logger import CustomLogger

SHIM_MODEL_GROUPS = frozenset({'deepseek-flash-1017'})
SEPARATOR = '__'
# DeepSeek's function names: ^[a-zA-Z0-9_-]{1,64}$
MAX_NAME_LENGTH = 64

# flat name -> (namespace, tool name). Filled by the request hook and read by
# the response hooks. A flat name is a pure function of its pair, so entries
# never go stale, and the map is bounded by the number of distinct tools.
_ORIGINAL_BY_FLAT = {}


def flat_name(namespace, name):
    flat = f'{namespace}{SEPARATOR}{name}'
    if len(flat) > MAX_NAME_LENGTH:
        digest = hashlib.sha256(flat.encode()).hexdigest()[:8]
        flat = f'{flat[:MAX_NAME_LENGTH - 9]}_{digest}'
    _ORIGINAL_BY_FLAT[flat] = (namespace, name)
    return flat


def applies_to(data):
    return isinstance(data, dict) and data.get('model') in SHIM_MODEL_GROUPS


def flatten_request(data):
    """Rewrite a /v1/responses request body in place. Returns it."""
    if not applies_to(data):
        return data
    tools = data.get('tools')
    if isinstance(tools, list):
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
                        flattened.append({**inner, 'name': flat_name(namespace, inner['name'])})
            # Any other type is a hosted tool (web_search, ...) DeepSeek cannot run.
        data['tools'] = flattened
    # Earlier turns' calls come back as input items; they must name the
    # flattened tool or the model sees calls to tools it was never given.
    items = data.get('input')
    if isinstance(items, list):
        for item in items:
            if isinstance(item, dict) and item.get('type') == 'function_call' and item.get('namespace'):
                item['name'] = flat_name(item.pop('namespace'), item.get('name') or '')
    choice = data.get('tool_choice')
    if isinstance(choice, dict) and choice.get('type') != 'function':
        data['tool_choice'] = 'auto'
    return data


def _restore_one(obj):
    if isinstance(obj, dict):
        if obj.get('type') == 'function_call' and obj.get('name') in _ORIGINAL_BY_FLAT:
            obj['namespace'], obj['name'] = _ORIGINAL_BY_FLAT[obj['name']]
        return
    if getattr(obj, 'type', None) == 'function_call' and getattr(obj, 'name', None) in _ORIGINAL_BY_FLAT:
        namespace, name = _ORIGINAL_BY_FLAT[obj.name]
        obj.name = name
        setattr(obj, 'namespace', namespace)


def restore_calls(obj, depth=0):
    """Map flattened function-call names back to name + namespace, in place.

    Walks dicts, lists and pydantic objects, because a streamed event nests the
    call (output_item.added -> item, response.completed -> response.output[]).
    """
    if obj is None or depth > 8 or isinstance(obj, (str, bytes, int, float, bool)):
        return obj
    _restore_one(obj)
    if isinstance(obj, dict):
        children = obj.values()
    elif isinstance(obj, (list, tuple)):
        children = obj
    elif hasattr(obj, '__dict__'):
        children = list(vars(obj).values())
    else:
        children = ()
    for child in children:
        restore_calls(child, depth + 1)
    return obj


class DeepseekToolShim(CustomLogger):
    async def async_pre_call_hook(self, user_api_key_dict, cache, data, call_type):
        return flatten_request(data)

    async def async_post_call_success_hook(self, data, user_api_key_dict, response):
        if applies_to(data):
            restore_calls(response)
        return response

    async def async_post_call_streaming_iterator_hook(self, user_api_key_dict, response, request_data):
        shim = applies_to(request_data)
        async for chunk in response:
            yield restore_calls(chunk) if shim else chunk


proxy_handler_instance = DeepseekToolShim()
