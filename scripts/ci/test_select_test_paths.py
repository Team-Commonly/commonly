import unittest

from select_test_paths import select


class SelectTestPathsTest(unittest.TestCase):
    def test_docs_only_selects_no_suite(self):
        self.assertEqual(select(["docs/README.md", "README.md"]), {
            "backend": False, "frontend": False, "tools": False, "chart": False,
        })

    def test_frontend_only_does_not_select_backend(self):
        self.assertEqual(select(["frontend/src/App.tsx"]), {
            "backend": False, "frontend": True, "tools": False, "chart": False,
        })

    def test_alerting_runbook_checks_chart_policy(self):
        self.assertEqual(select(["docs/runbooks/alerting.md"]), {
            "backend": False, "frontend": False, "tools": False, "chart": True,
        })

    def test_backend_change_also_checks_chart(self):
        self.assertEqual(select(["backend/src/server.ts"]), {
            "backend": True, "frontend": False, "tools": False, "chart": True,
        })

    def test_unknown_and_empty_diff_fail_open(self):
        for paths in ([], ["packages/types/src/index.ts"]):
            self.assertTrue(all(select(paths).values()))


if __name__ == "__main__":
    unittest.main()
