"""Unit tests for k8s/helm/commonly/files/litellm/deepseek_tool_shim.py and its
core, deepseek_tool_shim_core.py.

Run by litellmDeepseekToolShim.test.js as `python3 -I <this file> <shim path>`.
LiteLLM is not installed in CI, so a stub CustomLogger stands in for the one
module the shim imports.
"""
import asyncio
import copy
import importlib.util
import os
import shutil
import sys
import tempfile
import types
import unittest

sys.dont_write_bytecode = True

stub = types.ModuleType('litellm.integrations.custom_logger')
stub.CustomLogger = type('CustomLogger', (), {})
for name in ('litellm', 'litellm.integrations'):
    sys.modules.setdefault(name, types.ModuleType(name))
sys.modules['litellm.integrations.custom_logger'] = stub

SHIM_PATH = sys.argv.pop(1)


def load(path, name='deepseek_tool_shim'):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


shim = load(SHIM_PATH)
core = shim.core


def fn(name):
    return {'type': 'function', 'name': name, 'description': name, 'strict': False,
            'parameters': {'type': 'object', 'properties': {}}}


def codex_request(model='deepseek-flash-1017'):
    # The tool shapes codex 0.162.1 sends (captured 2026-10-24), trimmed.
    return {
        'model': model,
        'stream': True,
        'input': [{'type': 'message', 'role': 'user', 'content': [{'type': 'input_text', 'text': 'hi'}]}],
        'tools': [
            fn('exec_command'),
            {'type': 'namespace', 'name': 'multi_agent_v1', 'description': 'sub-agents',
             'tools': [fn('close_agent'), fn('spawn_agent')]},
            {'type': 'namespace', 'name': 'mcp__commonly', 'description': 'commonly',
             'tools': [fn('commonly_list_pods'), fn('commonly_post_message')]},
            {'type': 'web_search', 'external_web_access': False},
        ],
        'tool_choice': 'auto',
    }


class Event:
    """Stands in for LiteLLM's pydantic stream events."""

    def __init__(self, **fields):
        self.__dict__.update(fields)


class LoggingObj:
    """Stands in for the per-call Logging object LiteLLM puts on the request."""


def proxied(data):
    """A request as the proxy hands it to hooks: with its own logging object."""
    data['litellm_logging_obj'] = LoggingObj()
    return data


def call(name):
    return {'type': 'function_call', 'call_id': 'c1', 'name': name, 'arguments': '{}'}


def through_hooks(handler, data, events):
    """Run one request through the pre-call hook and a stream of events."""
    async def run():
        result = await handler.async_pre_call_hook(None, None, data, 'aresponses')
        if isinstance(result, str):
            return result, None

        async def stream():
            for event in events:
                yield event
        chunks = [c async for c in handler.async_post_call_streaming_iterator_hook(None, stream(), result)]
        return result, chunks
    return asyncio.run(run())


class FlattenRequest(unittest.TestCase):
    def test_namespaces_become_function_tools_and_hosted_tools_are_dropped(self):
        data = codex_request()
        core.flatten_request(data)
        self.assertEqual({t['type'] for t in data['tools']}, {'function'})
        self.assertEqual([t['name'] for t in data['tools']], [
            'exec_command',
            'multi_agent_v1__close_agent', 'multi_agent_v1__spawn_agent',
            'mcp__commonly__commonly_list_pods', 'mcp__commonly__commonly_post_message',
        ])
        self.assertNotIn('web_search', str(data['tools']))

    def test_inner_tool_keeps_its_schema(self):
        data = codex_request()
        core.flatten_request(data)
        tool = next(t for t in data['tools'] if t['name'] == 'mcp__commonly__commonly_list_pods')
        self.assertEqual(tool['parameters'], {'type': 'object', 'properties': {}})
        self.assertEqual(tool['description'], 'commonly_list_pods')

    def test_history_calls_name_the_flattened_tool(self):
        data = codex_request()
        data['input'].append({**call('commonly_list_pods'), 'namespace': 'mcp__commonly'})
        core.flatten_request(data)
        self.assertEqual(data['input'][-1]['name'], 'mcp__commonly__commonly_list_pods')
        self.assertNotIn('namespace', data['input'][-1])

    def test_a_tool_choice_naming_a_non_function_tool_falls_back_to_auto(self):
        data = codex_request()
        data['tool_choice'] = {'type': 'web_search'}
        core.flatten_request(data)
        self.assertEqual(data['tool_choice'], 'auto')

    def test_long_names_fit_deepseeks_limit_and_still_round_trip(self):
        data = codex_request()
        data['tools'] = [{'type': 'namespace', 'name': 'mcp__' + 'x' * 40, 'tools': [fn('y' * 40)]}]
        mapping = core.flatten_request(data)
        flat = data['tools'][0]['name']
        self.assertLessEqual(len(flat), core.MAX_NAME_LENGTH)
        out = core.restore_calls(call(flat), mapping)
        self.assertEqual((out['namespace'], out['name']), ('mcp__' + 'x' * 40, 'y' * 40))


