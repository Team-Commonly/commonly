"""LiteLLM callback: one JSON log line for every model fallback hop (TASK-003).

When a model group fails, the router answers from its `router_settings.fallbacks`
chain, and the caller gets that answer with nothing to say another model wrote
it. Native hosted turns refuse fallbacks (`disable_fallbacks`, D81), but every
other caller, the moltbot gateway included, takes them silently.

Every fallback passes through here: the router calls log_success_fallback_event
or log_failure_fallback_event on each CustomLogger in `litellm_settings.callbacks`
(litellm/router_utils/fallback_event_handlers.py, v1.106.2). Each event prints
one line to stdout, and GKE parses it into jsonPayload:

  {"alarm": "model_fallback", "outcome": "served" | "passed" | "failed",
   "requested": <group the caller asked for>, "from": <group that failed at this hop>,
   "fallback": <group tried instead>, "attempt": <fallback depth>,
   "reason": <the failure's class and status>}

A chain can have two hops (gpt-5.4 -> nemotron -> deepseek-v4-flash). The router
runs the inner hop inside the outer one, so the hop whose fallback answered logs
first. `served` marks that hop. `passed` marks an outer hop of the same request,
whose fallback failed as well. `failed` means the fallback did not answer.

The log-based metric `model_fallback` (k8s/monitoring/log-metrics.json) counts
these lines.

It logs only model group names, the depth, and the error's class and status. It
never logs the error's message, because a provider can echo the request into it,
and never logs the key or its alias. It never raises, so a malformed event can't
cost a caller its answer.
"""
import json
from collections import OrderedDict

try:
    from litellm.integrations.custom_logger import CustomLogger
except Exception:  # LiteLLM itself is broken; stay importable.
    CustomLogger = object

try:
    from litellm.router_utils.batch_utils import get_router_metadata_variable_name
except Exception:  # Not importable here; mirror v1.106.2's rule (batch_utils.py:155).
    def get_router_metadata_variable_name(function_name):
        markers = ('batch', 'generic_api_call', '_acreate_batch', 'file', '_ageneric_api_call_with_fallbacks')
        if function_name and any(marker in function_name for marker in markers):
            return 'litellm_metadata'
        return 'metadata'

# The router shares one AttemptedFallbackTargets object across every hop of a
# request (kwargs['attempted_targets']). A request is in here once one of its
# hops has logged `served`. That object is a slots dataclass, neither hashable
# nor weak-referenceable, so it is held by identity, and the oldest entries go
# first. A request's hops log within one call, far inside the bound.
_ANSWERED = OrderedDict()
ANSWERED_MAX = 1024


def _metadata(kwargs):
    # The bucket the router stamped this hop into. run_async_fallback picks it by
    # the router function's name, not by which buckets the request carries
    # (fallback_event_handlers.py:717): litellm_metadata for batch, file and
    # generic API calls such as /v1/messages, metadata for the rest, chat
    # completions included. Choosing by contents could read a bucket the router
    # never stamped, the caller's own among them.
    function_name = getattr(kwargs.get('original_function'), '__name__', None)
    value = kwargs.get(get_router_metadata_variable_name(function_name))
    return value if isinstance(value, dict) else {}


def _reason(error):
    if error is None:
        return None
    status = getattr(error, 'status_code', None)
    return type(error).__name__ if status is None else f'{type(error).__name__} {status}'


def _first_answer(kwargs):
    """True for the first success hop of a request: the hop whose fallback answered."""
    attempts = kwargs.get('attempted_targets') if isinstance(kwargs, dict) else None
    if attempts is None:
        return True  # No per-request object to key on, so take the hop at its word.
    if _ANSWERED.get(id(attempts)) is attempts:
        return False
    _ANSWERED[id(attempts)] = attempts
    while len(_ANSWERED) > ANSWERED_MAX:
        _ANSWERED.popitem(last=False)
    return True


def fallback_line(outcome, original_model_group, kwargs, original_exception):
    kwargs = kwargs if isinstance(kwargs, dict) else {}
    meta = _metadata(kwargs)
    fallback = kwargs.get('model')
    if not isinstance(fallback, str):
        fallback = meta.get('model_group')
    return {
        'alarm': 'model_fallback',
        'outcome': outcome,
        'requested': meta.get('original_model_group') or original_model_group,
        'from': original_model_group,
        'fallback': fallback,
        'attempt': meta.get('attempted_fallbacks'),
        'reason': _reason(original_exception),
    }


def emit(outcome, original_model_group, kwargs, original_exception):
    try:
        line = json.dumps(fallback_line(outcome, original_model_group, kwargs, original_exception), default=str)
    except Exception as error:
        line = json.dumps({'alarm': 'model_fallback', 'outcome': outcome, 'signalError': type(error).__name__})
    try:
        print(line, flush=True)
    except Exception:
        pass  # No stdout to write to; the caller's answer comes first.


class ModelFallbackSignal(CustomLogger):
    async def log_success_fallback_event(self, original_model_group, kwargs, original_exception):
        try:
            outcome = 'served' if _first_answer(kwargs) else 'passed'
        except Exception:
            outcome = 'served'
        emit(outcome, original_model_group, kwargs, original_exception)

    async def log_failure_fallback_event(self, original_model_group, kwargs, original_exception):
        emit('failed', original_model_group, kwargs, original_exception)


proxy_handler_instance = ModelFallbackSignal()
