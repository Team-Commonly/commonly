"""Unit suite for k8s/helm/commonly/files/stranger-journey.py (F375).

Run by strangerJourney.test.js: python3 -I stranger_journey_test.py <script>.
No network: `call` is replaced with a recorder that answers each route.
"""
import importlib.util
import os
import sys
import unittest

SCRIPT = sys.argv.pop(1)


def load(invite='', sink=False):
    os.environ['JOURNEY_INVITE_CODE'] = invite
    os.environ['JOURNEY_EMAIL_SINK_URL'] = 'http://email-sink.test' if sink else ''
    os.environ['JOURNEY_EMAIL_SINK_TOKEN'] = 'sink-token' if sink else ''
    spec = importlib.util.spec_from_file_location('journey', SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.emit = lambda **fields: None
    return module


class Recorder:
    def __init__(self, account_status=204):
        self.calls = []
        self.account_status = account_status

    def __call__(self, method, path, body=None, token=None):
        self.calls.append((method, path, body, token))
        if path == '/api/auth/register':
            return 201, {}
        if path == '/api/auth/login':
            return 200, {'token': 'jwt'}
        if path == '/api/users/me':
            return self.account_status, None
        return 200, {}

    def bodies(self, path):
        return [body for _, p, body, _ in self.calls if p == path]


class Signup(unittest.TestCase):
    def test_sends_the_invite_code_when_one_is_set(self):
        journey = load('CODE-1')
        rec = journey.call = Recorder()
        journey.Journey().signup()
        self.assertEqual(rec.bodies('/api/auth/register')[0]['invitationCode'], 'CODE-1')

    def test_sends_no_code_field_when_none_is_set(self):
        journey = load('')
        rec = journey.call = Recorder()
        journey.Journey().signup()
        self.assertNotIn('invitationCode', rec.bodies('/api/auth/register')[0])


class VerifyThroughTheSink(unittest.TestCase):
    def test_follows_this_accounts_verification_link_before_login(self):
        journey = load('', sink=True)
        rec = journey.call = Recorder()
        asked = []

        def links(email):
            asked.append(email)
            return ['https://staging.example/help',
                    'https://staging.example/verify-email?token=tok-123']
        journey.sink_links = links
        j = journey.Journey()
        detail = j.signup()
        self.assertEqual(asked[0], j.email)
        paths = [p for _, p, _, _ in rec.calls]
        self.assertIn('/api/auth/verify-email?token=tok-123', paths)
        self.assertLess(paths.index('/api/auth/verify-email?token=tok-123'), paths.index('/api/auth/login'))
        self.assertTrue(detail['verified'])

    def test_no_mail_in_the_sink_fails_signup(self):
        journey = load('', sink=True)
        journey.call = Recorder()
        journey.sink_links = lambda email: []
        journey.VERIFY_WAIT_S = 0
        with self.assertRaises(journey.StepFailed):
            journey.Journey().signup()

    def test_without_a_sink_there_is_no_verify_call(self):
        journey = load('')
        rec = journey.call = Recorder()
        journey.Journey().signup()
        self.assertFalse([p for _, p, _, _ in rec.calls if 'verify-email' in p])


class Cleanup(unittest.TestCase):
    def run_main(self, account_status, fail_step=None):
        journey = load('')
        rec = journey.call = Recorder(account_status)
        pod = 'p' * 24

        def make_step(name):
            def step(self):
                if name == 'signup':
                    self.token = 'jwt'
                    self.pod = pod
                if name == fail_step:
                    raise journey.StepFailed('boom')
            return step

        for name in ('signup', 'workspace', 'welcome', 'answer', 'card_step', 'approve', 'byo'):
            setattr(journey.Journey, name, make_step(name))
        return journey.main(), rec

    def test_deletes_the_account_with_its_password_and_the_confirmation(self):
        code, rec = self.run_main(204)
        self.assertEqual(code, 0)
        [body] = rec.bodies('/api/users/me')
        self.assertEqual(body['confirmation'], 'DELETE')
        self.assertTrue(body['password'])
        self.assertIn(('DELETE', '/api/users/me'), [(m, p) for m, p, _, _ in rec.calls])

    def test_a_surviving_account_fails_a_run_whose_steps_passed(self):
        code, _ = self.run_main(503)
        self.assertEqual(code, 1)

    def test_a_failed_step_still_deletes_the_account(self):
        code, rec = self.run_main(204, fail_step='welcome')
        self.assertEqual(code, 1)
        self.assertEqual(len(rec.bodies('/api/users/me')), 1)

    def test_a_cleanup_that_raises_still_prints_a_failing_verdict(self):
        journey = load('')
        verdicts = []
        journey.emit = lambda **fields: verdicts.append(fields)
        journey.call = Recorder()

        def boom(self):
            raise OSError('network')
        for name in ('signup', 'workspace', 'welcome', 'answer', 'card_step', 'approve', 'byo'):
            setattr(journey.Journey, name, lambda self: None)
        journey.Journey.cleanup = boom
        self.assertEqual(journey.main(), 1)
        self.assertEqual(verdicts[-1]['result'], 'fail')

    def test_no_login_means_no_delete_attempt(self):
        journey = load('')
        rec = journey.call = Recorder()
        self.assertTrue(journey.Journey().cleanup())
        self.assertEqual(rec.calls, [])


if __name__ == '__main__':
    unittest.main()
