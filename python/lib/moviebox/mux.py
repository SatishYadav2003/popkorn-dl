"""Port of node/lib/moviebox/mux.js — joins DASH video+audio segments into one
seekable MP4 without ffmpeg. Pure Python struct-based MP4 box manipulation."""
import struct


# ---------- box helpers ----------

def _u32(buf: bytes, at: int) -> int:
    return struct.unpack_from(">I", buf, at)[0]


def _u64(buf: bytes, at: int) -> int:
    return struct.unpack_from(">Q", buf, at)[0]


def _w32(buf: bytearray, at: int, v: int):
    struct.pack_into(">I", buf, at, v)


def _w64(buf: bytearray, at: int, v: int):
    struct.pack_into(">Q", buf, at, v)


def _boxes(data: bytes, start: int = 0, end: int = None) -> list:
    """Top-level boxes of data[start:end]: [{ type, at, size, hdr }]."""
    if end is None:
        end = len(data)
    out = []
    at = start
    while at + 8 <= end:
        size = _u32(data, at)
        hdr = 8
        if size == 1:
            size = _u64(data, at + 8)
            hdr = 16
        elif size == 0:
            size = end - at
        if size < hdr:
            raise ValueError("broken video segment")
        out.append({"type": data[at + 4:at + 8].decode("latin1"), "at": at, "size": size, "hdr": hdr})
        at += size
    return out


def _find(lst: list, t: str) -> dict | None:
    return next((b for b in lst if b["type"] == t), None)


def _slice(data: bytes, b: dict) -> bytes:
    return data[b["at"]:b["at"] + b["size"]]


def _inside(data: bytes, b: dict) -> list:
    return _boxes(data, b["at"] + b["hdr"], b["at"] + b["size"])


def _box(btype: str, *parts: bytes) -> bytes:
    body = b"".join(parts)
    return struct.pack(">I4s", 8 + len(body), btype.encode("latin1")) + body


def _version(buf: bytes, b: dict) -> int:
    """A full box's version byte."""
    return buf[b["at"] + b["hdr"]]


def _track_timescale(buf: bytes, trak: dict) -> int:
    """mdhd timescale of a track (ticks per second)."""
    mdia = _find(_inside(buf, trak), "mdia")
    mdhd = _find(_inside(buf, mdia), "mdhd")
    ver = _version(buf, mdhd)
    off = 20 if ver == 1 else 12
    return _u32(buf, mdhd["at"] + mdhd["hdr"] + off)


def _join_init(v_init: bytes, a_init: bytes, duration_sec: float) -> tuple:
    """Returns (head_bytes, video_timescale)."""
    v_top = _boxes(v_init)
    a_top = _boxes(a_init)
    v_moov_box = _find(v_top, "moov")
    a_moov_box = _find(a_top, "moov")
    v_moov = _inside(v_init, v_moov_box)
    a_moov = _inside(a_init, a_moov_box)
    v_trak = _find(v_moov, "trak")

    # mvhd: total duration, and track ids up to 2 are taken.
    mvhd_box = _find(v_moov, "mvhd")
    mvhd = bytearray(_slice(v_init, mvhd_box))
    v1 = mvhd[mvhd_box["hdr"]] == 1
    scale_off = mvhd_box["hdr"] + (20 if v1 else 12)
    scale = _u32(mvhd, scale_off)
    movie_duration = round(duration_sec * scale)
    if v1:
        _w64(mvhd, mvhd_box["hdr"] + 24, movie_duration)
    else:
        _w32(mvhd, mvhd_box["hdr"] + 16, movie_duration)
    # next_track_id = 3 (we have 2 tracks)
    _w32(mvhd, len(mvhd) - 4, 3)

    # The audio track, renumbered from 1 to 2.
    a_trak_box = _find(a_moov, "trak")
    a_trak = bytearray(_slice(a_init, a_trak_box))
    # tkhd is inside aTrak; parse it relative to the aTrak buffer
    a_trak_inner = _boxes(bytes(a_trak), a_trak_box["hdr"], len(a_trak))
    tkhd = _find(a_trak_inner, "tkhd")
    if tkhd:
        tkhd_ver = a_trak[tkhd["at"] + tkhd["hdr"]]
        tid_off = tkhd["at"] + tkhd["hdr"] + (20 if tkhd_ver == 1 else 12)
        _w32(a_trak, tid_off, 2)

    # mvex: one trex per track (renumber audio trex track_id to 2).
    v_mvex_box = _find(v_moov, "mvex")
    a_mvex_box = _find(a_moov, "mvex")

    def _trex_of(buf, mvex_box):
        return _find(_inside(buf, mvex_box), "trex")

    a_trex_box = _trex_of(a_init, a_mvex_box)
    a_trex = bytearray(_slice(a_init, a_trex_box))
    _w32(a_trex, a_trex_box["hdr"] + 4, 2)  # track_id field

    # mehd: movie extends header with overall duration
    mehd_body = struct.pack(">II", 0, movie_duration)  # version+flags=0, duration (32-bit)
    mehd = _box("mehd", mehd_body)

    v_trex = _slice(v_init, _trex_of(v_init, v_mvex_box))
    mvex = _box("mvex", mehd, v_trex, bytes(a_trex))

    # HEVC tagged "hev1" plays in VLC and Android but not Apple; "hvc1" plays everywhere.
    v_trak_buf = bytearray(_slice(v_init, v_trak))
    hev1_idx = bytes(v_trak_buf).find(b"hev1")
    if hev1_idx >= 0:
        v_trak_buf[hev1_idx:hev1_idx + 4] = b"hvc1"

    # other boxes inside moov (iods, udta, etc.)
    others = [_slice(v_init, b) for b in v_moov
              if b["type"] not in ("mvhd", "trak", "mvex")]
    moov = _box("moov", bytes(mvhd), bytes(v_trak_buf), bytes(a_trak), mvex, *others)

    v_ftyp = _find(v_top, "ftyp")
    ftyp = _slice(v_init, v_ftyp) if v_ftyp else b""

    video_scale = _track_timescale(v_init, v_trak)
    return ftyp + moov, video_scale


