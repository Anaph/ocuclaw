"""Plain asserts for _paginate_conversation (no pytest needed)."""
import pathlib, sys, types

REPO = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO.parent))
# Import session_rpc without executing the package __init__ (which pulls the
# whole adapter -> yaml -> hermes).
_pkg = types.ModuleType("ocuclaw")
_pkg.__path__ = [str(REPO)]
sys.modules.setdefault("ocuclaw", _pkg)
from ocuclaw.session_rpc import _paginate_conversation

rows = [{"id": i, "role": "user", "content": "x"} for i in range(1, 11)]

# 1. no cursor, no limit -> everything, no cursor fields
page = _paginate_conversation(rows, after_id=None, before_id=None, limit=0)
assert page == {"messages": rows, "hasMore": False, "nextBeforeId": None}

# 2. tail slice unchanged (legacy: last N, hasMore True)
page = _paginate_conversation(rows, after_id=None, before_id=None, limit=4)
assert [r["id"] for r in page["messages"]] == [7, 8, 9, 10]
assert page["hasMore"] is True and page["nextBeforeId"] is None

# 3. beforeId page: 4 rows immediately older than id=7, oldest-first
page = _paginate_conversation(rows, after_id=None, before_id=7, limit=4)
assert [r["id"] for r in page["messages"]] == [3, 4, 5, 6]
assert page["hasMore"] is True
assert page["nextBeforeId"] == 3

# 4. last backward page clamps at the beginning
page = _paginate_conversation(rows, after_id=None, before_id=3, limit=4)
assert [r["id"] for r in page["messages"]] == [1, 2]
assert page["hasMore"] is False and page["nextBeforeId"] == 1

# 5. rows without ids -> caller handles rowIdsUnavailable; paginator keeps all
page = _paginate_conversation([{"role": "user"}] * 3, after_id=None, before_id=None, limit=0)
assert page == {"messages": [{"role": "user"}] * 3, "hasMore": False, "nextBeforeId": None}

print("test_history_pagination OK")
