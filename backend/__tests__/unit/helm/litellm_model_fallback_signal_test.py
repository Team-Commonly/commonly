"""Unit tests for k8s/helm/commonly/files/litellm/model_fallback_signal.py.

Run by litellmModelFallbackSignal.test.js as `python3 -I <this file> <signal path>`.
LiteLLM is not installed in CI, so a stub CustomLogger stands in for the one
module the signal imports. The kwargs mirror what the v1.106.2 router passes at
the fallback hop (router_utils/fallback_event_handlers.py): `model` is the group
tried instead, and the metadata carries original_model_group, model_group and
attempted_fallbacks.
"""
import asyncio
import contextlib
import dataclasses
import importlib.util
import io
import json
import sys
import types
import unittest

sys.dont_write_bytecode = True

stub = types.ModuleType('litellm.integrations.custom_logger')
stub.CustomLogger = type('CustomLogger', (), {})
for name in ('litellm', 'litellm.integrations'):
    sys.modules.setdefault(name, types.ModuleType(name))
sys.modules['litellm.integrations.custom_logger'] = stub

SIGNAL_PATH = sys.argv.pop(1)
spec = importlib.util.spec_from_file_location('model_fallback_signal', SIGNAL_PATH)
signal = importlib.util.module_from_spec(spec)
spec.loader.exec_module(signal)

NEMOTRON = 'openrouter/nvidia/nemotron-3-super-120b-a12b:free'
DEEPSEEK = 'deepseek-v4-flash'


class NotFoundError(Exception):
    status_code = 404


@dataclasses.dataclass(slots=True)
class Attempts:
    """Stands in for AttemptedFallbackTargets, the object a request shares across
    hops. Shaped like v1.106.2's: a slots dataclass, so unhashable and not
    weak-referenceable, which a plain stub would hide."""
    keys: frozenset = frozenset()


GPT = 'gpt-5.4'


def router_function(name):
    def function():
        pass
    function.__name__ = name
    return function


# The v1.106.2 router function behind each bucket: a chat completion stamps
# `metadata`, and /v1/messages takes the generic path, which stamps
# `litellm_metadata`.
CHAT = router_function('_acompletion')
MESSAGES = router_function('_ageneric_api_call_with_fallbacks_anthropic_messages_attempt')


def hop_kwargs(metadata_name='metadata', attempts=None, requested=NEMOTRON, fallback=DEEPSEEK, depth=1):
    return {
        'model': fallback,
        'original_function': MESSAGES if metadata_name == 'litellm_metadata' else CHAT,
        'messages': [{'role': 'user', 'content': 'private prompt text'}],
        'attempted_targets': attempts if attempts is not None else Attempts(),
        metadata_name: {
            'original_model_group': requested,
            'model_group': fallback,
            'attempted_fallbacks': depth,
            'user_api_key_alias': 'community-agent-key',
            'user_api_key_hash': 'hash-should-not-appear',
        },
    }


def captured_lines(hook, *args):
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        asyncio.run(hook(*args))
    return [json.loads(line) for line in out.getvalue().splitlines() if line.strip()]


served = signal.proxy_handler_instance.log_success_fallback_event
failed = signal.proxy_handler_instance.log_failure_fallback_event


