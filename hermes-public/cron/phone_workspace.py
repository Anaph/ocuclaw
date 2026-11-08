"""Public phone integration for Hermes 0.21.1; owns no scheduler or job store.

All mutations call cron.jobs; execution remains with the active scheduler provider.
The small journal contains operation receipts, previews and execution bindings only.
"""

from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path

API_VERSION = 1
FIELDS = {"name", "prompt", "schedule", "model", "provider", "deliver"}
READS = {
    "automations.options",
    "automations.read",
    "automations.preview",
    "automations.draft",
    "automations.receipt",
    "jobs.list",
    "jobs.history",
    "jobs.results",
    "jobs.receipt",
}
MUTATIONS = {
    "automations.create",
    "automations.update",
    "automations.delete",
    "jobs.pause",
    "jobs.resume",
    "jobs.run",
    "jobs.stop",
}


def digest(value):
    return hashlib.sha256(
        json.dumps(
            value, sort_keys=True, ensure_ascii=False, separators=(",", ":")
        ).encode()
    ).hexdigest()


@contextmanager
def journal():
    from hermes_constants import get_hermes_home

    directory = get_hermes_home() / "cron"
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / "phone-workspace.sqlite"
    db = sqlite3.connect(path, timeout=15)
    path.chmod(0o600)
    db.row_factory = sqlite3.Row
    db.executescript("""
      CREATE TABLE IF NOT EXISTS results (id TEXT PRIMARY KEY,created REAL NOT NULL,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS previews (hash TEXT PRIMARY KEY,expires REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS bindings (execution TEXT PRIMARY KEY,job TEXT NOT NULL,session TEXT,output TEXT,stop INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS questions (id TEXT PRIMARY KEY,owner_pid INTEGER NOT NULL,owner_started INTEGER,created INTEGER NOT NULL,expires INTEGER,payload TEXT NOT NULL,execution TEXT NOT NULL,response TEXT);
      CREATE TABLE IF NOT EXISTS aliases (session TEXT PRIMARY KEY,execution TEXT NOT NULL);
    """)
    try:
        with db:
            yield db
    finally:
        db.close()


def record_session(job_id, execution_id, session_id):
    if not execution_id:
        return
    with journal() as db:
        db.execute(
            "INSERT INTO bindings(execution,job,session) VALUES (?,?,?) ON CONFLICT(execution) DO UPDATE SET session=excluded.session",
            (execution_id, job_id, session_id),
        )
        db.execute(
            "INSERT OR REPLACE INTO aliases VALUES (?,?)", (session_id, execution_id)
        )


def record_session_alias(original, current):
    with journal() as db:
        row = db.execute(
            "SELECT execution FROM aliases WHERE session=?", (original,)
        ).fetchone()
        if row:
            db.execute("INSERT OR REPLACE INTO aliases VALUES (?,?)", (current, row[0]))
            db.execute(
                "UPDATE bindings SET session=? WHERE execution=?", (current, row[0])
            )


def record_output(job_id, execution_id, path):
    if not execution_id:
        return
    with journal() as db:
        db.execute(
            "INSERT INTO bindings(execution,job,output) VALUES (?,?,?) ON CONFLICT(execution) DO UPDATE SET output=excluded.output",
            (execution_id, job_id, str(path)),
        )


def record_finished(record):
    if not record or record.get("status") not in {"completed", "failed", "unknown"}:
        return
    item = _execution(record)
    item["summary"] = item.get("summary", "")[:4000]
    from datetime import datetime

    created = datetime.fromisoformat(
        item["finishedAt"] or item["claimedAt"]
    ).timestamp()
    with journal() as db:
        db.execute(
            "INSERT OR IGNORE INTO results VALUES (?,?,?)",
            (item["id"], created, json.dumps(item, ensure_ascii=False)),
        )
        db.execute("DELETE FROM results WHERE created<?", (time.time() - 7 * 86400,))


