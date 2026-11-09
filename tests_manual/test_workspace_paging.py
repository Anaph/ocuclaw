"""Workspace pages remain bounded and use one profile scope per response."""

import asyncio
from pathlib import Path
import sys
import tempfile
import types
from unittest.mock import patch

package = types.ModuleType("ocuclaw")
package.__path__ = [str(Path(__file__).resolve().parents[1])]
sys.modules["ocuclaw"] = package

from ocuclaw.control_link import encode_link_frame
from ocuclaw.inbox import Inbox
from ocuclaw.session_rpc import SessionRpc


def assert_wire_safe(result):
    frame = {
        "v": 1,
        "type": "link.rpc.response",
        "id": "qa",
        "ok": True,
        "result": result,
    }
    _, truncated = encode_link_frame(frame)
    assert not truncated


async def run(root):
    rpc = SessionRpc(root / "state.db")
    rows = [
        {"id": i, "role": "assistant", "content": "Д" * 30_000} for i in range(1, 32)
    ]
    with (
        patch.object(rpc, "_resolve_target", return_value="session"),
        patch.object(rpc, "_conversation_rows_with_identity", return_value=rows),
    ):
        seen = []
        before = None
        while True:
            reply = await rpc.chat_history(
                {
                    "limit": 30,
                    "workspaceBounded": True,
                    "beforeId": before,
                }
            )
            assert_wire_safe(reply)
            seen[:0] = [row["id"] for row in reply["messages"]]
            if not reply["hasMore"]:
                break
            before = reply["nextBeforeId"]
            assert len(seen) < 31
        assert seen == list(range(1, 32))
        legacy = await rpc.chat_history({"limit": 30})
        assert len(legacy["messages"]) == 30
    rpc.close()

    read_complete, resume = asyncio.Event(), asyncio.Event()

    def question(number, ns="main"):
        return {
            "id": str(number),
            "kind": "question",
            "sessionKey": f"hermes:{ns}:qa",
            "agentName": "Hermes",
            "sessionTitle": "QA",
            "question": "Д" * 30_000,
            "createdAtMs": number,
            "expiresAtMs": None,
        }

    class Source:
        allowed = ["main", "research"]
        questions = [question(i) for i in range(20)] + [question(21, "research")]

        def namespaces(self):
            return self.allowed

        def capabilities(self):
            return {}

        def snapshot(self):
            return self.questions

        async def completions(self):
            read_complete.set()
            await resume.wait()
            return []

    source = Source()
    inbox = Inbox(root / "inbox.sqlite", source)
    collecting = asyncio.create_task(inbox.snapshot())
    await asyncio.wait_for(read_complete.wait(), timeout=2)
    source.allowed = ["main"]
    resume.set()
    snapshot = await asyncio.wait_for(collecting, timeout=2)
    assert snapshot["authorizedNamespaces"] == ["main"]
    seen = []
    while True:
        assert_wire_safe(snapshot)
        seen.extend(item["id"] for item in snapshot["pending"])
        assert all(len(item["question"]) == 30000 for item in snapshot["pending"])
        cursor = snapshot["pendingNextBefore"]
        if cursor is None:
            break
        snapshot = await inbox.pending({"before": cursor})
        assert len(seen) < 20
    assert seen == [str(i) for i in range(20)]
    assert await inbox.get({"id": "21", "sessionKey": "hermes:research:qa"}) == {
        "status": "not_found"
    }
    inbox.close()


with tempfile.TemporaryDirectory() as directory:
    asyncio.run(run(Path(directory)))
print("test_workspace_paging OK")
