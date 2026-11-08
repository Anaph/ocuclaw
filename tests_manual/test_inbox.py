"""Real SQLite receipts + authoritative fake Hermes, including lost acknowledgments."""

import asyncio
import importlib.util
import pathlib
import tempfile

spec = importlib.util.spec_from_file_location(
    "inbox", pathlib.Path(__file__).resolve().parents[1] / "inbox.py"
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class Source:
    def __init__(self):
        self.items = {
            str(i): {
                "id": str(i),
                "sessionKey": f"hermes:main:{i}",
                "kind": "question",
                "question": "Как продолжить?",
                "choices": ["Да", "Нет"],
                "allowOther": True,
                "multiSelect": False,
                "createdAtMs": i,
                "expiresAtMs": 10000 + i,
            }
            for i in range(3)
        }
        self.calls = []
        self.fail = False

    def capabilities(self):
        return {"allGatewayQuestions": True}

    def snapshot(self):
        if self.fail:
            raise RuntimeError("offline")
        return list(self.items.values())

    def get(self, key):
        if self.fail:
            raise RuntimeError("offline")
        return self.items.get(key)

    async def resolve(self, key, answer):
        self.calls.append((key, answer))
        self.items.pop(key, None)
        return {"status": "accepted"}


async def test():
    with tempfile.TemporaryDirectory() as directory:
        path = pathlib.Path(directory) / "inbox.sqlite"
        now = [1000]
        source = Source()
        inbox = module.Inbox(path, source, lambda: now[0])
        snapshot = await inbox.snapshot()
        assert len(snapshot["pending"]) == 3
        p = {
            "id": "1",
            "sessionKey": "hermes:main:1",
            "operationId": "op1",
            "answer": {"indices": [0]},
        }
        assert (await inbox.answer(dict(p, sessionKey="hermes:main:2")))[
            "status"
        ] == "not_found"
        assert not source.calls
        result = await inbox.answer(p)
        assert result["status"] == "accepted"
        assert await inbox.answer(p) == result and len(source.calls) == 1
        assert (await inbox.get(p))["status"] == "already_answered"
        try:
            await inbox.answer(dict(p, answer={"text": "Different"}))
        except ValueError:
            pass
        else:
            raise AssertionError("idempotency conflict accepted")
        # A native success followed by a lost ack must never be replayed.
        original_resolve = source.resolve

        async def lose_ack(key, answer):
            await original_resolve(key, answer)
            raise RuntimeError("lost reply")

        source.resolve = lose_ack
        uncertain = dict(p, id="0", sessionKey="hermes:main:0", operationId="uncertain")
        assert (await inbox.answer(uncertain))["status"] == "uncertain"
        assert (await inbox.answer(uncertain))["status"] == "uncertain"
        assert len(source.calls) == 2
        source.resolve = original_resolve
        now[0] = 20000
        assert (
            await inbox.answer(
                dict(p, id="2", sessionKey="hermes:main:2", operationId="late")
            )
        )["status"] == "expired"
        assert len(source.calls) == 2
        source.fail = True
        assert not (await inbox.snapshot())["available"]
        assert (
            await inbox.answer(
                dict(p, id="0", sessionKey="hermes:main:0", operationId="offline")
            )
        )["status"] == "source_unavailable"
        source.fail = False
        now[0] = 1000
        inbox.completion(
            {"id": "run1", "sessionKey": "hermes:main:1", "summary": "Готово"}
        )
        inbox.completion(
            {"id": "run1", "sessionKey": "hermes:main:1", "summary": "Duplicate"}
        )
        assert len((await inbox.snapshot())["completed"]) == 1
        await inbox.read({"id": "run1"})
        inbox.close()
        restarted = module.Inbox(path, source, lambda: now[0])
        assert (await restarted.snapshot())["completed"][0]["read"]
        assert await restarted.answer(p) == result and len(source.calls) == 2
        assert len((await restarted.snapshot())["pending"]) == 1
        now[0] += module.RETENTION_MS + 1
        assert not (await restarted.snapshot())["completed"]
        restarted.close()


asyncio.run(test())
print("test_inbox OK")
