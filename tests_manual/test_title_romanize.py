"""Romanize self-check as a file test (romanize branch)."""
import pathlib, sys, types

REPO = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO.parent))
_pkg = types.ModuleType("ocuclaw")
_pkg.__path__ = [str(REPO)]
sys.modules.setdefault("ocuclaw", _pkg)
from ocuclaw.title_romanize import romanize_title

assert romanize_title("Погода в Москве") == "Pogoda v Moskve"
assert romanize_title("Елка") == "Elka"    # е -> e (BGN)
assert romanize_title("Ёлка") == "Yolka"   # ё -> yo
assert romanize_title("Щука") == "Shchuka"
assert romanize_title("Hello 123") == "Hello 123"
assert romanize_title(None) is None
import os
from ocuclaw.title_romanize import maybe_romanize
os.environ["OCUCLAW_TITLE_ROMANIZE"] = "0"
assert maybe_romanize("Погода") == "Погода"  # toggle off: pass-through
os.environ["OCUCLAW_TITLE_ROMANIZE"] = "1"
assert maybe_romanize("Погода") == "Pogoda"  # toggle on
from ocuclaw import title_romanize as _tr
os.environ["OCUCLAW_TITLE_ROMANIZE"] = "0"
_tr.configure(True)
assert maybe_romanize("Погода") == "Pogoda"  # explicit config beats env-off
_tr.configure(None)
assert maybe_romanize("Погода") == "Погода"  # un-pinned: env governs again
_tr.configure(False)
assert maybe_romanize("Погода") == "Погода"  # explicit config off
_tr.configure(None)
os.environ.pop("OCUCLAW_TITLE_ROMANIZE")
print("test_title_romanize OK")
