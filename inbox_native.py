"""Native Hermes inbox source, using public APIs and existing approval mirror."""

import json
import inspect
import time


class NativeInboxSource:
    def __init__(self, adapter):
        self.adapter = adapter
        self.presentations = {}

    def remember(self, native_key, item):
        self.presentations[item["id"]] = dict(item, nativeKey=native_key)
        if len(self.presentations) > 2048:
            self.presentations.pop(next(iter(self.presentations)))

    @staticmethod
    def native():
        from tools import clarify_gateway

        return clarify_gateway

    @staticmethod
    def approvals_native():
        from tools import approval

        return approval

    def capabilities(self):
        try:
            native = self.native()
            all_sessions = callable(getattr(native, "list_pending", None))
        except ImportError:
            all_sessions = False
        try:
            approval = self.approvals_native()
            all_permissions = (
                callable(getattr(approval, "list_pending_gateway_approvals", None))
                and "request_id"
                in inspect.signature(approval.resolve_gateway_approval).parameters
            )
        except (ImportError, ValueError, AttributeError):
            all_permissions = False
        return {
            "addressedAnswers": True,
            "allGatewayQuestions": all_sessions,
            "coverage": "gateway" if all_sessions else "ocuclaw_only",
            "missing": [] if all_sessions else ["hermes_public_list_pending"],
            "permissions": "gateway" if all_permissions else "ocuclaw_mirror",
            "resultsRetentionDays": 7,
        }

    def _key(self, native_key):
        # The same admission table as the normal sessions plane. Never expose
        # a profile just because its pending request exists in this process.
        if native_key.startswith("agent:"):
            parts = native_key.split(":", 2)
            if len(parts) != 3:
                return None
            ns, rest = parts[1:]
            from .adapter import _load_profile_routing

            multiplex, routes = _load_profile_routing()
            if ns != "main" and (not multiplex or ns not in routes):
                return None
            return (
                self.adapter._public_key_for_native_session(native_key)
                or f"hermes:{ns}:x:{rest}"
            )
        # Desktop may use a raw transcript id instead of an agent-prefixed key.
        row = self.adapter._session_rpc.row_by_id(native_key) if native_key else None
        if row and row.get("source") in ("desktop", "cli", "tui"):
            return f"hermes:main:x:{row['source']}:{row['id']}"
        return None  # Never invent a binding for an unknown native identity.

    def _question(self, entry):
        if entry is None or entry.event.is_set():
            return None
        key = self._key(entry.session_key)
        if not key:
            return None
        remembered = self.presentations.get(entry.clarify_id, {})
        return {
            "id": "question:" + entry.clarify_id,
            "sourceId": entry.clarify_id,
            "sessionKey": key,
            "agentName": key.split(":")[1],
            "sessionTitle": key,
            "kind": "question",
            "question": entry.question,
            "choices": list(entry.choices or []),
            "multiSelect": bool(entry.multi_select),
            "allowOther": True,
            "createdAtMs": getattr(
                entry, "created_at_ms", remembered.get("createdAtMs", 0)
            ),
            "expiresAtMs": getattr(
                entry, "expires_at_ms", remembered.get("expiresAtMs")
            ),
        }

    def snapshot(self):
        native = self.native()
        enumerate_pending = getattr(native, "list_pending", None)
        if callable(enumerate_pending):
            entries = enumerate_pending()
        else:
            entries = [native.get_pending(key) for key in list(self.presentations)]
        out = [item for entry in entries if (item := self._question(entry)) is not None]
        now = int(time.time() * 1000)
        with self.adapter._approval_lock:
            approvals = list(self.adapter._approvals_by_id.values())
        for entry in approvals:
            if not self.adapter._approval_is_session_head(entry):
                continue
            key = self._key(entry["sessionKey"])
            if key and entry["expiresAtMs"] > now:
                out.append(
                    {
                        "id": "permission:" + entry["id"],
                        "sessionKey": key,
                        "agentName": key.split(":")[1],
                        "sessionTitle": key,
                        "kind": "permission",
                        "question": entry["command"] or entry["description"],
                        "allowedDecisions": list(entry["allowedDecisions"]),
                        "expiresAtMs": entry["expiresAtMs"],
                        "createdAtMs": 0,
                    }
                )
        try:
            approval = self.approvals_native()
            enumerate_approvals = getattr(
                approval, "list_pending_gateway_approvals", None
            )
            addressed = (
                "request_id"
                in inspect.signature(approval.resolve_gateway_approval).parameters
            )
            mirrored = {entry.get("requestId") for entry in approvals}
            if callable(enumerate_approvals) and addressed:
                for entry in enumerate_approvals():
                    request_id = entry.get("request_id")
                    key = self._key(str(entry.get("session_key") or ""))
                    if not key or not request_id or request_id in mirrored:
                        continue
                    out.append(
                        {
                            "id": "native-permission:" + request_id,
                            "sessionKey": key,
                            "nativeKey": entry["session_key"],
                            "sourceId": request_id,
                            "agentName": key.split(":")[1],
                            "sessionTitle": key,
                            "kind": "permission",
                            "question": entry.get("command")
                            or entry.get("description")
                            or "Approval required",
                            "allowedDecisions": ["allow-once", "deny"],
                            "expiresAtMs": entry.get("expires_at_ms"),
                            "createdAtMs": entry.get("created_at_ms", 0),
                        }
                    )
        except ImportError:
            pass
        return out

    def get(self, item_id):
        if item_id.startswith("question:"):
            return self._question(
                self.native().get_pending(item_id.removeprefix("question:"))
            )
        return next((x for x in self.snapshot() if x["id"] == item_id), None)

    async def resolve(self, item_id, answer):
        item = self.get(item_id)
        if not item:
            return {"status": "already_answered"}
        if item["expiresAtMs"] is not None and item["expiresAtMs"] <= int(
            time.time() * 1000
        ):
            return {"status": "expired"}
        if item_id.startswith("native-permission:"):
            # Never fall back to FIFO: request_id is mandatory for another surface.
            ok = self.approvals_native().resolve_gateway_approval(
                item["nativeKey"],
                "once" if answer["decision"] == "allow-once" else "deny",
                request_id=item["sourceId"],
            )
            return {"status": "accepted" if ok else "already_answered"}
        if item["kind"] == "permission":
            result = await self.adapter.handle_approval_resolve(
                {
                    "id": item_id.removeprefix("permission:"),
                    "decision": answer["decision"],
                }
            )
            return {
                "status": "accepted"
                if result.get("status") == "accepted"
                else "already_answered"
            }
        if "text" in answer:
            text = answer["text"].strip()
        else:
            labels = [item["choices"][i] for i in answer["indices"]]
            text = (
                json.dumps(labels, ensure_ascii=False)
                if item["multiSelect"]
                else labels[0]
            )
        ok = self.native().resolve_gateway_clarify(item["sourceId"], text)
        return {"status": "accepted" if ok else "already_answered"}