def _fragment(seg: bytes, seq: int, track: int) -> bytes:
    """moof+mdat with sequence number set and (for audio) track id changed to 2."""
    top = _boxes(seg)
    moof_box = _find(top, "moof")
    mdat_box = _find(top, "mdat")
    if not moof_box or not mdat_box:
        raise ValueError("broken video segment")
    frag = bytearray(seg[moof_box["at"]:mdat_box["at"] + mdat_box["size"]])
    # Re-parse boxes within the extracted fragment
    moof_inner = _boxes(bytes(frag), 0, moof_box["size"])
    mfhd = _find(moof_inner, "mfhd")
    if mfhd:
        _w32(frag, mfhd["at"] + mfhd["hdr"] + 4, seq)
    for traf in [b for b in moof_inner if b["type"] == "traf"]:
        for tb in _inside(bytes(frag), traf):
            if tb["type"] == "tfhd":
                _w32(frag, tb["at"] + tb["hdr"] + 4, track)
    return bytes(frag)


def _fragment_ticks(frag: bytes) -> int:
    """How long a video fragment plays, in its track's ticks."""
    top = _boxes(frag)
    moof_box = _find(top, "moof")
    if not moof_box:
        return 0
    ticks = 0
    for traf in [b for b in _inside(frag, moof_box) if b["type"] == "traf"]:
        parts = _inside(frag, traf)
        tfhd = _find(parts, "tfhd")
        if tfhd is None:
            continue
        t_flags = _u32(frag, tfhd["at"] + tfhd["hdr"]) & 0xFFFFFF
        p = tfhd["at"] + tfhd["hdr"] + 8  # after version/flags and track_id
        if t_flags & 0x1:
            p += 8   # base data offset
        if t_flags & 0x2:
            p += 4   # sample description index
        default_duration = _u32(frag, p) if (t_flags & 0x8) else 0
        for trun in [b for b in parts if b["type"] == "trun"]:
            r_flags = _u32(frag, trun["at"] + trun["hdr"]) & 0xFFFFFF
            count = _u32(frag, trun["at"] + trun["hdr"] + 4)
            if not (r_flags & 0x100):
                ticks += count * default_duration
                continue
            q = trun["at"] + trun["hdr"] + 8
            if r_flags & 0x1:
                q += 4  # data offset
            if r_flags & 0x4:
                q += 4  # first sample flags
            stride = 4 * bin(r_flags & 0xF00).count("1")
            for _ in range(count):
                ticks += _u32(frag, q)
                q += stride
    return ticks


def _sidx(entries: list, timescale: int) -> bytes:
    """sidx with one entry per (video+audio) pair."""
    body = bytearray(24 + len(entries) * 12)
    _w32(body, 4, 1)           # reference track: video
    _w32(body, 8, timescale)
    # earliest_presentation_time = 0, first_offset = 0
    struct.pack_into(">H", body, 22, len(entries))
    for i, (size, ticks) in enumerate(entries):
        _w32(body, 24 + i * 12, size)
        _w32(body, 28 + i * 12, ticks)
        _w32(body, 32 + i * 12, 0x90000000)  # starts with a keyframe
    return _box("sidx", bytes(body))


def mux(target_path: str, init_fn, segment_fn, counts: dict, duration: float):
    """Write target_path from the segments.

    init_fn(kind) -> bytes; segment_fn(kind, i) -> bytes; kind = "video" or "audio".
    counts = {"video": int, "audio": int}; duration = float seconds.
    """
    v_init = init_fn("video")
    a_init = init_fn("audio")
    head, video_scale = _join_init(v_init, a_init, duration)

    pairs = max(counts["video"], counts["audio"])

    def build(i, seq):
        out = []
        if i < counts["video"]:
            out.append(_fragment(segment_fn("video", i), seq, 1))
            seq += 1
        if i < counts["audio"]:
            out.append(_fragment(segment_fn("audio", i), seq, 2))
            seq += 1
        return out, seq

    # First pass: compute sizes and ticks for sidx.
    entries = []
    seq = 1
    for i in range(pairs):
        frags, seq = build(i, seq)
        size = sum(len(f) for f in frags)
        ticks = _fragment_ticks(frags[0]) if frags and i < counts["video"] else 0
        entries.append((size, ticks))

    with open(target_path, "wb") as fp:
        fp.write(head)
        fp.write(_sidx(entries, video_scale))
        seq = 1
        for i in range(pairs):
            frags, seq = build(i, seq)
            for f in frags:
                fp.write(f)
