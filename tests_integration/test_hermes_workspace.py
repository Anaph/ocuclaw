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

    def test_due_scan_distinguishes_the_two_occurrences_of_a_repeated_hour(self):
        from datetime import datetime
        from zoneinfo import ZoneInfo

        Path(self.directory.name, "config.yaml").write_text("timezone: Europe/Berlin\n")
        zone = ZoneInfo("Europe/Berlin")
        with patch.object(
            self.jobs,
            "_hermes_now",
            return_value=datetime(2026, 10, 25, 1, 55, tzinfo=zone),
        ):
            once = self.jobs.create_job(
                prompt="Once", schedule="2026-10-25T02:10:00+01:00"
            )
            daily = self.jobs.create_job(prompt="Daily", schedule="45 2 * * *")
        with patch.object(
            self.jobs,
            "_hermes_now",
            return_value=datetime(2026, 10, 25, 2, 20, tzinfo=zone),
        ):
            self.assertEqual(self.jobs.get_due_jobs(), [])
        with patch.object(
            self.jobs,
            "_hermes_now",
            return_value=datetime(2026, 10, 25, 2, 10, tzinfo=zone, fold=1),
        ):
            due = {row["id"]: row for row in self.jobs.get_due_jobs()}
        self.assertEqual(set(due), {once["id"], daily["id"]})
        self.assertEqual(due[daily["id"]]["last_dispatch"]["lateness_seconds"], 25 * 60)

    def test_interval_and_relative_once_use_elapsed_minutes_across_clock_changes(self):
        from datetime import datetime
        from zoneinfo import ZoneInfo
        import hermes_time

        Path(self.directory.name, "config.yaml").write_text("timezone: Europe/Berlin\n")
        zone = ZoneInfo("Europe/Berlin")
        for clock, expected in (
            (datetime(2026, 3, 29, 1, 45, tzinfo=zone), "2026-03-29T03:15:00+02:00"),
            (datetime(2026, 10, 25, 2, 45, tzinfo=zone), "2026-10-25T02:15:00+01:00"),
        ):
            with (
                patch.object(hermes_time, "now", return_value=clock),
                patch.object(self.jobs, "_hermes_now", return_value=clock),
            ):
                for expression in ("every 30m", "in 30m"):
                    with self.subTest(clock=clock, expression=expression):
                        fields = {
                            "name": "Timer", "prompt": "Test", "schedule": expression
                        }
                        preview = self.api.handle(
                            "automations.preview", {"fields": fields}
                        )["preview"]
                        self.assertEqual(preview["nextRuns"][0], expected)
                        result = self.api.handle(
                            "automations.create",
                            {
                                "fields": fields,
                                "reviewHash": preview["reviewHash"],
                                "operationId": f"timer-{clock.month}-{expression[:2]}",
                            },
                        )
                        self.assertEqual(result["job"]["nextRunAt"], expected)

    def test_native_clock_changes_and_reviewed_first_launch(self):
        from datetime import datetime
        from zoneinfo import ZoneInfo
        import hermes_time

        config = Path(self.directory.name, "config.yaml")
        config.write_text("timezone: Europe/Berlin\n")
        zone = ZoneInfo("Europe/Berlin")
        fields = {"name": "Daily", "prompt": "Test", "schedule": "0 9 * * *"}
        for month, previous, transition in [(3, 28, 29), (10, 24, 25)]:
            before = datetime(2026, month, previous, 9, 1, tzinfo=zone)
            with (
                patch.object(hermes_time, "now", return_value=before),
                patch.object(self.jobs, "_hermes_now", return_value=before),
            ):
                preview = self.api.handle("automations.preview", {"fields": fields})[
                    "preview"
                ]
                first = datetime.fromisoformat(preview["nextRuns"][0])
                self.assertEqual((first.day, first.hour), (transition, 9))
                self.assertEqual(
                    [datetime.fromisoformat(x).hour for x in preview["nextRuns"]],
                    [9] * 5,
                )
                result = self.api.handle(
                    "automations.create",
                    {
                        "fields": fields,
                        "reviewHash": preview["reviewHash"],
                        "operationId": f"dst-{month}",
                    },
                )
                self.assertEqual(result["job"]["nextRunAt"], preview["nextRuns"][0])
            due = datetime(2026, month, transition, 9, tzinfo=zone)
            with patch.object(self.jobs, "_hermes_now", return_value=due):
                self.assertIn(
                    result["job"]["id"], {job["id"] for job in self.jobs.get_due_jobs()}
                )
            self.jobs.remove_job(result["job"]["id"])
        before = datetime(2027, 2, 1, 8, 59, 55, tzinfo=zone)
        after = datetime(2027, 2, 1, 9, 0, 5, tzinfo=zone)
        interval = {**fields, "schedule": "every 2h"}
        with patch.object(hermes_time, "now", return_value=before):
            preview = self.api.handle("automations.preview", {"fields": fields})[
                "preview"
            ]
            cadence = self.api.handle("automations.preview", {"fields": interval})[
                "preview"
            ]
            with self.assertRaisesRegex(ValueError, "nonexistent_local_time"):
                self.api.handle(
                    "automations.preview",
                    {"fields": {**fields, "schedule": "2027-03-28T02:30:00"}},
                )
            with self.assertRaisesRegex(ValueError, "ambiguous_local_time"):
                self.api.handle(
                    "automations.preview",
                    {"fields": {**fields, "schedule": "2027-10-31T02:30:00"}},
                )
            explicit = "2027-10-31T02:30:00+01:00"
            exact = self.api.handle(
                "automations.preview", {"fields": {**fields, "schedule": explicit}}
            )["preview"]
            self.assertEqual(exact["nextRuns"], [explicit])
        with patch.object(hermes_time, "now", return_value=after):
            expired = self.api.handle(
                "automations.create",
                {
                    "fields": fields,
                    "reviewHash": preview["reviewHash"],
                    "operationId": "past-reviewed",
                },
            )
            self.assertEqual(
                expired, {"status": "rejected", "error": "preview_expired"}
            )
            result = self.api.handle(
                "automations.create",
                {
                    "fields": interval,
                    "reviewHash": cadence["reviewHash"],
                    "operationId": "interval-reviewed",
                },
            )
            self.assertEqual(result["job"]["nextRunAt"], cadence["nextRuns"][0])

    def test_a_legacy_dst_shift_is_repaired_before_it_can_skip_an_occurrence(self):
        from datetime import datetime
        from zoneinfo import ZoneInfo

        Path(self.directory.name, "config.yaml").write_text("timezone: Europe/Berlin\n")
        zone = ZoneInfo("Europe/Berlin")
        before = datetime(2026, 10, 24, 9, 1, tzinfo=zone)
        with patch.object(self.jobs, "_hermes_now", return_value=before):
            job = self.jobs.create_job(prompt="Legacy", schedule="0 9 * * *")
            self.jobs.update_job(
                job["id"], {"next_run_at": "2026-10-25T10:00:00+01:00"}
            )
        early = datetime(2026, 10, 25, 8, 59, tzinfo=zone)
        with patch.object(self.jobs, "_hermes_now", return_value=early):
            self.assertEqual(self.jobs.get_due_jobs(), [])
            self.assertEqual(
                self.jobs.get_job(job["id"])["next_run_at"], "2026-10-25T09:00:00+01:00"
            )
        due = datetime(2026, 10, 25, 9, tzinfo=zone)
        with patch.object(self.jobs, "_hermes_now", return_value=due):
            self.assertEqual(
                [row["id"] for row in self.jobs.get_due_jobs()], [job["id"]]
            )

    def test_history_orders_instants_and_retains_rows_with_equal_claim_time(self):
        from cron import executions
        from datetime import datetime

        job_id = self.jobs.create_job(prompt="Test", schedule="every 2h")["id"]
        root = Path(self.directory.name, "cron", "output", job_id)
        root.mkdir(parents=True)
        expected = set()
        for index in range(7):
            instant = datetime.fromisoformat("2026-10-25T02:10:00+01:00")
            with patch.object(executions, "_hermes_now", return_value=instant):
                run = executions.create_execution(job_id, source="integration")
            expected.add(run["id"])
            file = root / f"{index}.md"
            file.write_text("🧪" * 16000)
            self.api.record_output(job_id, run["id"], file)
        with patch.object(
            executions,
            "_hermes_now",
            return_value=datetime.fromisoformat("2026-10-25T02:50:00+02:00"),
        ):
            earlier = executions.create_execution(job_id, source="integration")
        seen = []
        cursor = None
        while True:
            page = self.api.handle("jobs.history", {"jobId": job_id, "before": cursor})
            seen.extend(row["id"] for row in page["history"])
            cursor = page["nextBefore"]
            if cursor is None:
                break
            self.assertLess(len(seen), 9)
        self.assertEqual(seen[-1], earlier["id"])
        self.assertEqual(set(seen[:-1]), expected)
        self.assertEqual(len(seen), 8)
        row, = self.jobs.workspace_snapshot()
        self.assertEqual(row["latest_execution"]["id"], seen[0])

    def test_large_job_list_paginates_without_exceeding_the_control_link_frame(self):
        from ocuclaw.control_link import encode_link_frame

        prompt = "🧪" * 16000
        ids = {
            self.jobs.create_job(
                name=f"Test {index}", prompt=prompt, schedule="every 2h"
            )["id"]
            for index in range(41)
        }
        legacy = self.api.handle("jobs.list", {})
        self.assertTrue(encode_link_frame({"type": "result", "data": legacy})[1])
        first = self.api.handle("jobs.list", {"paged": True})
        self.assertFalse(encode_link_frame({"type": "result", "data": first})[1])
        self.assertTrue(first["nextAfterJobId"])
        second = self.api.handle(
            "jobs.list", {"paged": True, "afterJobId": first["nextAfterJobId"]}
        )
        self.assertFalse(encode_link_frame({"type": "result", "data": second})[1])
        self.assertIsNone(second["nextAfterJobId"])
        listed = [row["id"] for row in first["jobs"] + second["jobs"]]
        self.assertEqual(listed, sorted(ids))
        detail = self.api.handle("automations.read", {"jobId": listed[0]})
        self.assertEqual(detail["job"]["fields"]["prompt"], prompt)

    def test_repeated_local_hour_has_independent_native_output_and_session_ids(self):
        from cron import executions, scheduler
        from datetime import datetime
        from zoneinfo import ZoneInfo
        from contextlib import ExitStack

        root = Path(self.directory.name)
        scripts = root / "scripts"
        scripts.mkdir()
        script = scripts / "probe.py"
        zone = ZoneInfo("Europe/Berlin")
        job = self.jobs.create_job(
            prompt="", schedule="every 2h", script=script.name, no_agent=True
        )
        agent_job = self.jobs.create_job(prompt="Test", schedule="every 2h")
        ids, agent_ids = [], []
        for fold in (0, 1):
            clock = datetime(2027, 10, 31, 2, 20, tzinfo=zone, fold=fold)
            script.write_text(f"print('Result {fold}')\n")
            with ExitStack() as stack:
                for module in (self.jobs, scheduler, executions):
                    stack.enter_context(
                        patch.object(module, "_hermes_now", return_value=clock)
                    )
                row = executions.create_execution(job["id"], source="integration")
                ids.append(row["id"])
                with patch.dict(
                    os.environ, {"_HERMES_CRON_EXTERNAL_WORKER": row["id"]}
                ):
                    self.assertTrue(
                        scheduler.run_one_job({**job, "execution_id": row["id"]})
                    )
                row = executions.create_execution(agent_job["id"], source="integration")
                agent_ids.append(row["id"])
                with (
                    patch.dict(
                        sys.modules,
                        {"run_agent": types.SimpleNamespace(AIAgent=object)},
                    ),
                    patch.multiple(
                        scheduler,
                        _prepare_job_prompt=lambda *a: (None, "Test"),
                        _load_cron_job_config=lambda *a: types.SimpleNamespace(
                            cfg={}, model="test"
                        ),
                        _resolve_cron_agent_setup=lambda *a: types.SimpleNamespace(
                            blocked=None, model="test"
                        ),
                        _open_cron_session_db=lambda *a: None,
                        _construct_cron_agent=lambda *a, **kw: object(),
                        _run_agent_with_watchdog=lambda *a, **kw: {},
                        _final_response_from_result=lambda *a: "Test model result",
                        _teardown_cron_agent=lambda *a: None,
                    ),
                    patch.dict(os.environ, {"_HERMES_CRON_EXTERNAL_WORKER": row["id"]}),
                ):
                    self.assertTrue(
                        scheduler.run_one_job({**agent_job, "execution_id": row["id"]})
                    )
        history = {
            row["id"]: row
            for row in self.api.handle("jobs.history", {"jobId": job["id"]})["history"]
        }
        self.assertIn("Result 0", history[ids[0]]["summary"])
        self.assertIn("Result 1", history[ids[1]]["summary"])
        self.assertEqual(
            len(list((root / "cron" / "output" / job["id"]).glob("*.md"))), 2
        )
        history = {
            row["id"]: row
            for row in self.api.handle("jobs.history", {"jobId": agent_job["id"]})[
                "history"
            ]
        }
        keys = [history[run]["sessionId"] for run in agent_ids]
        self.assertEqual(len(set(keys)), 2)
        for run, key in zip(agent_ids, keys):
            self.assertEqual(self.api.binding_for_session(key)["execution"], run)

    def test_failed_registration_is_visible_in_persisted_schedule(self):
        from cron import scheduler_provider

        def fail(_):
            raise RuntimeError("test provider refused registration")

        provider = types.SimpleNamespace(
            name="test", register_job=fail, on_jobs_changed=lambda: None
        )
        with patch.object(
            scheduler_provider, "resolve_cron_scheduler", return_value=provider
        ):
            fields = {"name": "Task", "prompt": "Test", "schedule": "every 2h"}
            preview = self.api.handle("automations.preview", {"fields": fields})[
                "preview"
            ]
            result = self.api.handle(
                "automations.create",
                {
                    "fields": fields,
                    "reviewHash": preview["reviewHash"],
                    "operationId": "registration",
                },
            )
        self.assertEqual(result["registration"], "failed")
        self.assertEqual(
            self.api.handle("jobs.list", {})["jobs"][0]["registration"], "failed"
        )
        self.assertEqual(
            self.api.handle("automations.receipt", {"operationId": "registration"}),
            result,
        )

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