class FallbackLine(unittest.TestCase):
    def test_a_served_fallback_names_both_groups_and_the_reason(self):
        error = NotFoundError('OpenrouterException - No endpoints found for nvidia/nemotron-3-super-120b-a12b:free.')
        self.assertEqual(captured_lines(served, NEMOTRON, hop_kwargs(), error), [{
            'alarm': 'model_fallback',
            'outcome': 'served',
            'requested': NEMOTRON,
            'from': NEMOTRON,
            'fallback': DEEPSEEK,
            'attempt': 1,
            'reason': 'NotFoundError 404',
        }])

    def test_a_failed_fallback_is_reported_with_its_outcome(self):
        lines = captured_lines(failed, NEMOTRON, hop_kwargs(), NotFoundError('gone'))
        self.assertEqual(len(lines), 1)
        self.assertEqual(lines[0]['outcome'], 'failed')
        self.assertEqual((lines[0]['requested'], lines[0]['fallback']), (NEMOTRON, DEEPSEEK))

    def test_in_a_two_hop_chain_only_the_hop_that_answered_is_served(self):
        # gpt-5.4 -> nemotron -> deepseek, as the chart chains them. The router
        # runs the inner hop inside the outer one, so the inner hop logs first.
        attempts = Attempts()
        inner = captured_lines(served, NEMOTRON, hop_kwargs(attempts=attempts, requested=GPT, depth=2), NotFoundError('x'))
        outer = captured_lines(served, GPT, hop_kwargs(attempts=attempts, requested=GPT, fallback=NEMOTRON), RuntimeError('x'))
        self.assertEqual([(l['outcome'], l['requested'], l['from'], l['fallback']) for l in inner + outer], [
            ('served', GPT, NEMOTRON, DEEPSEEK),
            ('passed', GPT, GPT, NEMOTRON),
        ])
        # Another request starts fresh.
        self.assertEqual(captured_lines(served, NEMOTRON, hop_kwargs(), None)[0]['outcome'], 'served')

    def test_requests_are_remembered_up_to_a_bound(self):
        first = Attempts()
        captured_lines(served, NEMOTRON, hop_kwargs(attempts=first), None)
        for _ in range(signal.ANSWERED_MAX):
            captured_lines(served, NEMOTRON, hop_kwargs(), None)
        self.assertEqual(len(signal._ANSWERED), signal.ANSWERED_MAX)
        self.assertNotIn(id(first), signal._ANSWERED)

    def test_a_hop_without_its_request_object_is_taken_at_its_word(self):
        kwargs = hop_kwargs()
        del kwargs['attempted_targets']
        for _ in range(2):
            self.assertEqual(captured_lines(served, NEMOTRON, kwargs, None)[0]['outcome'], 'served')

    def test_the_litellm_metadata_name_is_read_too(self):
        line = signal.fallback_line('served', NEMOTRON, hop_kwargs('litellm_metadata'), None)
        self.assertEqual((line['attempt'], line['requested'], line['reason']), (1, NEMOTRON, None))

    def test_a_callers_own_metadata_never_stands_in_for_the_routers(self):
        kwargs = hop_kwargs('litellm_metadata', requested=GPT)
        kwargs['metadata'] = {'original_model_group': 'caller text', 'model_group': 'caller text', 'attempted_fallbacks': 9}
        line = signal.fallback_line('served', NEMOTRON, kwargs, None)
        self.assertEqual((line['requested'], line['attempt']), (GPT, 1))
        self.assertNotIn('caller text', json.dumps(line))

    def test_a_chat_completion_reads_metadata_even_beside_a_litellm_metadata(self):
        # The router stamps a chat completion's hop into `metadata` and leaves a
        # litellm_metadata the request carried as it was.
        kwargs = hop_kwargs(requested=GPT, depth=2)
        kwargs['litellm_metadata'] = {'model_group': 'unstamped'}
        line = signal.fallback_line('served', NEMOTRON, kwargs, None)
        self.assertEqual((line['requested'], line['attempt']), (GPT, 2))
        self.assertNotIn('unstamped', json.dumps(line))

    def test_without_a_router_function_the_hop_is_read_from_metadata(self):
        kwargs = hop_kwargs(requested=GPT)
        del kwargs['original_function']
        self.assertEqual(signal.fallback_line('served', NEMOTRON, kwargs, None)['requested'], GPT)

    def test_no_request_content_key_or_alias_is_logged(self):
        out = json.dumps(signal.fallback_line('served', NEMOTRON, hop_kwargs(), NotFoundError('x')))
        for secret in ('private prompt text', 'hash-should-not-appear', 'community-agent-key'):
            self.assertNotIn(secret, out)

    def test_the_reason_never_carries_the_error_message(self):
        # A provider can echo the request into its error, prompt included.
        error = NotFoundError('400 invalid request: messages[0].content="private prompt text"')
        line = signal.fallback_line('served', NEMOTRON, hop_kwargs(), error)
        self.assertEqual(line['reason'], 'NotFoundError 404')
        self.assertEqual(signal.fallback_line('served', NEMOTRON, hop_kwargs(), RuntimeError('a\nb'))['reason'], 'RuntimeError')

    def test_a_dict_fallback_target_falls_back_to_the_metadata_group(self):
        kwargs = hop_kwargs()
        kwargs['model'] = {'model': DEEPSEEK}
        self.assertEqual(signal.fallback_line('served', NEMOTRON, kwargs, None)['fallback'], DEEPSEEK)

    def test_a_closed_stdout_does_not_raise_into_the_request(self):
        closed = io.StringIO()
        closed.close()
        with contextlib.redirect_stdout(closed):
            asyncio.run(served(NEMOTRON, hop_kwargs(), NotFoundError('x')))
            asyncio.run(failed(NEMOTRON, hop_kwargs(), NotFoundError('x')))

    def test_malformed_events_still_print_one_line_and_never_raise(self):
        class Unprintable:
            def __str__(self):
                raise ValueError('no str')
        for args in ((None, None, None), (NEMOTRON, {'model': DEEPSEEK, 'attempted_targets': []}, Unprintable())):
            lines = captured_lines(served, *args)
            self.assertEqual(len(lines), 1)
            self.assertEqual(lines[0]['alarm'], 'model_fallback')


if __name__ == '__main__':
    unittest.main(verbosity=2)
