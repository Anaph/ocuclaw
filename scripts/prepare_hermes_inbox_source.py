#!/usr/bin/env python3
"""Prepare a reviewed Hermes public-source extension; never edit a live install.

Usage: python3 scripts/prepare_hermes_inbox_source.py /path/tools/clarify_gateway.py --output /tmp/clarify_gateway.py
The output and its SHA-256 receipt must be deployed with the tested Hermes version.
"""

import argparse
import ast
import hashlib
import json
from pathlib import Path


def prepare(text):
    if "def list_pending(" in text:
        return text
    # Deliberately strict anchors: an upstream layout change needs a review.
    fields = "    awaiting_text: bool = False"
    deadline = "    activity_state = "
    if (
        fields not in text
        or deadline not in text
        or "def wait_for_response(" not in text
    ):
        raise ValueError("unsupported_hermes_source")
    start = text.index(fields)
    end = text.index("\n", start)
    text = (
        text[:end]
        + "\n    created_at_ms: int = field(default_factory=lambda: int(time.time() * 1000))\n    expires_at_ms: Optional[int] = None"
        + text[end:]
    )
    pos = text.index(deadline, text.index("def wait_for_response("))
    text = (
        text[:pos]
        + "    entry.expires_at_ms = None if timeout is None or float(timeout) <= 0 else int(time.time() * 1000 + float(timeout) * 1000)\n"
        + text[pos:]
    )
    text += '''\n\ndef list_pending() -> list[_ClarifyEntry]:
    """Public, read-only snapshot across this gateway process.

    Consumers must enforce profile admission and recheck get_pending(id) at
    answer time. Events and deadlines remain owned by the waiting tool.
    """
    with _lock:
        return [entry for entry in _entries.values() if not entry.event.is_set()]
'''
    ast.parse(text)
    return text


def prepare_approvals(text):
    if "def list_pending_gateway_approvals(" in text:
        return text
    tree = ast.parse(text)
    resolver = next(
        (
            node
            for node in tree.body
            if isinstance(node, ast.FunctionDef)
            and node.name == "resolve_gateway_approval"
        ),
        None,
    )
    if resolver is None or "request_id" not in [
        arg.arg for arg in resolver.args.args + resolver.args.kwonlyargs
    ]:
        raise ValueError("addressed_approval_resolution_not_supported")
    if "_gateway_queues" not in text:
        raise ValueError("unsupported_hermes_source")
    text += '''\n\ndef list_pending_gateway_approvals() -> list[dict]:
    """Public snapshot; consumers must enforce profile admission and resolve by request_id."""
    with _lock:
        return [dict(entry.data, session_key=key)
                for key, queue in _gateway_queues.items() for entry in queue
                if not entry.event.is_set()]
'''
    ast.parse(text)
    return text


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("source", type=Path)
    p.add_argument("--output", type=Path, required=True)
    a = p.parse_args()
    if a.source.resolve() == a.output.resolve():
        p.error("output must differ from source (no live-install edits)")
    original = a.source.read_text()
    result = (
        prepare_approvals(original)
        if a.source.name == "approval.py"
        else prepare(original)
    )
    a.output.write_text(result)
    print(
        json.dumps(
            {
                "inputSha256": hashlib.sha256(original.encode()).hexdigest(),
                "outputSha256": hashlib.sha256(result.encode()).hexdigest(),
                "output": str(a.output),
                "installed": False,
            }
        )
    )


if __name__ == "__main__":
    main()