def finished_results(params):
    before = params.get("before")
    args = [time.time() - 7 * 86400]
    where = "created>=?"
    if before:
        where += " AND (created<? OR (created=? AND id<?))"
        args.extend([before["created"], before["created"], before["id"]])
    with journal() as db:
        rows = db.execute(
            "SELECT id,created,payload FROM results WHERE "
            + where
            + " ORDER BY created DESC,id DESC LIMIT 501",
            args,
        ).fetchall()
    items, used = [], 0
    for row in rows[:500]:
        item = json.loads(row["payload"])
        size = len(json.dumps(item, ensure_ascii=False).encode())
        if items and used + size > 192 * 1024:
            break
        items.append(item)
        used += size
    last = rows[len(items) - 1] if items else None
    cursor = (
        {"created": last["created"], "id": last["id"]}
        if items and len(rows) > len(items)
        else None
    )
    return {"history": items, "nextBefore": cursor}


def binding_for_session(session_id):
    with journal() as db:
        row = db.execute(
            "SELECT b.* FROM bindings b JOIN aliases a ON a.execution=b.execution WHERE a.session=?",
            (session_id,),
        ).fetchone()
        return dict(row) if row else None


class ExecutionCancellation:
    def __init__(self, execution_id):
        self.execution_id = execution_id
        self.last_check = 0.0
        self.cancelled = False

    def is_set(self):
        if time.monotonic() - self.last_check >= 0.5:
            with journal() as db:
                row = db.execute(
                    "SELECT stop FROM bindings WHERE execution=?", (self.execution_id,)
                ).fetchone()
            self.cancelled = bool(row and row[0])
            self.last_check = time.monotonic()
        return self.cancelled

    def set(self):
        self.cancelled = True
        with journal() as db:
            db.execute(
                "UPDATE bindings SET stop=1 WHERE execution=?", (self.execution_id,)
            )


def _fields(raw):
    if not isinstance(raw, dict) or set(raw) - FIELDS:
        raise ValueError("invalid_fields")
    if any(
        not isinstance(v, str) or len(v) > (16000 if k == "prompt" else 500)
        for k, v in raw.items()
    ):
        raise ValueError("invalid_fields")
    if (
        not raw.get("name", "").strip()
        or not raw.get("prompt", "").strip()
        or not raw.get("schedule", "").strip()
    ):
        raise ValueError("invalid_fields")
    return {"deliver": "local", **raw}


def _editable(row):
    schedule = row.get("schedule") or {}
    expression = (
        schedule.get("expr")
        or schedule.get("run_at")
        or (
            f"every {schedule['minutes']}m"
            if schedule.get("kind") == "interval"
            else schedule.get("display", "")
        )
    )
    return {
        "name": row.get("name", ""),
        "prompt": row.get("prompt", ""),
        "schedule": expression,
        **{
            k: row[k]
            for k in ("model", "provider", "deliver")
            if isinstance(row.get(k), str)
        },
    }


def _job(row):
    if row is None:
        raise ValueError("job_not_found")
    fields = _editable(row)
    return {
        "id": row["id"],
        "name": row.get("name", row["id"]),
        "fields": fields,
        "revision": digest({k: v for k, v in row.items() if k != "latest_execution"}),
        "schedule": (row.get("schedule") or {}).get("display") or fields["schedule"],
        "state": row.get("state", "scheduled"),
        "paused": row.get("state") == "paused"
        or (
            not row.get("enabled", True)
            and row.get("state") not in {"completed", "error"}
        ),
        "lastStatus": row.get("last_status"),
        "nextRunAt": row.get("next_run_at"),
        "lastExecution": _execution(row.get("latest_execution")),
    }


def _execution(row):
    if not row:
        return None
    from cron.delivery_queue import get_status

    with journal() as db:
        binding = db.execute(
            "SELECT * FROM bindings WHERE execution=?", (row["id"],)
        ).fetchone()
    result = {
        "id": row["id"],
        "jobId": row["job_id"],
        "status": row["status"],
        "claimedAt": row.get("claimed_at"),
        "startedAt": row.get("started_at") or row.get("claimed_at"),
        "finishedAt": row.get("finished_at"),
        "reason": row.get("error") or "",
    }
    with journal() as db:
        questions = db.execute(
            "SELECT * FROM questions WHERE execution=? AND response IS NULL",
            (row["id"],),
        ).fetchall()
    result["needsAnswer"] = any(_live_question(question) for question in questions)
    delivery = get_status(row["id"])
    result["delivery"] = (
        delivery.get("status", "unknown") if delivery else "not_configured"
    )
    if binding:
        result["sessionId"] = binding["session"]
        result["stopRequested"] = bool(binding["stop"])
        if binding["output"]:
            from hermes_constants import get_hermes_home

            path = Path(binding["output"])
            base = (get_hermes_home() / "cron" / "output").resolve()
            if path.resolve().is_relative_to(base) and path.is_file():
                with path.open(encoding="utf-8") as stream:
                    result["summary"] = stream.read(16000)
    return result


