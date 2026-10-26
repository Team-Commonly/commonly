"""LiteLLM callback: one JSON log line for every model fallback (TASK-003).

When a model group fails, the router answers from its `router_settings.fallbacks`
chain, and the caller gets that answer with nothing to say another model wrote
it. Native hosted turns refuse fallbacks (`disable_fallbacks`, D81), but every
other caller, the moltbot gateway included, takes them silently.

Every fallback passes through here: the router calls log_success_fallback_event
or log_failure_fallback_event on each CustomLogger in `litellm_settings.callbacks`
(litellm/router_utils/fallback_event_handlers.py, v1.106.2). Each event prints
one line to stdout, and GKE parses it into jsonPayload:

  {"alarm": "model_fallback", "outcome": "served" | "failed",
   "requested": <original model group>, "fallback": <group tried instead>,
   "attempt": <fallback depth>, "reason": <why the requested group failed>,
   "keyAlias": <LiteLLM key alias>}

The log-based metric `model_fallback` (k8s/monitoring/log-metrics.json) counts
these lines.

It logs no request content: only model group names, the depth, the error's class,
its status and a truncated message, and the key alias. It never raises, so a
malformed event can't cost a caller its answer.
"""
import json

try:
    from litellm.integrations.custom_logger import CustomLogger
except Exception:  # LiteLLM itself is broken; stay importable.
    CustomLogger = object

REASON_MAX = 300


def _metadata(kwargs):
    # The router stamps the hop under whichever name the endpoint uses.
    for name in ('metadata', 'litellm_metadata'):
        value = kwargs.get(name)
        if isinstance(value, dict) and ('original_model_group' in value or 'model_group' in value):
            return value
    return {}


def _reason(error):
    if error is None:
        return None
    text = ' '.join(str(error).split())[:REASON_MAX]
    status = getattr(error, 'status_code', None)
    label = type(error).__name__ if status is None else f'{type(error).__name__} {status}'
    return f'{label}: {text}' if text else label


def fallback_line(outcome, original_model_group, kwargs, original_exception):
    kwargs = kwargs if isinstance(kwargs, dict) else {}
    meta = _metadata(kwargs)
    fallback = kwargs.get('model')
    if not isinstance(fallback, str):
        fallback = meta.get('model_group')
    return {
        'alarm': 'model_fallback',
        'outcome': outcome,
        'requested': original_model_group or meta.get('original_model_group'),
        'fallback': fallback,
        'attempt': meta.get('attempted_fallbacks'),
        'reason': _reason(original_exception),
        'keyAlias': meta.get('user_api_key_alias'),
    }


def emit(outcome, original_model_group, kwargs, original_exception):
    try:
        line = json.dumps(fallback_line(outcome, original_model_group, kwargs, original_exception), default=str)
    except Exception as error:
        line = json.dumps({'alarm': 'model_fallback', 'outcome': outcome, 'signalError': type(error).__name__})
    print(line, flush=True)


class ModelFallbackSignal(CustomLogger):
    async def log_success_fallback_event(self, original_model_group, kwargs, original_exception):
        emit('served', original_model_group, kwargs, original_exception)

    async def log_failure_fallback_event(self, original_model_group, kwargs, original_exception):
        emit('failed', original_model_group, kwargs, original_exception)


proxy_handler_instance = ModelFallbackSignal()
