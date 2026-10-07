"""The resume record kept next to "<name>.part" as "<name>.part.json":

    {size, chunk, done: [pieces already on disk], saved: [Saved Messages ids]}
"""
import json

from .config import CHUNK


def read_record(rec_file, part, size):
    """The record for this .part, or None if there's none we can trust."""
    try:
        rec = json.loads(rec_file.read_text())
        # Only trust it for the same file, cut the same way, with the .part still there.
        if rec["size"] == size and rec["chunk"] == CHUNK and part.stat().st_size == size:
            return rec
    except (OSError, ValueError, KeyError):
        pass  # no record, unreadable, or no .part: start fresh
    return None


def write_record(rec_file, rec):
    # Write a temp file and rename it, so a Ctrl+C mid-write never leaves half a record.
    tmp = rec_file.with_name(rec_file.name + ".tmp")
    tmp.write_text(json.dumps(rec))
    tmp.replace(rec_file)
