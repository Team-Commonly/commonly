"""LiteLLM callback entry point for the DeepSeek tool shim.

The transformation lives in deepseek_tool_shim_core.py (see its docstring).
This file is the failure boundary. LiteLLM loads every module in
`litellm_settings.callbacks` at startup and an exception there stops the whole
proxy, so the core is loaded here inside a try. If it fails to load, every
other model group is served as usual and requests for SHIM_MODEL_GROUPS are
refused with the load error, rather than sent with tools DeepSeek rejects.

Each request's name map is kept on that request's own logging object, which
LiteLLM creates per call, never sends upstream, and passes to every hook.

Mounted next to config.yaml (/app/) because LiteLLM resolves callback modules
relative to the config file's directory.
"""
import importlib.util
import os

try:
    from litellm.integrations.custom_logger import CustomLogger
except Exception:  # LiteLLM itself is broken; stay importable.
    CustomLogger = object

SHIM_MODEL_GROUPS = frozenset({'deepseek-flash-1017'})
CORE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'deepseek_tool_shim_core.py')
MAP_ATTRIBUTE = '_commonly_deepseek_tool_map'


def _load_core(path):
    spec = importlib.util.spec_from_file_location('deepseek_tool_shim_core', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


try:
    core = _load_core(CORE_PATH)
    LOAD_ERROR = None
except Exception as error:  # includes SyntaxError and ImportError
    core = None
    LOAD_ERROR = f'{type(error).__name__}: {error}'


def applies_to(data):
    return isinstance(data, dict) and data.get('model') in SHIM_MODEL_GROUPS


def _request_map(data):
    return getattr(data.get('litellm_logging_obj'), MAP_ATTRIBUTE, None)


class DeepseekToolShim(CustomLogger):
    async def async_pre_call_hook(self, user_api_key_dict, cache, data, call_type):
        if not applies_to(data):
            return data
        if core is None:
            # A str return makes LiteLLM refuse this request with a 400.
            return f'deepseek tool shim unavailable ({LOAD_ERROR}); refusing {data.get("model")}'
        logging_obj = data.get('litellm_logging_obj')
        if logging_obj is None:
            return f'deepseek tool shim: no per-request state for {data.get("model")}; refusing'
        setattr(logging_obj, MAP_ATTRIBUTE, core.flatten_request(data))
        return data

    async def async_post_call_success_hook(self, data, user_api_key_dict, response):
        if core is not None and applies_to(data):
            core.restore_calls(response, _request_map(data))
        return response

    async def async_post_call_streaming_iterator_hook(self, user_api_key_dict, response, request_data):
        mapping = _request_map(request_data) if core is not None and applies_to(request_data) else None
        async for chunk in response:
            yield core.restore_calls(chunk, mapping) if mapping else chunk


proxy_handler_instance = DeepseekToolShim()
