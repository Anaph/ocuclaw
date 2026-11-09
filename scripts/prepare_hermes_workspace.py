#!/usr/bin/env python3
"""Prepare (never install) the public Workspace API for exact Hermes 0.21.1."""

from __future__ import annotations

import argparse
import ast
import hashlib
import json
from pathlib import Path

COMMIT = "2237be355906fbe6065ce1815711eee52b2d646e"


def prepare_jobs(source):
    if "def workspace_transaction(" in source:
        return source
    if "def _jobs_lock():" not in source or "def use_cron_store(" not in source:
        raise ValueError("unsupported_jobs_source")
    source = source.replace(
        "def _jobs_lock():", "def _jobs_lock(*, require_file_lock=False):", 1
    )
    anchor = "                if _acquire_flock(lock_fd, _JOBS_LOCK_TIMEOUT_SECONDS) is False:"
    if source.count(anchor) != 1:
        raise ValueError("unsupported_job_lock")
    source = source.replace(
        anchor,
        '                lock_result = _acquire_flock(lock_fd, _JOBS_LOCK_TIMEOUT_SECONDS)\n                if require_file_lock and lock_result is not True:\n                    lock_fd.close()\n                    lock_fd = None\n                    raise RuntimeError("native_job_lock_unavailable")\n                if lock_result is False:',
        1,
    )
    fallback = "            except (OSError, IOError) as e:\n                # A locking failure"
    if source.count(fallback) != 1:
        raise ValueError("unsupported_job_lock_fallback")
    source = source.replace(
        fallback,
        '            except (OSError, IOError) as e:\n                if require_file_lock:\n                    if lock_fd is not None:\n                        lock_fd.close()\n                    raise RuntimeError("native_job_lock_unavailable") from e\n                # A locking failure',
        1,
    )
    start = source.index("def parse_schedule(")
    end = source.index("def _ensure_aware(", start)
    parser = source[start:end].replace("_hermes_now()", "_workspace_schedule_now()")
    parser = parser.replace(
        "dt = dt.replace(tzinfo=_workspace_schedule_now().tzinfo)",
        """candidates = _workspace_wall_times(dt, _workspace_schedule_now().tzinfo)
                if not candidates:
                    raise ValueError("nonexistent_local_time")
                if len(candidates) != 1:
                    raise ValueError("ambiguous_local_time")
                dt = candidates[0]""",
    )
    source = source[:start] + parser + source[end:]
    source = source.replace(
        "prev = croniter(str(expr), next_run_dt + timedelta(seconds=1)).get_prev(datetime)\n        return abs((prev - next_run_dt).total_seconds()) < 1.0",
        "wall = next_run_dt.replace(tzinfo=None)\n        prev = croniter(str(expr), wall + timedelta(seconds=1)).get_prev(datetime)\n        if abs((prev - wall).total_seconds()) >= 1.0:\n            return False\n        candidates = _workspace_wall_times(wall, next_run_dt.tzinfo)\n        return bool(candidates and candidates[0].timestamp() == next_run_dt.timestamp())",
        1,
    )
    start = source.index("def compute_next_run(")
    end = source.index("# --- Ticker heartbeat", start)
    computation = source[start:end].replace(
        "now = _hermes_now()", "now = _workspace_schedule_now()"
    )
    computation = computation.replace(
        "return croniter(expr, base_time).get_next(datetime).isoformat()",
        """iterator = croniter(expr, base_time.replace(tzinfo=None))
        while True:
            wall = iterator.get_next(datetime)
            candidates = _workspace_wall_times(wall, base_time.tzinfo)
            if candidates and candidates[0].timestamp() > base_time.timestamp():
                return candidates[0].isoformat()""",
    )
    source = source[:start] + computation + source[end:]
    source = source.replace(
        "def save_job_output(job_id: str, output: str):",
        "def save_job_output(job_id: str, output: str, *, execution_id=None):",
        1,
    ).replace(
        """    output_file = job_output_dir / f"{_hermes_now().strftime('%Y-%m-%d_%H-%M-%S')}.md" """.rstrip(),
        """    stamp = _hermes_now().strftime('%Y-%m-%d_%H-%M-%S')
    if execution_id:
        stamp += "-" + uuid.UUID(str(execution_id)).hex
    output_file = job_output_dir / f"{stamp}.md" """.rstrip(),
        1,
    )
    anchor = '    manual_run = job.get("manual_run_at") == next_run'
    if source.count(anchor) != 1:
        raise ValueError("unsupported_due_job_source")
    source = source.replace(
        anchor,
        anchor
        + """
    if kind == "cron" and not manual_run and _workspace_repair_old_dst(d):
        return False""",
        1,
    )
    source += '''\n\n@contextlib.contextmanager
def workspace_transaction():
    """Public transaction shared with CLI, Desktop and scheduler mutations."""
    with _jobs_lock(require_file_lock=True):
        yield


from contextvars import ContextVar

_workspace_schedule_anchor = ContextVar("workspace_schedule_anchor", default=None)


@contextlib.contextmanager
def workspace_schedule_time(instant):
    """Use a reviewed clock sample for native schedule parsing and computation."""
    token = _workspace_schedule_anchor.set(instant)
    try:
        yield
    finally:
        _workspace_schedule_anchor.reset(token)


def _workspace_schedule_now():
    return _workspace_schedule_anchor.get() or _hermes_now()


def _workspace_wall_times(wall, zone):
    """Return real instants for a local wall time, earliest first."""
    from datetime import timezone

    found = {}
    for fold in (0, 1):
        candidate = wall.replace(tzinfo=zone, fold=fold)
        if candidate.astimezone(timezone.utc).astimezone(zone).replace(tzinfo=None) == wall:
            found[candidate.timestamp()] = candidate
    return [found[key] for key in sorted(found)]


def _workspace_repair_old_dst(d):
    # Earlier Hermes versions could persist a shifted instant across DST.
    # Check the previous calculator against the stored value before repairing.
    if _cron_next_run_matches_expr(d.schedule, d.next_run_dt) or not _ensure_croniter():
        return False
    base = _parse_aware(d.job.get("last_run_at") or d.job.get("created_at"))
    if base is None or base.utcoffset() == d.next_run_dt.utcoffset():
        return False
    try:
        legacy = croniter(d.schedule["expr"], base).get_next(datetime)
        if legacy.timestamp() != d.raw_next_run_dt.timestamp():
            return False
        corrected = compute_next_run(d.schedule, base.isoformat())
        if corrected and corrected != d.next_run:
            d.scan.persist(d.job["id"], next_run_at=corrected)
            return True
    except (ValueError, OverflowError, KeyError):
        pass
    return False


def workspace_snapshot():
    """Read-only phone projection; unlike load_jobs it never repairs a store."""
    path = _current_cron_store().jobs_file
    if not path.exists():
        return []
    with path.open("rb") as stream:
        data = stream.read(8000001)
    if len(data) > 8000000:
        raise ValueError("job_store_too_large")
    rows = json.loads(data.decode("utf-8-sig"))["jobs"]
    if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
        raise ValueError("job_store_requires_repair")
    from cron.executions import latest_workspace_executions
    latest = latest_workspace_executions([row["id"] for row in rows])
    return [dict(_normalize_job_record(row), latest_execution=latest.get(row["id"])) for row in rows]
'''
    ast.parse(source)
    return source


