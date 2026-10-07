"""What's already on disk, so results can be marked as had (✔) or half-downloaded (↺ 45%)."""
import json
import re

from .config import download_dir, incomplete_dir


def norm(s):
    """The bot's result name and the real file name differ only in separators:
        "The Flash 2014 S05E19 720p WEBRip x265 PSA mkv"  vs  "The_Flash_2014_S05E19_720p_WEBRip_x265_PSA.mkv"
    so both are compared as just their letters and digits."""
    return re.sub(r"[^a-z0-9]", "", s.lower())


def _files(folder):
    try:
        return [f for f in folder.iterdir() if f.is_file()]
    except OSError:
        return []  # folder doesn't exist yet


def scan_local():
    """key -> (size, pct); pct is None for a finished file."""
    local = {}
    for f in _files(download_dir):
        local[norm(f.name)] = (f.stat().st_size, None)
    for f in _files(incomplete_dir):
        if not f.name.endswith(".part.json"):
            continue
        try:
            rec = json.loads(f.read_text())
            pct = min(100, len(rec["done"]) * rec["chunk"] * 100 / rec["size"])
            local[norm(f.name.removesuffix(".part.json"))] = (rec["size"], pct)
        except (OSError, ValueError, KeyError):
            pass  # unreadable record: no marker
    return local


def marker_for(result, local):
    """For one result (from describe_result): {"kind": "have"} / {"kind": "partial", "pct"} / None."""
    hit = local.get(norm(result["name"]))
    if not hit:
        return None
    size, pct = hit
    # The bot rounds the size it shows, so allow 2%; a bigger gap means a different file.
    if result["bytes"] and abs(size - result["bytes"]) / result["bytes"] > 0.02:
        return None
    return {"kind": "have"} if pct is None else {"kind": "partial", "pct": int(pct)}
