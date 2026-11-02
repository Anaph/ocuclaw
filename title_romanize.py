"""Romanize Cyrillic session titles for the phone app (display-only).

The OcuClaw phone app draws its session-list UI with a Latin-only font, so
Russian titles render as empty boxes (tofu). The SessionDB keeps the true
Cyrillic title; this module transliterates at the display projection so the
phone can show the name. Set OCUCLAW_TITLE_ROMANIZE=0 (or false/no/off) to
pass titles through unchanged.
"""

from __future__ import annotations

import os

_TRANSLIT = {
    "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e",
    "ё": "yo", "ж": "zh", "з": "z", "и": "i", "й": "y", "к": "k",
    "л": "l", "м": "m", "н": "n", "о": "o", "п": "p", "р": "r",
    "с": "s", "т": "t", "у": "u", "ф": "f", "х": "kh", "ц": "ts",
    "ч": "ch", "ш": "sh", "щ": "shch", "ъ": "", "ы": "y", "ь": "",
    "э": "e", "ю": "yu", "я": "ya",
}
_CYRILLIC_RE = None  # built lazily


def _cyrillic_re():
    global _CYRILLIC_RE
    if _CYRILLIC_RE is None:
        import re
        _CYRILLIC_RE = re.compile("[" + "".join(_TRANSLIT) + "А-Яа-яЁё]")
    return _CYRILLIC_RE


def romanize_enabled() -> bool:
    return os.environ.get("OCUCLAW_TITLE_ROMANIZE", "1").strip().lower() not in {
        "0", "false", "no", "off",
    }


def romanize_title(text):
    """Transliterate Cyrillic runs to Latin; anything else passes through."""
    if not isinstance(text, str) or not text or not _cyrillic_re().search(text):
        return text
    out = []
    for ch in text:
        low = ch.lower()
        mapped = _TRANSLIT.get(low)
        if mapped is None:
            out.append(ch)
        elif ch == low:
            out.append(mapped)
        else:
            out.append(mapped[:1].upper() + mapped[1:])
    return "".join(out)


def maybe_romanize(text):
    """Display projection: romanize only while the toggle is on."""
    if not romanize_enabled():
        return text
    return romanize_title(text)
