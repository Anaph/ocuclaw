"""Emulator test: db.sessions.list search (display projection + FTS union)."""
import pathlib, sys, threading, types

REPO = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO.parent))
_pkg = types.ModuleType("ocuclaw")
_pkg.__path__ = [str(REPO)]
sys.modules.setdefault("ocuclaw", _pkg)
from ocuclaw.session_rpc import SessionRpc

ROWS = [
    {"id": 1, "session_key": "a", "source": "cli", "last_active": 5,
     "title": "Notes", "preview": "quarterly", "message_count": 1},
    {"id": 2, "session_key": "b", "source": "cli", "last_active": 4,
     "title": "Отчёт", "preview": "кварталы", "message_count": 2},
]

TIPS = {"1": {"id": 1}, "2": {"id": 2}, "77": {"id": 2}}  # 77 = compression ancestor


class FakeDB:
    def __init__(self, fts_enabled=True, hits=(), raise_on_search=False):
        self._fts_enabled = fts_enabled
        self._hits = list(hits)
        self._raise = raise_on_search

    def list_sessions_rich(self, **kw):
        return [dict(r) for r in ROWS]

    def search_messages(self, q, **kw):
        if self._raise:
            raise RuntimeError("fts boom")
        return list(self._hits)


def make_rpc(db):
    rpc = SessionRpc.__new__(SessionRpc)
    rpc._access_lock = threading.RLock()
    rpc._operation_depth = 0
    rpc._operation_identity = None
    rpc._get_reader = lambda: db
    rpc._lineage_root_id = lambda row: str(row.get("id"))
    rpc._visible_search_row = lambda sid: TIPS.get(str(sid))
    return rpc


# display projection: title AND preview romanize (item 1)
res = make_rpc(FakeDB(fts_enabled=False))._sync_list({"limit": 5})
assert res["sessions"][1]["title"] == "Otchyot", res
assert res["sessions"][1]["preview"] == "kvartaly", res

# substring still works via the romanized form of a Cyrillic term
res = make_rpc(FakeDB(fts_enabled=False))._sync_list({"search": "квартал"})
assert [s["id"] for s in res["sessions"]] == [2], res

# FTS union: a term absent from title/preview finds the session via messages
res = make_rpc(FakeDB(hits=[{"session_id": 1}]))._sync_list({"search": "apus"})
assert [s["id"] for s in res["sessions"]] == [1], res

# FTS hits on a compression ancestor project to the visible tip
res = make_rpc(FakeDB(hits=[{"session_id": 77}]))._sync_list({"search": "apus"})
assert [s["id"] for s in res["sessions"]] == [2], res

# FTS raising degrades to substring-only instead of failing the list
res = make_rpc(FakeDB(raise_on_search=True))._sync_list({"search": "not"})
assert [s["id"] for s in res["sessions"]] == [1], res

print("test_list_search_emu OK")
