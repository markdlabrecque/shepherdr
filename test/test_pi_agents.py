"""Pi role selections reach the worker and reviewer launch commands."""
import home_guard  # noqa: F401
import os
import shlex
import sys
import unittest
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(__file__)), "mods", "tasks", "bin"))
from herdr_task import settings


class PiAgents(unittest.TestCase):
    def test_model_and_thinking_without_permission_or_speed_flags(self):
        pick = {"agent": "pi", "model": "openai/gpt-test", "effort": "off", "perm": "full", "fast": True}
        argv = ["pi", "--model", "openai/gpt-test", "--thinking", "off"]
        self.assertEqual(settings.argv_for(pick), argv)
        self.assertEqual(settings.argv_model(argv), ("openai/gpt-test", "off"))
        self.assertEqual(shlex.split(settings.reviewer_command("pi", pick["model"], "off")), argv)

    def test_pi_reviewer_never_checks_codex_catalog(self):
        for reviewer in (None, "pi"):
            with self.subTest(reviewer=reviewer), mock.patch.object(settings, "codex_lacks") as lacks:
                settings.check_reviewer_model({"reviewer": reviewer, "reviewer_model": "openai/gpt-6.2-sol"})
                lacks.assert_not_called()

    def test_inherited_reviewer_uses_saved_cli_not_model_name(self):
        store = SimpleNamespace(loc={"folder": "/scratch"})
        for reviewer, worker in (("pi", "codex"), ("codex", "pi"), ("claude", "pi")):
            cfg = {"reviewer": {"agent": reviewer}, "worker": {"agent": worker}}
            with self.subTest(reviewer=reviewer), mock.patch.object(settings, "settings_for", return_value=cfg), \
                    mock.patch.object(settings, "codex_lacks", return_value=["available-model"]) as lacks:
                task = {"reviewer_model": "claude-opus-5-5", "space": "test-space"}
                if reviewer == "codex":
                    with self.assertRaisesRegex(settings.Fail, "Codex here doesn't offer"):
                        settings.check_reviewer_model(task, store)
                    lacks.assert_called_once_with("claude-opus-5-5")
                else:
                    settings.check_reviewer_model(task, store)
                    lacks.assert_not_called()

    def test_add_validation_uses_explicit_space_and_task_override(self):
        store = SimpleNamespace(loc={"folder": "/scratch"})
        cfg = {"reviewer": {"agent": "codex"}, "worker": {"agent": "pi"}}
        args = SimpleNamespace(reviewer="pi", reviewer_model="openai/gpt-6.2-sol")
        with mock.patch.object(settings, "settings_for", return_value=cfg) as saved, \
                mock.patch.object(settings, "codex_lacks") as lacks:
            settings.set_opts({}, args, store, "chosen-space")
            saved.assert_called_with(store, "chosen-space")
            lacks.assert_not_called()

    def test_explicit_codex_reviewer_still_checks_catalog(self):
        with mock.patch.object(settings, "codex_lacks", return_value=["gpt-6-luna"]):
            with self.assertRaisesRegex(settings.Fail, "Codex here doesn't offer"):
                settings.check_reviewer_model({"reviewer": "codex", "reviewer_model": "openai/gpt-6.2-sol"})

    def test_unconfigured_worker_defaults_to_pi(self):
        with mock.patch.object(settings, "settings_for", return_value={"worker": None}):
            self.assertEqual(settings.worker_argv(None, {}), ["pi"])

    def test_saved_worker_keeps_model_and_thinking(self):
        pick = {"agent": "pi", "model": "provider/model", "effort": "xhigh"}
        with mock.patch.object(settings, "settings_for", return_value={"worker": pick}):
            self.assertEqual(settings.worker_argv(None, {}), ["pi", "--model", "provider/model", "--thinking", "xhigh"])
