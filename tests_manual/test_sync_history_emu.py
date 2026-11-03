"""Emulator test: SessionRpc._sync_history with a stubbed store (no Hermes)."""
import pathlib, sys, threading, types

REPO = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO.parent))
_pkg = types.ModuleType("ocuclaw")
_pkg.__path__ = [str(REPO)]
sys.modules.setdefault("ocuclaw", _pkg)
from ocuclaw.session_rpc import SessionRpc

ROWS = [
    {"id": i, "role": "user" if i % 2 else "assistant", "content": "m%d" % i}
    for i in range(1, 11)
]


def make_rpc(rows):
    rpc = SessionRpc.__new__(SessionRpc)
    rpc._access_lock = threading.Lock()
    rpc._operation_depth = 0
    rpc._operation_identity = None
    rpc._resolve_target = lambda identity, **kw: "tip1"
    rpc._conversation_rows_with_identity = lambda sid: [
        dict(r) for r in rows
    ] + [{"id": 99, "role": "tool", "content": "noise"}]
    rpc._conversation_row_to_wire = lambda row: dict(row)
    return rpc


# beforeId page (exclusive, oldest-first, cursor fields present)
res = make_rpc(ROWS)._sync_history({"identity": {}, "beforeId": 7, "limit": 4})
assert [m["id"] for m in res["messages"]] == [3, 4, 5, 6], res
assert res["hasMore"] is True and res["nextBeforeId"] == 3
assert res["total"] == 10 and res["sessionId"] == "tip1"

# last backward page clamps
res = make_rpc(ROWS)._sync_history({"identity": {}, "beforeId": 3, "limit": 4})
assert [m["id"] for m in res["messages"]] == [1, 2]
assert res["hasMore"] is False and res["nextBeforeId"] == 1

# legacy tail limit: NO cursor keys on the wire at all (byte-compatible)
res = make_rpc(ROWS)._sync_history({"identity": {}, "limit": 4})
assert [m["id"] for m in res["messages"]] == [7, 8, 9, 10], res
assert "hasMore" not in res and "nextBeforeId" not in res

# legacy full read: exact legacy key set
res = make_rpc(ROWS)._sync_history({"identity": {}})
assert set(res) == {"messages", "sessionId", "total"}, sorted(res)
assert len(res["messages"]) == 10

# forward tail unchanged
res = make_rpc(ROWS)._sync_history({"identity": {}, "afterId": 8})
assert [m["id"] for m in res["messages"]] == [9, 10]
assert "hasMore" not in res

# rows without ids + cursor -> honest rowIdsUnavailable, empty page
res = make_rpc([{"role": "user", "content": "x"}])._sync_history(
    {"identity": {}, "beforeId": 5, "limit": 3}
)
assert res["messages"] == [] and res["rowIdsUnavailable"] is True

# pages span compression ancestors transparently: one beforeId page mixing
# ancestor and tip rows comes back oldest-first (history is include-ancestors)
MIXED = [
    {"id": 1, "role": "user", "content": "anc1", "sessionId": "anc"},
    {"id": 2, "role": "assistant", "content": "anc2", "sessionId": "anc"},
    {"id": 3, "role": "user", "content": "tip1", "sessionId": "tip"},
]
res = make_rpc(MIXED)._sync_history({"identity": {}, "beforeId": 3, "limit": 2})
assert [m["id"] for m in res["messages"]] == [1, 2], res
assert res["hasMore"] is False and res["nextBeforeId"] == 1

print("test_sync_history_emu OK")