class UniqueNames(unittest.TestCase):
    """Counterexample 2 (#2615 review)."""

    def test_namespace_and_name_splits_that_join_alike_get_distinct_names(self):
        data = codex_request()
        data['tools'] = [{'type': 'namespace', 'name': 'a__b', 'tools': [fn('c')]},
                         {'type': 'namespace', 'name': 'a', 'tools': [fn('b__c')]}]
        mapping = core.flatten_request(data)
        names = [t['name'] for t in data['tools']]
        self.assertEqual(len(set(names)), 2)
        for flat, pair in zip(names, [('a__b', 'c'), ('a', 'b__c')]):
            out = core.restore_calls(call(flat), mapping)
            self.assertEqual((out['namespace'], out['name']), pair)

    def test_a_flat_name_never_takes_a_plain_functions_name(self):
        data = codex_request()
        data['tools'] = [fn('mcp__commonly__commonly_list_pods'),
                         {'type': 'namespace', 'name': 'mcp__commonly', 'tools': [fn('commonly_list_pods')]}]
        mapping = core.flatten_request(data)
        plain, flat = (t['name'] for t in data['tools'])
        self.assertEqual(plain, 'mcp__commonly__commonly_list_pods')
        self.assertNotEqual(flat, plain)
        self.assertEqual(core.restore_calls(call(plain), mapping), call(plain))
        out = core.restore_calls(call(flat), mapping)
        self.assertEqual((out['namespace'], out['name']), ('mcp__commonly', 'commonly_list_pods'))

    def test_a_history_call_reuses_its_tools_flat_name(self):
        data = codex_request()
        data['tools'] = [{'type': 'namespace', 'name': 'a__b', 'tools': [fn('c')]},
                         {'type': 'namespace', 'name': 'a', 'tools': [fn('b__c')]}]
        data['input'].append({**call('b__c'), 'namespace': 'a'})
        core.flatten_request(data)
        self.assertEqual(data['input'][-1]['name'], data['tools'][1]['name'])


class RestoreCalls(unittest.TestCase):
    def setUp(self):
        self.mapping = core.flatten_request(codex_request())

    def test_a_non_streamed_response_gets_name_and_namespace_back(self):
        response = {'output': [call('mcp__commonly__commonly_list_pods')]}
        out = core.restore_calls(response, self.mapping)['output'][0]
        self.assertEqual((out['name'], out['namespace']), ('commonly_list_pods', 'mcp__commonly'))

    def test_nested_stream_events_are_restored(self):
        added = Event(type='response.output_item.added',
                      item=Event(type='function_call', name='multi_agent_v1__spawn_agent'))
        completed = Event(type='response.completed', response=Event(output=[
            Event(type='function_call', name='mcp__commonly__commonly_post_message')]))
        core.restore_calls(added, self.mapping)
        core.restore_calls(completed, self.mapping)
        self.assertEqual((added.item.name, added.item.namespace), ('spawn_agent', 'multi_agent_v1'))
        out = completed.response.output[0]
        self.assertEqual((out.name, out.namespace), ('commonly_post_message', 'mcp__commonly'))

    def test_unshimmed_names_are_left_alone(self):
        response = {'output': [call('exec_command'),
                               {'type': 'message', 'name': 'mcp__commonly__commonly_list_pods'}]}
        self.assertEqual(core.restore_calls(copy.deepcopy(response), self.mapping), response)


