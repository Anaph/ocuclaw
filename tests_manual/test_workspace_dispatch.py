"""A lost send acknowledgment and a process restart cannot dispatch twice."""

import asyncio
import importlib.util
from pathlib import Path
import tempfile

spec = importlib.util.spec_from_file_location(
    "workspace_dispatch", Path(__file__).resolve().parents[1] / "workspace_dispatch.py"
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


async def check():
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "sends.sqlite"
        calls = []

        async def dispatch(params):
            calls.append(params)
            return {"status": "accepted", "runId": "run-1"}

        params = {
            "workspaceOperationId": "send-1",
            "sessionKey": "hermes:main:a",
            "message": "Текст",
            "target": {"ns": "main", "chatId": "a"},
        }
        store = module.WorkspaceDispatch(path)
        result = await store.send(params, dispatch, lambda _: None)
        assert result["status"] == "accepted"
        store.db.close()
        store = module.WorkspaceDispatch(path)
        assert await store.send(params, dispatch, lambda _: None) == result
        assert len(calls) == 1
        assert (
            await store.receipt(
                {"operationId": "send-1", "sessionKey": "hermes:main:a"}
            )
        )["status"] == "accepted"
        assert (
            await store.receipt(
                {"operationId": "send-1", "sessionKey": "hermes:main:b"}
            )
        )["status"] == "not_found"
        try:
            await store.send(
                dict(params, message="Другой текст"), dispatch, lambda _: None
            )
            raise AssertionError("reused operation id accepted another message")
        except ValueError:
            pass

        async def lost(params):
            calls.append(params)
            raise RuntimeError("lost ack")

        unknown = dict(params, workspaceOperationId="send-2")
        assert (await store.send(unknown, lost, lambda _: None))[
            "status"
        ] == "uncertain"
        assert (await store.send(unknown, lost, lambda _: None))[
            "status"
        ] == "uncertain"
        assert len(calls) == 2
        store.db.close()


asyncio.run(check())
print("test_workspace_dispatch OK")