def prepare_scheduler(source):
    if "phone_workspace.record_session(" in source:
        return source
    changes = [
        (
            "    runtime = setup.runtime\n",
            "    from cron.phone_workspace import clarify_callback\n    runtime = setup.runtime\n",
        ),
        (
            "        session_db=session_db,\n",
            "        session_db=session_db,\n        clarify_callback=clarify_callback(session_id),\n",
        ),
        (
            '    execution_id = str(job["execution_id"])\n    external_owner =',
            '    execution_id = str(job["execution_id"])\n    from cron.phone_workspace import ExecutionCancellation\n    cancel_event = _CombinedCancelEvent(cancel_event, ExecutionCancellation(execution_id))\n    external_owner =',
        ),
        (
            "    _cron_session_id = f\"cron_{job_id}_{_hermes_now().strftime('%Y%m%d_%H%M%S')}\"\n",
            "    _cron_session_id = f\"cron_{job_id}_{execution_id or _hermes_now().strftime('%Y%m%d_%H%M%S')}\"\n    from cron import phone_workspace\n    phone_workspace.record_session(job_id, execution_id, _cron_session_id)\n",
        ),
        (
            '        output_file = save_job_output(job["id"], output)\n',
            '        output_file = save_job_output(job["id"], output, execution_id=job.get("execution_id"))\n        from cron.phone_workspace import record_output\n        record_output(job["id"], job.get("execution_id"), output_file)\n',
        ),
        (
            "        _session_db.end_session(_final_cron_session_id, _end_reason)\n",
            "        from cron.phone_workspace import record_session_alias\n        record_session_alias(cron_session_id, _final_cron_session_id)\n        _session_db.end_session(_final_cron_session_id, _end_reason)\n",
        ),
    ]
    for before, after in changes:
        if source.count(before) != 1:
            raise ValueError("unsupported_scheduler_source")
        source = source.replace(before, after, 1)
    ast.parse(source)
    return source