def options():
    from hermes_time import now, get_timezone
    from cron.scheduler_provider import resolve_cron_scheduler

    from hermes_cli.config import load_config_readonly

    config = load_config_readonly() or {}
    cron = config.get("cron") or {}
    catch_up = cron.get("catch_up_missed", True)
    current = now()
    return {
        "supported": True,
        "serverNowMs": int(current.timestamp() * 1000),
        "serverLocalTime": current.isoformat(),
        "timezone": str(get_timezone() or current.tzinfo),
        "stopSupported": True,
        "scheduler": resolve_cron_scheduler().name,
        "missedPolicy": "Правила Hermes: штатное окно опоздания; "
        + (
            "один догоняющий запуск."
            if catch_up
            else "пропуски без догоняющего запуска."
        )
        + " Для разовых задач действуют отдельные правила.",
        "parallelPolicy": "Параллельные выполнения и повторы контролирует Hermes.",
        "runNowPolicy": "Hermes переносит ближайший запуск на сейчас; после выполнения вычисляет следующий. Запуск на паузе требует сначала возобновить задачу.",
    }


def preview(params):
    from cron import jobs

    fields = _fields(params.get("fields"))
    job_id = params.get("jobId")
    revision = _job(jobs.get_job(job_id))["revision"] if job_id else None
    if job_id and revision != params.get("revision"):
        raise ValueError("stale_edit")
    parsed = jobs.parse_schedule(fields["schedule"])
    runs, previous = [], None
    for _ in range(5):
        next_run = jobs.compute_next_run(parsed, previous)
        if not next_run or next_run in runs:
            break
        runs.append(next_run)
        previous = next_run
        if parsed.get("kind") == "once":
            break
    if not runs:
        raise ValueError("schedule_has_no_future_run")
    meta = options()
    review = digest(
        {
            "fields": fields,
            "jobId": job_id,
            "revision": revision,
            "timezone": meta["timezone"],
        }
    )
    with journal() as db:
        db.execute("DELETE FROM previews WHERE expires<?", (time.time(),))
        db.execute(
            "INSERT OR REPLACE INTO previews VALUES (?,?)", (review, time.time() + 120)
        )
    return {
        "preview": {
            "fields": fields,
            "reviewHash": review,
            "nextRuns": runs,
            "timezone": meta["timezone"],
            "scheduleDisplay": parsed.get("display") or fields["schedule"],
        }
    }


def draft(text):
    if not isinstance(text, str) or not 0 < len(text) <= 16000:
        raise ValueError("invalid_draft")
    from agent.auxiliary_client import call_llm
    from hermes_time import now

    # No agent loop and no tools: interpreting a voice draft cannot create a task.
    response = call_llm(
        messages=[
            {
                "role": "system",
                "content": "Extract a schedule draft as a JSON object with exactly name, prompt, schedule strings. "
                "Use 5-field cron, 'every 2h', or ISO local timestamp understood by Hermes. "
                "Do not execute anything. Ask for clarification by returning an empty schedule if ambiguous. "
                f"The server clock is {now().isoformat()}. User language is Russian.",
            },
            {"role": "user", "content": text},
        ],
        tools=[],
        temperature=0,
        max_tokens=1200,
        timeout=40,
    )
    content = response.choices[0].message.content.strip()
    content = re.sub(r"^```(?:json)?\s*|\s*```$", "", content)
    return {"fields": _fields(json.loads(content))}


def receipt(operation_id):
    with journal() as db:
        row = db.execute(
            "SELECT result FROM operations WHERE id=?", (operation_id,)
        ).fetchone()
    return json.loads(row[0]) if row else {"status": "not_found"}


