"""Real Hermes 0.21.1 integration. Run in an isolated test environment.

PYTHONPATH=/path/to/prepared/hermes python tests_integration/test_hermes_workspace.py
Never connects to a VPS or inference provider.
"""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import types
import unittest
from unittest.mock import patch


class HermesWorkspaceTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        root = Path(__file__).resolve().parents[1]
        package = types.ModuleType("ocuclaw")
        package.__path__ = [str(root)]
        sys.modules["ocuclaw"] = package
        from ocuclaw.workspace_schedule import WorkspaceSchedule

        cls.WorkspaceSchedule = WorkspaceSchedule

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        os.environ["HERMES_HOME"] = self.directory.name
        Path(self.directory.name, "config.yaml").write_text(
            "timezone: Europe/Istanbul\nmodel:\n  default: test-model\n  provider: custom\nagent:\n  clarify_timeout: 15\n"
        )
        from cron import phone_workspace, jobs

        self.api, self.jobs = phone_workspace, jobs

    def create(self):
        fields = {
            "name": "Утренний отчёт",
            "prompt": "Подготовить отчёт",
            "schedule": "0 9 * * 1-5",
        }
        preview = self.api.handle("automations.preview", {"fields": fields})["preview"]
        params = {
            "fields": fields,
            "reviewHash": preview["reviewHash"],
            "operationId": "create-1",
        }
        result = self.api.handle("automations.create", params)
        self.assertEqual(result["status"], "saved", result)
        return result["job"], params

    def test_native_crud_replay_revision_and_server_clock(self):
        job, params = self.create()
        self.assertEqual(
            self.api.handle("automations.options", {})["timezone"], "Europe/Istanbul"
        )
        self.assertEqual(
            self.api.handle("automations.create", params)["job"]["id"], job["id"]
        )
        self.assertEqual(len(self.jobs.list_jobs()), 1)
        self.jobs.update_job(job["id"], {"name": "Изменено в Desktop"})
        with self.assertRaisesRegex(ValueError, "stale_edit"):
            self.api.handle(
                "automations.preview",
                {
                    "jobId": job["id"],
                    "revision": job["revision"],
                    "fields": params["fields"],
                },
            )
        result = self.api.handle(
            "jobs.pause", {"jobId": job["id"], "operationId": "pause-1"}
        )
        self.assertTrue(result["job"]["paused"])
        rejected = self.api.handle(
            "jobs.run", {"jobId": job["id"], "operationId": "run-paused"}
        )
        self.assertEqual(rejected["error"], "resume_before_run")
        self.api.handle("jobs.resume", {"jobId": job["id"], "operationId": "resume-1"})
        self.assertEqual(self.jobs.get_job(job["id"])["state"], "scheduled")
        before = self.jobs.get_job(job["id"])["next_run_at"]
        self.api.handle("jobs.run", {"jobId": job["id"], "operationId": "run-now"})
        self.assertNotEqual(self.jobs.get_job(job["id"])["next_run_at"], before)
        current = self.api.handle("automations.read", {"jobId": job["id"]})["job"]
        self.api.handle(
            "automations.delete",
            {
                "jobId": job["id"],
                "revision": current["revision"],
                "operationId": "delete-1",
            },
        )
        self.assertIsNone(self.jobs.get_job(job["id"]))

    def test_uncertain_operation_is_not_executed_again(self):
        self.create()
        with patch.object(
            self.api, "_mutate", side_effect=RuntimeError("lost ack")
        ) as action:
            params = {
                "jobId": self.jobs.list_jobs()[0]["id"],
                "operationId": "uncertain-1",
            }
            self.assertEqual(self.api.handle("jobs.run", params)["status"], "uncertain")
            self.assertEqual(self.api.handle("jobs.run", params)["status"], "uncertain")
            self.assertEqual(action.call_count, 1)
        self.assertEqual(self.api.receipt("uncertain-1")["status"], "uncertain")

    def test_editing_interval_metadata_keeps_native_next_run(self):
        native = self.jobs.create_job(
            name="Отчёт", prompt="Собрать данные", schedule="every 2h"
        )
        current = self.api.handle("automations.read", {"jobId": native["id"]})["job"]
        params = {
            "jobId": native["id"],
            "revision": current["revision"],
            "fields": {**current["fields"], "name": "Новый отчёт"},
        }
        preview = self.api.handle("automations.preview", params)["preview"]
        self.assertEqual(len(preview["nextRuns"]), 5)
        self.assertEqual(preview["nextRuns"][0], native["next_run_at"])
        result = self.api.handle(
            "automations.update",
            {**params, "reviewHash": preview["reviewHash"], "operationId": "rename-1"},
        )
        self.assertEqual(result["status"], "saved", result)
        self.assertEqual(result["job"]["name"], "Новый отчёт")
        self.assertEqual(result["job"]["nextRunAt"], native["next_run_at"])

    def test_question_from_another_process_and_dead_owner(self):
        job, _ = self.create()
        from cron.executions import create_execution

        execution = create_execution(job["id"], source="integration")
        script = """
import sys,json
from cron import phone_workspace as api
api.record_session(sys.argv[1],sys.argv[2],'cron_integration')
answer=api.clarify_callback('cron_integration')('Какой период?', ['Месяц','Квартал'])
print(json.dumps({'answer':answer},ensure_ascii=False),flush=True)
"""
        worker = subprocess.Popen(
            [sys.executable, "-c", script, job["id"], execution["id"]],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        self.addCleanup(lambda: worker.kill() if worker.poll() is None else None)
        pending = []
        until = time.monotonic() + 12
        while time.monotonic() < until:
            pending = self.api.pending_questions()
            if pending or worker.poll() is not None:
                break
            time.sleep(0.05)
        if not pending:
            out, err = worker.communicate(timeout=2)
            self.fail(f"No cross-process question: {out} {err}")
        question = pending[0]
        self.assertEqual(question["executionId"], execution["id"])
        self.assertTrue(self.api.resolve_question(question["sourceId"], "Квартал"))
        self.assertFalse(self.api.resolve_question(question["sourceId"], "Месяц"))
        out, err = worker.communicate(timeout=5)
        self.assertEqual(worker.returncode, 0, err)
        self.assertEqual(json.loads(out.strip().splitlines()[-1])["answer"], "Квартал")
        self.assertEqual(self.api.pending_questions(), [])
        worker = subprocess.Popen(
            [sys.executable, "-c", script, job["id"], execution["id"]],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        until = time.monotonic() + 8
        while time.monotonic() < until and not self.api.pending_questions():
            time.sleep(0.05)
        stale = self.api.pending_questions()[0]
        worker.kill()
        worker.communicate(timeout=3)
        self.assertEqual(self.api.pending_questions(), [])
        self.assertFalse(self.api.resolve_question(stale["sourceId"], "Месяц"))

    def test_stop_is_addressed_and_does_not_pause_schedule(self):
        job, _ = self.create()
        from cron.executions import create_execution, mark_execution_running

        execution = create_execution(job["id"], source="integration")
        mark_execution_running(execution["id"])
        self.api.record_session(job["id"], execution["id"], "cron_running")
        before = self.jobs.get_job(job["id"])
        result = self.api.handle(
            "jobs.stop",
            {
                "jobId": job["id"],
                "executionId": execution["id"],
                "operationId": "stop-1",
            },
        )
        self.assertEqual(result["status"], "stop_requested")
        self.assertTrue(self.api.ExecutionCancellation(execution["id"]).is_set())
        self.assertEqual(self.jobs.get_job(job["id"]), before)
        other = self.api.handle(
            "jobs.stop",
            {
                "jobId": job["id"],
                "executionId": "not-this-run",
                "operationId": "stop-2",
            },
        )
        self.assertEqual(other["status"], "rejected")

    def test_native_execution_runs_without_any_phone_client(self):
        from cron import scheduler
        from cron.executions import create_execution, get_execution

        directory = Path(self.directory.name)
        (directory / "scripts").mkdir()
        (directory / "scripts" / "probe.py").write_text(
            "print('Native scheduler probe completed')\n"
        )
        job = self.jobs.create_job(
            prompt="", schedule="every 2h", script="probe.py", no_agent=True
        )
        execution = create_execution(job["id"], source="integration")
        job["execution_id"] = execution["id"]
        with patch.dict(os.environ, {"_HERMES_CRON_EXTERNAL_WORKER": execution["id"]}):
            self.assertTrue(scheduler.run_one_job(job))
        self.assertEqual(get_execution(execution["id"])["status"], "completed")
        history = self.api.handle("jobs.history", {"jobId": job["id"]})["history"]
        self.assertIn("Native scheduler probe completed", history[0]["summary"])
        for output in (directory / "cron" / "output").rglob("*.md"):
            output.unlink()
        results = self.api.handle("jobs.results", {})["history"]
        self.assertIn(
            "Native scheduler probe completed",
            next(row for row in results if row["id"] == execution["id"])["summary"],
        )

    def test_profile_stores_and_strict_native_lock(self):
        from hermes_constants import (
            set_hermes_home_override,
            reset_hermes_home_override,
        )

        first, _ = self.create()
        with tempfile.TemporaryDirectory() as directory:
            token = set_hermes_home_override(directory)
            try:
                self.assertEqual(self.api.handle("jobs.list", {})["jobs"], [])
                self.assertEqual(self.api.receipt("create-1")["status"], "not_found")
            finally:
                reset_hermes_home_override(token)
        with patch.object(self.jobs, "_acquire_flock", return_value=False):
            with self.assertRaisesRegex(RuntimeError, "native_job_lock_unavailable"):
                self.api.handle(
                    "jobs.pause", {"jobId": first["id"], "operationId": "lock-failed"}
                )
        self.assertEqual(self.jobs.get_job(first["id"])["state"], "scheduled")

    def test_plugin_models_resolve_the_selected_profile(self):
        from hermes_cli.config import load_config_readonly

        with tempfile.TemporaryDirectory() as directory:
            secondary = Path(directory)
            (secondary / "config.yaml").write_text(
                "model:\n  default: research-model\n  provider: custom\n"
            )

            class Rpc:
                def _routing_snapshot(self):
                    return True, {
                        "main": Path(self_outer.directory.name),
                        "research": secondary,
                    }

                async def list_models(self, params):
                    return {
                        "models": [{"id": load_config_readonly()["model"]["default"]}]
                    }

            self_outer = self
            api = self.WorkspaceSchedule(Rpc())
            result = asyncio.run(api.models({"profileId": "research"}))
            self.assertEqual(result["models"][0]["id"], "research-model")
            result = asyncio.run(api.models({"profileId": "default"}))
            self.assertEqual(result["models"][0]["id"], "test-model")
            with self.assertRaisesRegex(ValueError, "profile_not_served"):
                asyncio.run(api.models({"profileId": "private"}))

    def test_oversized_cron_history_message_keeps_a_pagination_cursor(self):
        from cron.executions import create_execution

        job, _ = self.create()
        execution = create_execution(job["id"], source="integration")
        self.api.record_session(job["id"], execution["id"], "cron_large_message")
        rpc = types.SimpleNamespace(
            _routing_snapshot=lambda: (True, {"main": Path(self.directory.name)})
        )
        transcript = types.SimpleNamespace(
            conversation_by_id=lambda session, limit: [
                {"id": 1, "role": "user", "content": "Начало"},
                {"id": 2, "role": "assistant", "content": "А" * 200_000},
            ]
        )
        api = self.WorkspaceSchedule(rpc, transcript)
        params = {"sessionKey": "hermes:main:x:cron:cron_large_message", "limit": 1}
        page = asyncio.run(api.chat_history(params))
        self.assertTrue(page["hasMore"])
        self.assertIn("сообщение сокращено", page["messages"][0]["content"])
        previous = asyncio.run(
            api.chat_history({**params, "beforeId": page["nextBeforeId"]})
        )
        self.assertEqual(previous["messages"][0]["content"], "Начало")

    def test_preview_is_native_and_read_only(self):
        for schedule in ["every 2h", "0 9 * * *", "0 9 * * 1-5"]:
            fields = {"name": "Проверка", "prompt": "Задача", "schedule": schedule}
            result = self.api.preview({"fields": fields})["preview"]
            self.assertEqual(len(result["nextRuns"]), 5)
            self.assertTrue(all("+03:00" in item for item in result["nextRuns"]))
        self.assertFalse(Path(self.directory.name, "cron/jobs.json").exists())
        self.assertEqual(self.api.handle("jobs.list", {})["jobs"], [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
