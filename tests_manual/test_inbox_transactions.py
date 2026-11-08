"""Concurrency, permission validation, expired source entries and result pagination."""

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
        self.calls = 0
        self.items = {
            "p": {
                "id": "p",
                "sessionKey": "hermes:main:a",
                "kind": "permission",
                "allowedDecisions": ["allow-once", "deny"],
                "expiresAtMs": 10000,
                "createdAtMs": 0,
            }
        }

    def snapshot(self):
        return list(self.items.values())

    def get(self, key):
        return self.items.get(key)

    def capabilities(self):
        return {}

    async def resolve(self, key, answer):
        self.calls += 1
        await asyncio.sleep(0)
        self.items.pop(key, None)
        return {"status": "accepted"}


async def test():
    with tempfile.TemporaryDirectory() as directory:
        now = [1000]
        source = Source()
        inbox = module.Inbox(
            pathlib.Path(directory) / "state.sqlite", source, lambda: now[0]
        )
        p = {
            "id": "p",
            "sessionKey": "hermes:main:a",
            "operationId": "op",
            "answer": {"decision": "allow-always"},
        }
        try:
            await inbox.answer(p)
        except ValueError:
            pass
        else:
            raise AssertionError("unsupported permission scope accepted")
        assert source.calls == 0
        p["answer"] = {"decision": "allow-once"}
        assert all(
            x["status"] == "accepted"
            for x in await asyncio.gather(inbox.answer(p), inbox.answer(p))
        )
        assert source.calls == 1
        for i in range(250):
            inbox.completion(
                {
                    "id": f"result:{i:03}",
                    "sessionKey": "hermes:main:a",
                    "summary": "Готово",
                }
            )
        first = await inbox.completed({})
        assert len(first["items"]) == 100 and first["unread"] == 250
        ids = [x["id"] for x in first["items"]]
        cursor = first["nextBefore"]
        while cursor:
            page = await inbox.completed({"before": cursor})
            ids.extend(x["id"] for x in page["items"])
            cursor = page["nextBefore"]
        assert len(ids) == len(set(ids)) == 250
        await inbox.read({"id": ids[-1]})
        assert (await inbox.completed({}))["unread"] == 249
        source.items["expired"] = {
            "id": "expired",
            "sessionKey": "hermes:main:a",
            "kind": "question",
            "expiresAtMs": 2000,
        }
        await inbox.snapshot()
        source.items.pop("expired")
        now[0] = 3000
        assert (await inbox.get({"id": "expired", "sessionKey": "hermes:main:a"}))[
            "status"
        ] == "expired"
        inbox.close()


asyncio.run(test())
print("test_inbox_transactions OK")