def prepare_executions(source):
    tree = ast.parse(source)
    node = next(
        node
        for node in tree.body
        if isinstance(node, ast.FunctionDef) and node.name == "_emit_execution_state"
    )
    insertion = node.body[0].end_lineno
    lines = source.splitlines(keepends=True)
    lines[insertion:insertion] = [
        "    try:\n",
        "        from cron.phone_workspace import record_finished\n",
        "        record_finished(record)\n",
        "    except Exception:\n",
        "        pass  # The result projection cannot change native execution outcomes.\n",
    ]
    result = (
        "".join(lines)
        + r'''

_WORKSPACE_EXECUTION_CLOCK = """
    CAST(strftime('%s', substr(claimed_at,1,19) ||
        CASE WHEN substr(claimed_at,-6,1) IN ('+','-')
            THEN substr(claimed_at,-6) ELSE 'Z' END) AS INTEGER) AS epoch,
    CASE WHEN substr(claimed_at,20,1)='.'
        THEN CAST('0' || substr(claimed_at,20,7) AS REAL)
        ELSE 0 END AS fraction
"""
_WORKSPACE_EXECUTION_ORDER = "epoch DESC, fraction DESC, id DESC"


def latest_workspace_executions(job_ids):
    """Load each job's last attempt using the same clock as its history."""
    if not job_ids:
        return {}
    placeholders = ",".join("?" for _ in job_ids)
    with _transaction() as conn:
        rows = conn.execute(
            f"""WITH ordered AS (
                SELECT id, job_id, {_WORKSPACE_EXECUTION_CLOCK}
                FROM executions WHERE job_id IN ({placeholders})
            ), ranked AS (
                SELECT id, row_number() OVER (
                    PARTITION BY job_id ORDER BY {_WORKSPACE_EXECUTION_ORDER}
                ) AS rank FROM ordered
            )
            SELECT executions.* FROM ranked JOIN executions USING (id)
            WHERE ranked.rank=1""", job_ids
        ).fetchall()
    return {row["job_id"]: dict(row) for row in rows}

def list_workspace_executions(*, job_id, limit=500, before=None):
    """Chronological keyset history, including runs with equal clock timestamps."""
    from datetime import datetime

    args = [str(job_id)]
    cursor = ""
    if before is not None:
        if isinstance(before, str):
            before = {"claimedAt": before, "id": ""}
        if not isinstance(before, dict) or not all(
            isinstance(before.get(key), str) for key in ("claimedAt", "id")
        ):
            raise ValueError("invalid_history_cursor")
        instant = datetime.fromisoformat(before["claimedAt"])
        if instant.tzinfo is None:
            raise ValueError("invalid_history_cursor")
        stamp = instant.timestamp()
        from math import floor
        epoch = floor(stamp)
        cursor = " WHERE (epoch, fraction, id) < (?, ?, ?)"
        args.extend([epoch, instant.microsecond / 1000000, before["id"]])
    args.append(max(1, min(int(limit), 500)))
    with _transaction() as conn:
        rows = conn.execute(
            f"""WITH ordered AS (
                SELECT *, {_WORKSPACE_EXECUTION_CLOCK} FROM executions WHERE job_id=?
            ) SELECT * FROM ordered{cursor} ORDER BY {_WORKSPACE_EXECUTION_ORDER} LIMIT ?""",
            args,
        ).fetchall()
    return [dict(row) for row in rows]
'''
    )
    ast.parse(result)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source_root", type=Path)
    parser.add_argument("--output-root", type=Path, required=True)
    args = parser.parse_args()
    source, output = args.source_root.resolve(), args.output_root.resolve()
    if output == source or source in output.parents:
        parser.error("output must be outside the Hermes source; no live-install edits")
    lock = json.loads(
        (
            Path(__file__).parent.parent / "hermes-public" / "compatibility.json"
        ).read_text()
    )
    from prepare_hermes_inbox_source import prepare, prepare_approvals

    prepared = {}
    receipt = {"hermesCommit": COMMIT, "installed": False, "files": {}}
    for name, transform in (
        ("cron/jobs.py", prepare_jobs),
        ("cron/scheduler.py", prepare_scheduler),
        ("cron/executions.py", prepare_executions),
        ("tools/clarify_gateway.py", prepare),
        ("tools/approval.py", prepare_approvals),
    ):
        original = (source / name).read_bytes()
        if hashlib.sha256(original).hexdigest() != lock["sources"][name]:
            raise ValueError(f"source_revision_not_pinned: {name}")
        result = transform(original.decode()).encode()
        prepared[name] = result
        receipt["files"][name] = hashlib.sha256(result).hexdigest()
    name = "cron/phone_workspace.py"
    data = (Path(__file__).parent.parent / "hermes-public" / name).read_bytes()
    ast.parse(data)
    prepared[name] = data
    receipt["files"][name] = hashlib.sha256(data).hexdigest()
    prepared["workspace-receipt.json"] = (json.dumps(receipt, indent=2) + "\n").encode()
    for name in prepared:
        target = output / name
        if target.is_symlink() or not target.resolve().is_relative_to(output):
            raise ValueError("output_must_not_contain_symlinks")
    for name, data in prepared.items():
        target = output / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    print(json.dumps(receipt))


if __name__ == "__main__":
    main()
