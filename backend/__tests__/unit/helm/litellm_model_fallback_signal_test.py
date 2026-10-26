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


def hop_kwargs(metadata_name='metadata'):
    return {
        'model': DEEPSEEK,
        'messages': [{'role': 'user', 'content': 'private prompt text'}],
        metadata_name: {
            'original_model_group': NEMOTRON,
            'model_group': DEEPSEEK,
            'attempted_fallbacks': 1,
            'user_api_key_alias': 'community-agent-key',
            'user_api_key_hash': 'hash-should-not-appear',
        },
    }


def captured_lines(hook, *args):
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        asyncio.run(hook(*args))
    return [json.loads(line) for line in out.getvalue().splitlines() if line.strip()]


class FallbackLine(unittest.TestCase):
    def test_a_served_fallback_names_both_groups_and_the_reason(self):
        error = NotFoundError('OpenrouterException - No endpoints found for nvidia/nemotron-3-super-120b-a12b:free.')
        lines = captured_lines(signal.proxy_handler_instance.log_success_fallback_event, NEMOTRON, hop_kwargs(), error)
        self.assertEqual(lines, [{
            'alarm': 'model_fallback',
            'outcome': 'served',
            'requested': NEMOTRON,
            'fallback': DEEPSEEK,
            'attempt': 1,
            'reason': 'NotFoundError 404: OpenrouterException - No endpoints found for nvidia/nemotron-3-super-120b-a12b:free.',
            'keyAlias': 'community-agent-key',
        }])

    def test_a_failed_fallback_is_reported_with_its_outcome(self):
        lines = captured_lines(signal.proxy_handler_instance.log_failure_fallback_event, NEMOTRON, hop_kwargs(), NotFoundError('gone'))
        self.assertEqual(len(lines), 1)
        self.assertEqual(lines[0]['outcome'], 'failed')
        self.assertEqual((lines[0]['requested'], lines[0]['fallback']), (NEMOTRON, DEEPSEEK))

    def test_the_litellm_metadata_name_is_read_too(self):
        line = signal.fallback_line('served', NEMOTRON, hop_kwargs('litellm_metadata'), None)
        self.assertEqual((line['attempt'], line['keyAlias'], line['reason']), (1, 'community-agent-key', None))

    def test_no_request_content_or_key_hash_is_logged(self):
        out = json.dumps(signal.fallback_line('served', NEMOTRON, hop_kwargs(), NotFoundError('x')))
        self.assertNotIn('private prompt text', out)
        self.assertNotIn('hash-should-not-appear', out)

    def test_the_reason_is_one_line_and_bounded(self):
        line = signal.fallback_line('served', NEMOTRON, hop_kwargs(), RuntimeError('a\n' + 'b' * 1000))
        self.assertNotIn('\n', line['reason'])
        self.assertLessEqual(len(line['reason']), len('RuntimeError: ') + signal.REASON_MAX)

    def test_a_dict_fallback_target_falls_back_to_the_metadata_group(self):
        kwargs = hop_kwargs()
        kwargs['model'] = {'model': DEEPSEEK}
        self.assertEqual(signal.fallback_line('served', NEMOTRON, kwargs, None)['fallback'], DEEPSEEK)

    def test_malformed_events_still_print_one_line_and_never_raise(self):
        class Unprintable:
            def __str__(self):
                raise ValueError('no str')
        for args in ((None, None, None), (NEMOTRON, {'model': DEEPSEEK}, Unprintable())):
            lines = captured_lines(signal.proxy_handler_instance.log_success_fallback_event, *args)
            self.assertEqual(len(lines), 1)
            self.assertEqual(lines[0]['alarm'], 'model_fallback')


if __name__ == '__main__':
    unittest.main(verbosity=2)
