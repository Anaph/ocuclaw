"""Profile-authorized Workspace access to the public Hermes phone API."""

from __future__ import annotations

import asyncio
import re

from .management_profiles import management_profile_home
from .stock_management import profile_context
from .session_rpc import bounded_workspace_history


class WorkspaceSchedule:
    def __init__(self, rpc, session_rpc=None):
        self.rpc = rpc
        self.session_rpc = session_rpc
        self._results_cache = {}

    async def handle(self, params):
        return await asyncio.to_thread(self._handle, params)

    async def models(self, params):
        profile = params.get("profileId") or "default"
        if (
            not isinstance(profile, str)
            or management_profile_home(self.rpc, profile) is None
        ):
            raise ValueError("profile_not_served")
        with profile_context(self.rpc, profile):
            return await self.rpc.list_models({})

    def _handle(self, params):
        if not isinstance(params, dict):
            raise ValueError("invalid_request")
        profile = params.get("profileId") or "default"
        if (
            not isinstance(profile, str)
            or management_profile_home(self.rpc, profile) is None
        ):
            raise ValueError("profile_not_served")
        operation = params.get("operation")
        if not isinstance(operation, str) or not re.fullmatch(
            r"(?:automations|jobs)\.[a-z]+", operation
        ):
            raise ValueError("unsupported_operation")
        with profile_context(self.rpc, profile):
            try:
                from cron import phone_workspace

                if phone_workspace.API_VERSION != 1:
                    raise ImportError()
            except ImportError:
                if operation == "automations.options":
                    import time

                    return {
                        "supported": False,
                        "reason": "Нужен публичный Workspace API Hermes; подготовьте совместимую сборку перед деплоем.",
                        "serverNowMs": int(time.time() * 1000),
                        "timezone": "unknown",
                        "missedPolicy": "Правила определяет Hermes",
                        "parallelPolicy": "Правила определяет Hermes",
                        "runNowPolicy": "Недоступно",
                        "stopSupported": False,
                    }
                raise ValueError("hermes_workspace_api_unavailable") from None
            p = {k: v for k, v in params.items() if k not in {"operation", "profileId"}}
            result = phone_workspace.handle(operation, p)
            ns = "main" if profile == "default" else profile
            for item in result.get("history", []):
                if item.get("sessionId"):
                    item["sessionKey"] = f"hermes:{ns}:x:cron:{item.pop('sessionId')}"
            return result

    def _profiles(self):
        from .adapter import _load_profile_routing

        enabled, routes = _load_profile_routing()
        return (
            ["default", *(name for name in routes if name != "main")]
            if enabled
            else ["default"]
        )

    def binding_for_session(self, session_id):
        from cron import phone_workspace

        for profile in self._profiles():
            with profile_context(self.rpc, profile):
                binding = phone_workspace.binding_for_session(session_id)
                if binding:
                    ns = "main" if profile == "default" else profile
                    return {
                        **binding,
                        "profileId": profile,
                        "sessionKey": f"hermes:{ns}:x:cron:{session_id}",
                    }
        return None

    def pending_questions(self):
        try:
            from cron import phone_workspace
        except ImportError:
            return []
        out = []
        for profile in self._profiles():
            with profile_context(self.rpc, profile):
                ns = "main" if profile == "default" else profile
                for row in phone_workspace.pending_questions():
                    out.append(
                        {
                            **row,
                            "id": "scheduled-question:" + row["sourceId"],
                            "kind": "question",
                            "sessionKey": f"hermes:{ns}:x:cron:{row['sessionId']}",
                            "sessionTitle": row["jobId"],
                            "agentName": profile,
                            "allowOther": True,
                            "profileId": profile,
                        }
                    )
        return out

    def resolve_question(self, item, answer):
        from cron import phone_workspace

        with profile_context(self.rpc, item["profileId"]):
            return phone_workspace.resolve_question(item["sourceId"], answer)

    def completions(self):
        from datetime import datetime

        try:
            from cron import phone_workspace
        except ImportError:
            return []
        import time

        out = []
        for profile in self._profiles():
            with profile_context(self.rpc, profile):
                ns = "main" if profile == "default" else profile
                jobs = phone_workspace.handle("jobs.list", {})["jobs"]
                names = {job["id"]: job["name"] for job in jobs}
                rows, cursor = [], None
                import time

                cached = self._results_cache.get(profile)
                if cached and cached[0] > time.monotonic():
                    rows = cached[1]
                else:
                    while True:
                        page = phone_workspace.handle(
                            "jobs.results", {"before": cursor} if cursor else {}
                        )
                        rows.extend(page["history"])
                        next_cursor = page.get("nextBefore")
                        if not next_cursor or next_cursor == cursor:
                            break
                        cursor = next_cursor
                    self._results_cache[profile] = (time.monotonic() + 5, rows)
                for row in rows:
                    if row["status"] not in {
                        "completed",
                        "failed",
                        "unknown",
                    } or not row.get("finishedAt"):
                        continue
                    created = int(
                        datetime.fromisoformat(row["finishedAt"]).timestamp() * 1000
                    )
                    if created < time.time() * 1000 - 7 * 86400000:
                        continue
                    out.append(
                        {
                            "id": f"cron-result:{ns}:{row['id']}",
                            "sessionKey": f"hermes:{ns}:x:cron:{row['sessionId']}"
                            if row.get("sessionId")
                            else f"hermes:{ns}:x:cron-run:{row['id']}",
                            "agentName": profile,
                            "sessionTitle": names.get(row["jobId"], row["jobId"]),
                            "summary": (
                                row.get("summary") or row.get("reason") or row["status"]
                            )[:4000],
                            "jobId": row["jobId"],
                            "executionId": row["id"],
                            "profileId": profile,
                            "status": row["status"],
                            "createdAtMs": created,
                        }
                    )
        return out

    async def chat_history(self, params):
        return await asyncio.to_thread(self._chat_history, params)

    def _chat_history(self, params):
        match = re.fullmatch(
            r"hermes:([^:]+):x:cron:([^:]+)", str(params.get("sessionKey", ""))
        )
        if not match:
            raise ValueError("invalid_cron_session")
        ns, session = match.groups()
        profile = "default" if ns == "main" else ns
        if management_profile_home(self.rpc, profile) is None:
            raise ValueError("profile_not_served")
        from cron import phone_workspace

        with profile_context(self.rpc, profile):
            if not phone_workspace.binding_for_session(session):
                raise ValueError("execution_not_found")
            rows = self.session_rpc.conversation_by_id(session, limit=0)
        before = params.get("beforeId")
        if before is not None:
            index = next(
                (i for i, row in enumerate(rows) if str(row.get("id")) == str(before)),
                None,
            )
            if index is None:
                raise ValueError("invalid_history_cursor")
            rows = rows[:index]
        limit = max(1, min(int(params.get("limit", 30)), 100))
        page = bounded_workspace_history(rows[-limit:])
        return {
            "messages": page,
            "hasMore": len(rows) > len(page),
            "nextBeforeId": page[0].get("id") if page else None,
        }