def _mutate(operation, p):
    from cron import jobs
    from cron.scheduler_provider import resolve_cron_scheduler

    job_id = p.get("jobId")
    current = jobs.get_job(job_id) if job_id else None
    if operation in {"automations.update", "automations.delete"} and _job(current)[
        "revision"
    ] != p.get("revision"):
        raise ValueError("stale_edit")
    if operation in {"automations.create", "automations.update"}:
        fields = _fields(p.get("fields"))
        expected = digest(
            {
                "fields": fields,
                "jobId": job_id,
                "revision": p.get("revision") if job_id else None,
                "timezone": options()["timezone"],
            }
        )
        with journal() as db:
            proof = db.execute(
                "SELECT expires FROM previews WHERE hash=?", (expected,)
            ).fetchone()
        if expected != p.get("reviewHash") or not proof or proof[0] < time.time():
            raise ValueError("preview_expired")
        if operation == "automations.create":
            # Native create persists the task once; registration failure is a partial result.
            job = jobs.create_job(**fields)
            try:
                resolve_cron_scheduler().register_job(job)
            except Exception:
                return {"status": "saved", "registration": "failed", "job": _job(job)}
        else:
            job = jobs.update_job(job_id, fields)
        resolve_cron_scheduler().on_jobs_changed()
        return {"status": "saved", "registration": "registered", "job": _job(job)}
    if current is None:
        raise ValueError("job_not_found")
    if operation == "jobs.run" and (
        not current.get("enabled", True) or current.get("state") == "paused"
    ):
        raise ValueError("resume_before_run")
    if operation == "automations.delete":
        jobs.remove_job(job_id)
        result = {"status": "deleted"}
    elif operation == "jobs.stop":
        from cron.executions import get_execution

        execution = get_execution(p.get("executionId", ""))
        if (
            not execution
            or execution["job_id"] != job_id
            or execution["status"] not in {"claimed", "running"}
        ):
            raise ValueError("execution_not_running")
        with journal() as db:
            db.execute(
                "INSERT INTO bindings(execution,job,stop) VALUES (?,?,1) ON CONFLICT(execution) DO UPDATE SET stop=1",
                (execution["id"], job_id),
            )
        return {"status": "stop_requested", "executionId": execution["id"]}
    else:
        action = {
            "jobs.pause": jobs.pause_job,
            "jobs.resume": jobs.resume_job,
            "jobs.run": jobs.trigger_job,
        }[operation]
        result = {"status": "applied", "job": _job(action(job_id))}
    resolve_cron_scheduler().on_jobs_changed()
    return result


def handle(operation, params):
    from cron import jobs

    if operation not in READS | MUTATIONS:
        raise ValueError("unsupported_operation")
    if operation == "automations.options":
        return options()
    if operation == "automations.preview":
        return preview(params)
    if operation == "automations.draft":
        return draft(params.get("text"))
    if operation in {"automations.receipt", "jobs.receipt"}:
        return receipt(params.get("operationId", ""))
    if operation == "automations.read":
        return {"job": _job(jobs.get_job(params.get("jobId")))}
    if operation == "jobs.list":
        return {"jobs": [_job(row) for row in jobs.workspace_snapshot()]}
    if operation == "jobs.results":
        return finished_results(params)
    if operation == "jobs.history":
        from cron.executions import list_executions

        rows = list_executions(
            job_id=params.get("jobId"),
            limit=500,
            before_claimed_at=params.get("before"),
        )
        items, used = [], 0
        for row in rows:
            item = _execution(row)
            size = len(json.dumps(item, ensure_ascii=False).encode())
            if items and used + size > 192 * 1024:
                break
            items.append(item)
            used += size
        cursor = (
            items[-1]["claimedAt"]
            if items and (len(items) < len(rows) or len(rows) == 500)
            else None
        )
        return {"history": items, "nextBefore": cursor}
    operation_id = params.get("operationId")
    if not isinstance(operation_id, str) or not re.fullmatch(
        r"[A-Za-z0-9_-]{1,128}", operation_id
    ):
        raise ValueError("invalid_operation_id")
    fingerprint = digest(
        [operation, {k: v for k, v in params.items() if k != "operationId"}]
    )
    # Use the scheduler's own cross-process transaction, also taken by CLI/Desktop.
    with jobs.workspace_transaction():
        with journal() as db:
            previous = db.execute(
                "SELECT fingerprint,result FROM operations WHERE id=?", (operation_id,)
            ).fetchone()
            if previous:
                if previous[0] != fingerprint:
                    raise ValueError("operation_conflict")
                return json.loads(previous[1])
            db.execute(
                "INSERT INTO operations VALUES (?,?,?)",
                (operation_id, fingerprint, json.dumps({"status": "uncertain"})),
            )
        try:
            result = _mutate(operation, params)
        except ValueError as error:
            # Admission was recorded. Validation failures are terminal receipts too.
            result = {"status": "rejected", "error": str(error)}
        except Exception:
            return {"status": "uncertain"}
        with journal() as db:
            db.execute(
                "UPDATE operations SET result=? WHERE id=?",
                (json.dumps(result), operation_id),
            )
        return result


