"""What's already on disk, so results can be marked as had (✔) or half-downloaded (↺ 45%)."""
import json
import re
import shutil

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
    """key -> {size, pct, file?}; pct is None for a finished file."""
    local = {}
    for f in _files(download_dir):
        local[norm(f.name)] = {"size": f.stat().st_size, "pct": None}
    for f in _files(incomplete_dir):
        if not f.name.endswith(".part.json"):
            continue
        try:
            rec = json.loads(f.read_text())
            pct = min(100, len(rec["done"]) * rec["chunk"] * 100 / rec["size"])
            stem = f.name.removesuffix(".part.json")
            local[norm(stem)] = {"size": rec["size"], "pct": pct, "file": stem}
        except (OSError, ValueError, KeyError):
            pass  # unreadable record: no marker
    return local


def marker_for(result, local):
    """For one result: {"kind": "have"} / {"kind": "partial", "pct", "file"} / None."""
    hit = local.get(norm(result["name"]))
    if not hit:
        return None
    size = hit["size"]
    pct = hit["pct"]
    # The bot rounds the size it shows, so allow 2%; a bigger gap means a different file.
    if result.get("bytes") and abs(size - result["bytes"]) / result["bytes"] > 0.02:
        return None
    if pct is None:
        return {"kind": "have"}
    return {"kind": "partial", "pct": int(pct), "file": hit.get("file")}


def marker_for_prefix(prefix: str, local: dict):
    """Marker for any file whose name starts with prefix (any quality of an episode)."""
    key = norm(prefix)
    hits = [v for k, v in local.items() if k.startswith(key)]
    if any(h["pct"] is None for h in hits):
        return {"kind": "have"}
    if hits:
        best = max(h["pct"] for h in hits)
        return {"kind": "partial", "pct": int(best)}
    return None


def discard_partial(file: str | None):
    """Throw away a half-done download; file is the stem name (no extension)."""
    if not file:
        return
    for suffix in (".part", ".part.json", ".part.json.tmp", ".parts"):
        target = incomplete_dir / (file + suffix)
        try:
            if target.is_dir():
                shutil.rmtree(target, ignore_errors=True)
            else:
                target.unlink(missing_ok=True)
        except OSError:
            pass
    try:
        if all(f.name == ".nomedia" for f in incomplete_dir.iterdir()):
            shutil.rmtree(incomplete_dir, ignore_errors=True)
    except OSError:
        pass
