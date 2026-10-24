"""Unit tests for k8s/helm/commonly/files/litellm/deepseek_tool_shim.py.

Run by litellmDeepseekToolShim.test.js as `python3 -I <this file> <shim path>`.
LiteLLM is not installed in CI, so a stub CustomLogger stands in for the one
module the shim imports.
"""
import asyncio
import copy
import importlib.util
import sys
import types
import unittest

stub = types.ModuleType('litellm.integrations.custom_logger')
stub.CustomLogger = type('CustomLogger', (), {})
for name in ('litellm', 'litellm.integrations'):
    sys.modules.setdefault(name, types.ModuleType(name))
sys.modules['litellm.integrations.custom_logger'] = stub

spec = importlib.util.spec_from_file_location('deepseek_tool_shim', sys.argv.pop(1))
shim = importlib.util.module_from_spec(spec)
spec.loader.exec_module(shim)


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


class FlattenRequest(unittest.TestCase):
    def test_namespaces_become_function_tools_and_hosted_tools_are_dropped(self):
        data = shim.flatten_request(codex_request())
        self.assertEqual({t['type'] for t in data['tools']}, {'function'})
        self.assertEqual([t['name'] for t in data['tools']], [
            'exec_command',
            'multi_agent_v1__close_agent', 'multi_agent_v1__spawn_agent',
            'mcp__commonly__commonly_list_pods', 'mcp__commonly__commonly_post_message',
        ])
        self.assertNotIn('web_search', str(data['tools']))

    def test_inner_tool_keeps_its_schema(self):
        data = shim.flatten_request(codex_request())
        tool = next(t for t in data['tools'] if t['name'] == 'mcp__commonly__commonly_list_pods')
        self.assertEqual(tool['parameters'], {'type': 'object', 'properties': {}})
        self.assertEqual(tool['description'], 'commonly_list_pods')

    def test_history_calls_name_the_flattened_tool(self):
        data = codex_request()
        data['input'].append({'type': 'function_call', 'call_id': 'c1', 'name': 'commonly_list_pods',
                              'namespace': 'mcp__commonly', 'arguments': '{}'})
        shim.flatten_request(data)
        call = data['input'][-1]
        self.assertEqual(call['name'], 'mcp__commonly__commonly_list_pods')
        self.assertNotIn('namespace', call)

    def test_a_tool_choice_naming_a_non_function_tool_falls_back_to_auto(self):
        data = codex_request()
        data['tool_choice'] = {'type': 'web_search'}
        self.assertEqual(shim.flatten_request(data)['tool_choice'], 'auto')

    def test_long_names_fit_deepseeks_limit_and_still_round_trip(self):
        data = codex_request()
        data['tools'] = [{'type': 'namespace', 'name': 'mcp__' + 'x' * 40, 'tools': [fn('y' * 40)]}]
        flat = shim.flatten_request(data)['tools'][0]['name']
        self.assertLessEqual(len(flat), shim.MAX_NAME_LENGTH)
        out = shim.restore_calls({'type': 'function_call', 'name': flat})
        self.assertEqual((out['namespace'], out['name']), ('mcp__' + 'x' * 40, 'y' * 40))


class RestoreCalls(unittest.TestCase):
    def setUp(self):
        shim.flatten_request(codex_request())

    def test_a_non_streamed_response_gets_name_and_namespace_back(self):
        response = {'output': [{'type': 'function_call', 'call_id': 'c1',
                                'name': 'mcp__commonly__commonly_list_pods', 'arguments': '{}'}]}
        call = shim.restore_calls(response)['output'][0]
        self.assertEqual((call['name'], call['namespace']), ('commonly_list_pods', 'mcp__commonly'))

    def test_nested_stream_events_are_restored(self):
        added = Event(type='response.output_item.added',
                      item=Event(type='function_call', name='multi_agent_v1__spawn_agent'))
        completed = Event(type='response.completed', response=Event(output=[
            Event(type='function_call', name='mcp__commonly__commonly_post_message')]))
        shim.restore_calls(added)
        shim.restore_calls(completed)
        self.assertEqual((added.item.name, added.item.namespace), ('spawn_agent', 'multi_agent_v1'))
        call = completed.response.output[0]
        self.assertEqual((call.name, call.namespace), ('commonly_post_message', 'mcp__commonly'))

    def test_unshimmed_names_are_left_alone(self):
        response = {'output': [{'type': 'function_call', 'name': 'exec_command'},
                               {'type': 'message', 'name': 'mcp__commonly__commonly_list_pods'}]}
        out = shim.restore_calls(copy.deepcopy(response))
        self.assertEqual(out, response)


class OtherModelGroups(unittest.TestCase):
    def test_request_for_another_group_is_untouched(self):
        data = codex_request(model='gpt-6.1-sol')
        data['input'].append({'type': 'function_call', 'name': 'commonly_list_pods', 'namespace': 'mcp__commonly'})
        before = copy.deepcopy(data)
        self.assertEqual(shim.flatten_request(data), before)

    def test_hooks_do_not_rewrite_another_groups_responses(self):
        shim.flatten_request(codex_request())
        handler = shim.proxy_handler_instance
        other = codex_request(model='gpt-6.1-sol')
        response = {'output': [{'type': 'function_call', 'name': 'mcp__commonly__commonly_list_pods'}]}
        before = copy.deepcopy(response)

        async def run():
            await handler.async_post_call_success_hook(other, None, response)
            async def stream():
                yield copy.deepcopy(before)
            return [c async for c in handler.async_post_call_streaming_iterator_hook(None, stream(), other)]

        chunks = asyncio.run(run())
        self.assertEqual(response, before)
        self.assertEqual(chunks, [before])


class Hooks(unittest.TestCase):
    def test_pre_call_hook_flattens_and_stream_hook_restores(self):
        handler = shim.proxy_handler_instance
        data = codex_request()

        async def run():
            flattened = await handler.async_pre_call_hook(None, None, data, 'aresponses')
            async def stream():
                yield Event(type='response.output_item.done',
                            item=Event(type='function_call', name='mcp__commonly__commonly_list_pods'))
            chunks = [c async for c in handler.async_post_call_streaming_iterator_hook(None, stream(), flattened)]
            return flattened, chunks

        flattened, chunks = asyncio.run(run())
        self.assertEqual({t['type'] for t in flattened['tools']}, {'function'})
        self.assertEqual((chunks[0].item.name, chunks[0].item.namespace), ('commonly_list_pods', 'mcp__commonly'))


if __name__ == '__main__':
    unittest.main(verbosity=2)