class PerRequestState(unittest.TestCase):
    """Counterexample 3: one request's names never reach another's."""

    def test_a_later_plain_function_is_not_mistaken_for_an_earlier_flat_name(self):
        handler = shim.proxy_handler_instance
        through_hooks(handler, proxied(codex_request()), [])
        later = proxied(codex_request())
        later['tools'] = [fn('mcp__commonly__commonly_list_pods')]
        event = Event(type='response.output_item.done',
                      item=Event(type='function_call', name='mcp__commonly__commonly_list_pods'))
        _, chunks = through_hooks(handler, later, [event])
        self.assertEqual(chunks[0].item.name, 'mcp__commonly__commonly_list_pods')
        self.assertFalse(hasattr(chunks[0].item, 'namespace'))

    def test_interleaved_requests_each_restore_with_their_own_names(self):
        handler = shim.proxy_handler_instance
        first, second = proxied(codex_request()), proxied(codex_request())
        first['tools'] = [{'type': 'namespace', 'name': 'a__b', 'tools': [fn('c')]}]
        second['tools'] = [{'type': 'namespace', 'name': 'a', 'tools': [fn('b__c')]}]

        async def run():
            one = await handler.async_pre_call_hook(None, None, first, 'aresponses')
            two = await handler.async_pre_call_hook(None, None, second, 'aresponses')

            async def stream(flat):
                yield Event(type='response.output_item.done', item=Event(type='function_call', name=flat))
            outs = []
            for data in (two, one):
                flat = data['tools'][0]['name']
                outs += [c async for c in handler.async_post_call_streaming_iterator_hook(None, stream(flat), data)]
            return outs

        out_two, out_one = asyncio.run(run())
        self.assertEqual((out_two.item.namespace, out_two.item.name), ('a', 'b__c'))
        self.assertEqual((out_one.item.namespace, out_one.item.name), ('a__b', 'c'))

    def test_a_request_without_a_logging_object_is_refused(self):
        result, _ = through_hooks(shim.proxy_handler_instance, codex_request(), [])
        self.assertIsInstance(result, str)


class OtherModelGroups(unittest.TestCase):
    def test_hooks_leave_another_groups_request_and_responses_byte_for_byte(self):
        handler = shim.proxy_handler_instance
        through_hooks(handler, proxied(codex_request()), [])
        other = codex_request(model='gpt-6.1-sol')
        other['input'].append({**call('commonly_list_pods'), 'namespace': 'mcp__commonly'})
        request_before = copy.deepcopy(other)
        response = {'output': [call('mcp__commonly__commonly_list_pods')]}
        response_before = copy.deepcopy(response)

        async def run():
            returned = await handler.async_pre_call_hook(None, None, other, 'aresponses')
            await handler.async_post_call_success_hook(other, None, response)

            async def stream():
                yield copy.deepcopy(response_before)
            return returned, [c async for c in handler.async_post_call_streaming_iterator_hook(None, stream(), other)]

        returned, chunks = asyncio.run(run())
        self.assertIs(returned, other)
        self.assertEqual(other, request_before)
        self.assertEqual(response, response_before)
        self.assertEqual(chunks, [response_before])


class Hooks(unittest.TestCase):
    def test_pre_call_hook_flattens_and_stream_hook_restores(self):
        event = Event(type='response.output_item.done',
                      item=Event(type='function_call', name='mcp__commonly__commonly_list_pods'))
        flattened, chunks = through_hooks(shim.proxy_handler_instance, proxied(codex_request()), [event])
        self.assertEqual({t['type'] for t in flattened['tools']}, {'function'})
        self.assertEqual((chunks[0].item.name, chunks[0].item.namespace), ('commonly_list_pods', 'mcp__commonly'))


class CoreLoadFailure(unittest.TestCase):
    """Counterexample 1: a broken core must not stop the proxy."""

    def load_with_core(self, source):
        directory = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, directory)
        entry = os.path.join(directory, 'deepseek_tool_shim.py')
        shutil.copy(SHIM_PATH, entry)
        if source is not None:
            with open(os.path.join(directory, 'deepseek_tool_shim_core.py'), 'w') as f:
                f.write(source)
        return load(entry, 'deepseek_tool_shim_broken')

    def assert_contained(self, module):
        self.assertIsNone(module.core)
        self.assertTrue(module.LOAD_ERROR)
        handler = module.proxy_handler_instance
        other = proxied(codex_request(model='gpt-6.1-sol'))
        before = copy.deepcopy(other['tools'])
        returned, chunks = through_hooks(handler, other, [{'type': 'response.created'}])
        self.assertIs(returned, other)
        self.assertEqual(other['tools'], before)
        self.assertEqual(chunks, [{'type': 'response.created'}])
        refused, _ = through_hooks(handler, proxied(codex_request()), [])
        self.assertIsInstance(refused, str)
        self.assertIn(module.LOAD_ERROR.split(':')[0], refused)

    def test_a_core_raising_at_import_is_contained(self):
        self.assert_contained(self.load_with_core('raise RuntimeError("boom")\n'))

    def test_a_core_with_a_syntax_error_is_contained(self):
        self.assert_contained(self.load_with_core('def broken(:\n'))

    def test_a_missing_core_is_contained(self):
        self.assert_contained(self.load_with_core(None))


if __name__ == '__main__':
    unittest.main(verbosity=2)
