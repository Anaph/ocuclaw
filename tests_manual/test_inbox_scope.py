"""Revoked profiles cannot be read from persisted results, including a 0.1.0 DB."""

import asyncio
import importlib.util
import json
import pathlib
import sqlite3
import tempfile

spec = importlib.util.spec_from_file_location(
    "inbox", pathlib.Path(__file__).resolve().parents[1] / "inbox.py"
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class Source:
    allowed = {"main", "private"}

    def namespaces(self):
        return self.allowed

    def snapshot(self):
        return []

    def capabilities(self):
        return {}


async def test():
    with tempfile.TemporaryDirectory() as directory:
        path = pathlib.Path(directory) / "old.sqlite"
        db = sqlite3.connect(path)
        db.execute(
            "CREATE TABLE completions (id TEXT PRIMARY KEY,created INTEGER NOT NULL,payload TEXT NOT NULL,read INTEGER NOT NULL DEFAULT 0)"
        )
        for i, ns in enumerate(("main", "private")):
            item = {
                "id": str(i),
                "sessionKey": f"hermes:{ns}:session",
                "summary": "Private result",
            }
            db.execute(
                "INSERT INTO completions VALUES (?,?,?,0)",
                (str(i), 1000, json.dumps(item)),
            )
        db.commit()
        db.close()
        source = Source()
        inbox = module.Inbox(path, source, lambda: 2000)
        assert (await inbox.completed({}))["total"] == 2
        source.allowed = {"main"}
        page = await inbox.completed({})
        assert page["total"] == page["unread"] == 1
        assert [x["sessionKey"] for x in page["items"]] == ["hermes:main:session"]
        await inbox.read({"id": "1"})
        assert (
            inbox.db.execute('SELECT read FROM completions WHERE id="1"').fetchone()[0]
            == 0
        )
        snapshot = await inbox.snapshot()
        assert snapshot["authorizedNamespaces"] == ["main"]
        source.allowed = set()
        assert not (await inbox.completed({}))["items"]
        inbox.close()


asyncio.run(test())
print("test_inbox_scope OK")
