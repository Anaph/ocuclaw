"""Durable admission receipts for opt-in Workspace sends; no agent execution here."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import re
import sqlite3
import time
from pathlib import Path


class WorkspaceDispatch:
    def __init__(self, path):
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path)
        path.chmod(0o600)
        self.db.execute(
            "CREATE TABLE IF NOT EXISTS sends (id TEXT PRIMARY KEY,session TEXT NOT NULL,fingerprint TEXT NOT NULL,result TEXT NOT NULL,created REAL NOT NULL)"
        )
        self.db.commit()
        self.lock = asyncio.Lock()

    @staticmethod
    def fingerprint(params):
        media = []
        for item in params.get("attachments") or []:
            if item.get("path"):
                path = Path(item["path"])
                if not path.name.startswith("ocuclaw-attach-") or path.is_symlink():
                    raise ValueError("invalid_attachment_spill")
                with path.open("rb") as stream:
                    hasher = hashlib.sha256()
                    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                        hasher.update(chunk)
                    digest = hasher.hexdigest()
            else:
                digest = hashlib.sha256(
                    base64.b64decode(item.get("content") or "", validate=True)
                ).hexdigest()
            media.append([item.get("fileName"), item.get("mimeType"), digest])
        return hashlib.sha256(
            json.dumps(
                [
                    params.get("sessionKey"),
                    params.get("target"),
                    params.get("message"),
                    media,
                ],
                sort_keys=True,
            ).encode()
        ).hexdigest()

    async def send(self, params, dispatch, discard):
        operation = params.get("workspaceOperationId")
        if not isinstance(operation, str) or not re.fullmatch(
            r"[A-Za-z0-9_-]{1,128}", operation
        ):
            raise ValueError("invalid_operation_id")
        try:
            fingerprint = await asyncio.to_thread(self.fingerprint, params)
        except Exception:
            discard(params.get("attachments"))
            raise
        async with self.lock:
            previous = self.db.execute(
                "SELECT session,fingerprint,result FROM sends WHERE id=?", (operation,)
            ).fetchone()
            if previous:
                discard(params.get("attachments"))
                if previous[1] != fingerprint:
                    raise ValueError("operation_conflict")
                return json.loads(previous[2])
            with self.db:
                self.db.execute(
                    "INSERT INTO sends VALUES (?,?,?,?,?)",
                    (
                        operation,
                        params.get("sessionKey", ""),
                        fingerprint,
                        json.dumps({"status": "uncertain"}),
                        time.time(),
                    ),
                )
            forwarded = {k: v for k, v in params.items() if k != "workspaceOperationId"}
            try:
                result = await dispatch(forwarded)
            except Exception:
                discard(params.get("attachments"))
                return {"status": "uncertain"}
            with self.db:
                self.db.execute(
                    "UPDATE sends SET result=? WHERE id=?",
                    (json.dumps(result), operation),
                )
            return result

    async def receipt(self, params):
        async with self.lock:
            row = self.db.execute(
                "SELECT session,result FROM sends WHERE id=?",
                (params.get("operationId"),),
            ).fetchone()
            if not row or row[0] != params.get("sessionKey"):
                return {"status": "not_found"}
            return json.loads(row[1])
