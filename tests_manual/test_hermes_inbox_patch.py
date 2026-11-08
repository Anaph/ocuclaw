import importlib.util
import pathlib

spec = importlib.util.spec_from_file_location(
    "prepare",
    pathlib.Path(__file__).resolve().parents[1]
    / "scripts/prepare_hermes_inbox_source.py",
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
source = """import time, threading
from typing import Optional
from dataclasses import dataclass,field
@dataclass
class _ClarifyEntry:
    event: object = field(default_factory=threading.Event)
    awaiting_text: bool = False
_lock=threading.RLock()
_entries={}
def wait_for_response(timeout,entry):
    activity_state = {}
"""
patched = module.prepare(source)
ns = {}
exec(patched, ns)
entry = ns["_ClarifyEntry"]()
ns["_entries"]["q"] = entry
assert ns["list_pending"]() == [entry]
entry.event.set()
assert ns["list_pending"]() == []
assert module.prepare(patched) == patched
try:
    module.prepare("unsupported")
except ValueError:
    pass
else:
    raise AssertionError("unreviewed source accepted")
print("test_hermes_inbox_patch OK")
