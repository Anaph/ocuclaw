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
    source += '''\n\n@contextlib.contextmanager
def workspace_transaction():
    """Public transaction shared with CLI, Desktop and scheduler mutations."""
    with _jobs_lock(require_file_lock=True):
        yield


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
    from cron.executions import latest_executions
    latest = latest_executions([row["id"] for row in rows])
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
            "    _cron_session_id = f\"cron_{job_id}_{_hermes_now().strftime('%Y%m%d_%H%M%S')}\"\n    from cron import phone_workspace\n    phone_workspace.record_session(job_id, execution_id, _cron_session_id)\n",
        ),
        (
            '        output_file = save_job_output(job["id"], output)\n',
            '        output_file = save_job_output(job["id"], output)\n        from cron.phone_workspace import record_output\n        record_output(job["id"], job.get("execution_id"), output_file)\n',
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
    result = "".join(lines)
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
