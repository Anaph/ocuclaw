"""Public native source, including nonselected Desktop and denied profile visibility."""

import asyncio
import pathlib
import sys
import threading
import types

root = pathlib.Path(__file__).resolve().parents[1]
package = types.ModuleType("ocuclaw")
package.__path__ = [str(root)]
sys.modules["ocuclaw"] = package
adapter = types.ModuleType("ocuclaw.adapter")
adapter._load_profile_routing = lambda: (True, {"allowed": root})
sys.modules["ocuclaw.adapter"] = adapter
from ocuclaw.inbox_native import NativeInboxSource

entries = {}
for i, key in enumerate(
    (
        "agent:main:ocuclaw:dm:a",
        "agent:main:desktop:dm:b",
        "agent:allowed:desktop:dm:c",
        "agent:private:desktop:dm:hidden",
    )
):
    entries[str(i)] = types.SimpleNamespace(
        clarify_id=str(i),
        session_key=key,
        event=threading.Event(),
        question="Вопрос?",
        choices=["Да", "Нет"],
        multi_select=False,
        created_at_ms=1,
        expires_at_ms=None,
    )


class Native:
    @staticmethod
    def get_pending(key):
        return (
            entries.get(key)
            if key in entries and not entries[key].event.is_set()
            else None
        )

    @staticmethod
    def list_pending():
        return [x for x in entries.values() if not x.event.is_set()]

    @staticmethod
    def resolve_gateway_clarify(key, text):
        entry = Native.get_pending(key)
        if not entry:
            return False
        entry.response = text
        entry.event.set()
        return True


fake = types.SimpleNamespace(
    _approval_lock=threading.RLock(),
    _approvals_by_id={},
    _public_key_for_native_session=lambda k: (
        "hermes:main:a" if "ocuclaw" in k else None
    ),
    _session_rpc=types.SimpleNamespace(row_by_id=lambda key: None),
)
source = NativeInboxSource(fake)
source.native = lambda: Native
source.approvals_native = lambda: types.SimpleNamespace(
    resolve_gateway_approval=lambda: None
)
assert len(source.snapshot()) == 3
assert source.capabilities()["allGatewayQuestions"]


async def test():
    result = await source.resolve("question:1", {"text": "Свободный ответ"})
    assert result["status"] == "accepted"
    assert (
        entries["1"].response == "Свободный ответ" and not entries["0"].event.is_set()
    )
    assert source.get("question:1") is None


asyncio.run(test())
print("test_inbox_native OK")