# Cross-process human questions are live rendezvous, never replayed history.
# A restart cannot revive one: every read verifies the exact producer PID birth.
def _producer_alive(row):
    from gateway.status import get_process_start_time

    try:
        return (
            row["owner_started"] is not None
            and get_process_start_time(row["owner_pid"]) == row["owner_started"]
        )
    except (OSError, ValueError):
        return False


def _live_question(row):
    return (
        row
        and row["response"] is None
        and (row["expires"] is None or row["expires"] > time.time() * 1000)
        and _producer_alive(row)
    )


def pending_questions():
    with journal() as db:
        rows = db.execute(
            "SELECT * FROM questions WHERE response IS NULL ORDER BY created,id"
        ).fetchall()
    return [
        dict(
            json.loads(row["payload"]),
            sourceId=row["id"],
            createdAtMs=row["created"],
            expiresAtMs=row["expires"],
        )
        for row in rows
        if _live_question(row)
    ]


def resolve_question(question_id, answer):
    with journal() as db:
        db.execute("BEGIN IMMEDIATE")
        row = db.execute(
            "SELECT * FROM questions WHERE id=?", (question_id,)
        ).fetchone()
        if not _live_question(row):
            return False
        db.execute(
            "UPDATE questions SET response=? WHERE id=? AND response IS NULL",
            (answer, question_id),
        )
        return True


def clarify_callback(session_id):
    def ask(question, choices, multi_select=False):
        import os
        import uuid
        from gateway.status import get_process_start_time
        from tools.clarify_gateway import get_clarify_timeout
        from tools.environments.base import touch_activity_if_due

        binding = binding_for_session(session_id)
        if not binding:
            return None
        identity = uuid.uuid4().hex
        created = int(time.time() * 1000)
        timeout = get_clarify_timeout()
        expires = created + timeout * 1000 if timeout > 0 else None
        payload = {
            "sessionId": session_id,
            "jobId": binding["job"],
            "executionId": binding["execution"],
            "question": question,
            "choices": list(choices or []),
            "multiSelect": bool(multi_select),
        }
        with journal() as db:
            db.execute(
                "INSERT INTO questions VALUES (?,?,?,?,?,?,?,NULL)",
                (
                    identity,
                    os.getpid(),
                    get_process_start_time(os.getpid()),
                    created,
                    expires,
                    json.dumps(payload, ensure_ascii=False),
                    binding["execution"],
                ),
            )
        activity = {"last_touch": time.monotonic(), "start": time.monotonic()}
        cancellation = ExecutionCancellation(binding["execution"])
        try:
            while expires is None or time.time() * 1000 < expires:
                if cancellation.is_set():
                    return None
                with journal() as db:
                    row = db.execute(
                        "SELECT response FROM questions WHERE id=?", (identity,)
                    ).fetchone()
                if not row:
                    return None
                if row[0] is not None:
                    return row[0]
                touch_activity_if_due(activity, "waiting for scheduled task question")
                time.sleep(0.2)
            return None
        finally:
            with journal() as db:
                db.execute("DELETE FROM questions WHERE id=?", (identity,))

    return ask
