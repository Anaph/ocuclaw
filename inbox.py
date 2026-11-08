"""Addressed, source-authoritative inbox. No pending question survives on disk.

Sources must implement snapshot(), get(id), resolve(id, answer), and capabilities.
Only completion records and operation receipts are persisted. A lost native answer
receipt is uncertain and is never replayed against a replacement question.
"""

from __future__ import annotations

import asyncio
import hashlib
import inspect
import json
import sqlite3
import threading
import time
from pathlib import Path

RETENTION_MS = 7 * 86400 * 1000
RESULT_PAGE_BYTES = 192 * 1024


async def resolved(value):
    return await value if inspect.isawaitable(value) else value


class Inbox:
    def __init__(self, path, source, now=lambda: int(time.time() * 1000)):
        self.source, self.now = source, now
        self._lock = threading.RLock()
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path, check_same_thread=False)
        path.chmod(0o600)
        self.db.executescript("""
          CREATE TABLE IF NOT EXISTS completions (
            id TEXT PRIMARY KEY, created INTEGER NOT NULL, payload TEXT NOT NULL,
            read INTEGER NOT NULL DEFAULT 0, namespace TEXT NOT NULL DEFAULT '');
          CREATE TABLE IF NOT EXISTS operations (
            id TEXT PRIMARY KEY, created INTEGER NOT NULL, fingerprint TEXT NOT NULL,
            result TEXT NOT NULL);
        """)
        # Upgrade 0.1.0 stores without dropping results or their read receipts.
        columns = {row[1] for row in self.db.execute("PRAGMA table_info(completions)")}
        if "namespace" not in columns:
            self.db.execute(
                "ALTER TABLE completions ADD COLUMN namespace TEXT NOT NULL DEFAULT ''"
            )
            for identity, payload in self.db.execute(
                "SELECT id,payload FROM completions"
            ).fetchall():
                self.db.execute(
                    "UPDATE completions SET namespace=? WHERE id=?",
                    (
                        self._namespace(json.loads(payload).get("sessionKey", "")),
                        identity,
                    ),
                )
        self.db.execute(
            "CREATE INDEX IF NOT EXISTS completion_scope_order ON completions(namespace,created DESC,id DESC)"
        )
        self.db.commit()
        self._mutation = asyncio.Lock()
        self._known = {}

    def close(self):
        with self._lock:
            self.db.close()

    def completion(self, item):
        """Idempotent append; id must identify a native run, never a delivery."""
        if not all(
            isinstance(item.get(k), str) and item[k] for k in ("id", "sessionKey")
        ):
            return
        with self._lock, self.db:
            self.db.execute(
                "INSERT OR IGNORE INTO completions (id,created,payload,read,namespace) VALUES (?,?,?,0,?)",
                (
                    item["id"],
                    self.now(),
                    json.dumps(item, ensure_ascii=False),
                    self._namespace(item["sessionKey"]),
                ),
            )

    @staticmethod
    def _namespace(key):
        parts = key.split(":", 2)
        return parts[1] if len(parts) == 3 and parts[0] == "hermes" else ""

    def _scope(self):
        namespaces = getattr(self.source, "namespaces", None)
        if namespaces is None:
            return "1=1", []  # Source implementations without profile multiplexing.
        try:
            allowed = sorted(set(namespaces()))
        except Exception:
            allowed = []  # Losing the routing table must narrow the projection.
        return "namespace IN (" + ",".join("?" for _ in allowed) + ")", allowed

    def _prune(self):
        cutoff = self.now() - RETENTION_MS
        with self._lock, self.db:
            self.db.execute("DELETE FROM completions WHERE created < ?", (cutoff,))
            self.db.execute("DELETE FROM operations WHERE created < ?", (cutoff,))

    async def snapshot(self, _params=None):
        self._prune()
        try:
            items = await resolved(self.source.snapshot())
            available = True
        except Exception:
            items, available = [], False
        now = self.now()
        pending = [
            dict(x)
            for x in items
            if x.get("expiresAtMs") is None or x["expiresAtMs"] > now
        ]
        for item in pending:
            self._known[item["id"]] = item
        while len(self._known) > 4096:
            self._known.pop(next(iter(self._known)))
        pending.sort(
            key=lambda x: (
                x.get("expiresAtMs") or float("inf"),
                x.get("createdAtMs", 0),
                x["id"],
            )
        )
        done = await self.completed({})
        return {
            "version": 1,
            "observedAtMs": now,
            "available": available,
            "capabilities": self.source.capabilities(),
            "authorizedNamespaces": self._scope()[1]
            if hasattr(self.source, "namespaces")
            else None,
            "pending": pending,
            "completed": done["items"],
            "completedNextBefore": done["nextBefore"],
            "completedTotal": done["total"],
            "unreadCompleted": done["unread"],
        }

    async def completed(self, params):
        self._prune()
        before = params.get("before")
        scope, scope_args = self._scope()
        args = list(scope_args)
        where = " WHERE " + scope
        if before is not None:
            if (
                not isinstance(before, dict)
                or type(before.get("createdAtMs")) is not int
                or not isinstance(before.get("id"), str)
            ):
                raise ValueError("invalid_result_cursor")
            where += " AND (created < ? OR (created = ? AND id < ?))"
            args = args + [before["createdAtMs"], before["createdAtMs"], before["id"]]
        with self._lock:
            rows = list(
                self.db.execute(
                    "SELECT payload,read,created FROM completions"
                    + where
                    + " ORDER BY created DESC,id DESC LIMIT 101",
                    args,
                )
            )
            total, unread = self.db.execute(
                "SELECT count(*), coalesce(sum(read=0),0) FROM completions WHERE "
                + scope,
                scope_args,
            ).fetchone()
        items, used = [], 0
        for row in rows[:100]:
            item = dict(json.loads(row[0]), read=bool(row[1]), createdAtMs=row[2])
            size = len(json.dumps(item, ensure_ascii=False).encode("utf-8"))
            if items and used + size > RESULT_PAGE_BYTES:
                break
            items.append(item)
            used += size
        cursor = (
            {"id": items[-1]["id"], "createdAtMs": items[-1]["createdAtMs"]}
            if len(rows) > len(items)
            else None
        )
        return {"items": items, "total": total, "unread": unread, "nextBefore": cursor}

    async def get(self, params):
        try:
            item = await resolved(self.source.get(str(params.get("id") or "")))
        except Exception:
            return {"status": "source_unavailable"}
        if item and item.get("sessionKey") != params.get("sessionKey"):
            return {"status": "not_found"}
        if not item:
            known = self._known.get(str(params.get("id") or ""))
            if known and known.get("sessionKey") != params.get("sessionKey"):
                return {"status": "not_found"}
            if (
                known
                and known.get("expiresAtMs") is not None
                and known["expiresAtMs"] <= self.now()
            ):
                return {"status": "expired"}
            return {"status": "already_answered" if known else "not_found"}
        self._known[item["id"]] = dict(item)
        if item.get("expiresAtMs") is not None and item["expiresAtMs"] <= self.now():
            return {"status": "expired"}
        return {"status": "pending", "item": item}

    async def operation(self, params):
        with self._lock:
            row = self.db.execute(
                "SELECT result FROM operations WHERE id=?", (params.get("operationId"),)
            ).fetchone()
        return json.loads(row[0]) if row else {"status": "not_found"}

    async def answer(self, params):
        op, key, item_id = (params.get(k) for k in ("operationId", "sessionKey", "id"))
        answer = params.get("answer")
        if not all(
            isinstance(x, str) and 0 < len(x) <= 512 for x in (op, key, item_id)
        ):
            raise ValueError("invalid_answer_identity")
        if not isinstance(answer, dict):
            raise ValueError("invalid_answer")
        fingerprint = hashlib.sha256(
            json.dumps([key, item_id, answer], sort_keys=True).encode()
        ).hexdigest()
        async with self._mutation:
            with self._lock:
                row = self.db.execute(
                    "SELECT fingerprint,result FROM operations WHERE id=?", (op,)
                ).fetchone()
            if row:
                if row[0] != fingerprint:
                    raise ValueError("operation_identity_conflict")
                return json.loads(row[1])
            try:
                current = await self.get({"id": item_id, "sessionKey": key})
            except Exception:
                return {"status": "source_unavailable"}
            if current["status"] != "pending":
                return current
            item = current["item"]
            self._validate(item, answer)
            # Persist BEFORE crossing the side-effect boundary. Crash => uncertain.
            with self._lock, self.db:
                self.db.execute(
                    "INSERT INTO operations VALUES (?,?,?,?)",
                    (op, self.now(), fingerprint, json.dumps({"status": "uncertain"})),
                )
            try:
                result = await resolved(self.source.resolve(item_id, answer))
            except Exception:
                result = {"status": "uncertain"}
            with self._lock, self.db:
                self.db.execute(
                    "UPDATE operations SET result=? WHERE id=?",
                    (json.dumps(result), op),
                )
            return result

    @staticmethod
    def _validate(item, answer):
        if item["kind"] == "permission":
            if set(answer) != {"decision"} or answer["decision"] not in item.get(
                "allowedDecisions", []
            ):
                raise ValueError("invalid_permission_decision")
            return
        if set(answer) == {"text"}:
            if (
                not isinstance(answer["text"], str)
                or not answer["text"].strip()
                or len(answer["text"]) > 16000
            ):
                raise ValueError("invalid_text")
            if item.get("choices") and not item.get("allowOther"):
                raise ValueError("free_text_not_allowed")
        elif set(answer) == {"indices"}:
            indices, choices = answer["indices"], item.get("choices", [])
            if (
                not isinstance(indices, list)
                or not indices
                or any(
                    type(i) is not int or i < 0 or i >= len(choices) for i in indices
                )
                or len(set(indices)) != len(indices)
                or (not item.get("multiSelect") and len(indices) != 1)
            ):
                raise ValueError("invalid_selection")
        else:
            raise ValueError("invalid_answer")

    async def read(self, params):
        scope, args = self._scope()
        with self._lock, self.db:
            self.db.execute(
                "UPDATE completions SET read=1 WHERE id=? AND " + scope,
                [params.get("id"), *args],
            )
        return {"status": "accepted"}

    def handlers(self):
        return {
            "inbox.snapshot": self.snapshot,
            "inbox.completed": self.completed,
            "inbox.get": self.get,
            "inbox.answer": self.answer,
            "inbox.operation": self.operation,
            "inbox.read": self.read,
        }
