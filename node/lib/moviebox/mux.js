// Joins DASH video and audio segments into one MP4 that any player opens, without
// ffmpeg. The segments are already "fragmented MP4": an init segment describing the
// track, then pieces that each hold a few seconds of it. One file with both tracks is:
//
//   ftyp | moov (video track + audio track) | sidx (where each piece starts) | moof mdat | moof mdat | …
//
// The pieces are copied as they are, except that the audio ones are renumbered to
// track 2. sidx is what lets players seek straight to a time.
const fs = require("fs");

// Top-level boxes of buf[from, to): [{ type, at, size, hdr }].
function boxes(buf, from = 0, to = buf.length) {
  const out = [];
  for (let at = from; at + 8 <= to; ) {
    let size = buf.readUInt32BE(at);
    let hdr = 8;
    if (size === 1) {
      size = Number(buf.readBigUInt64BE(at + 8));
      hdr = 16;
    } else if (size === 0) size = to - at;
    if (size < hdr) throw new Error("broken video segment");
    out.push({ type: buf.toString("latin1", at + 4, at + 8), at, size, hdr });
    at += size;
  }
  return out;
}

const find = (list, type) => list.find((b) => b.type === type);
const slice = (buf, b) => buf.subarray(b.at, b.at + b.size);
const inside = (buf, b) => boxes(buf, b.at + b.hdr, b.at + b.size);

function box(type, ...parts) {
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length);
  head.write(type, 4, "latin1");
  return Buffer.concat([head, body]);
}

// A full box's version byte.
const version = (buf, b) => buf[b.at + b.hdr];

// mdhd timescale of a track (ticks per second).
function trackTimescale(buf, trak) {
  const mdhd = find(inside(buf, find(inside(buf, trak), "mdia")), "mdhd");
  return buf.readUInt32BE(mdhd.at + mdhd.hdr + (version(buf, mdhd) ? 20 : 12));
}

// The moov box for both tracks; also returns the video track's timescale.
function joinInit(vInit, aInit, durationSec) {
  const vTop = boxes(vInit);
  const aTop = boxes(aInit);
  const vMoov = inside(vInit, find(vTop, "moov"));
  const aMoov = inside(aInit, find(aTop, "moov"));
  const vTrak = find(vMoov, "trak");

  // mvhd: total duration, and track ids up to 2 are taken.
  const mvhdBox = find(vMoov, "mvhd");
  const mvhd = Buffer.from(slice(vInit, mvhdBox));
  const v1 = mvhd[mvhdBox.hdr] === 1;
  const scale = mvhd.readUInt32BE(mvhdBox.hdr + (v1 ? 20 : 12));
  const movieDuration = Math.round(durationSec * scale);
  if (v1) mvhd.writeBigUInt64BE(BigInt(movieDuration), mvhdBox.hdr + 24);
  else mvhd.writeUInt32BE(movieDuration, mvhdBox.hdr + 16);
  mvhd.writeUInt32BE(3, mvhd.length - 4);

  // The audio track, renumbered from 1 to 2.
  const aTrakBox = find(aMoov, "trak");
  const aTrak = Buffer.from(slice(aInit, aTrakBox));
  const tkhd = find(inside(aTrak, { at: 0, size: aTrak.length, hdr: aTrakBox.hdr }), "tkhd");
  aTrak.writeUInt32BE(2, tkhd.at + tkhd.hdr + (aTrak[tkhd.at + tkhd.hdr] ? 20 : 12));

  // mvex: the overall length (mehd), then one trex per track.
  const trexOf = (buf, moov) => find(inside(buf, find(moov, "mvex")), "trex");
  const aTrex = Buffer.from(slice(aInit, trexOf(aInit, aMoov)));
  aTrex.writeUInt32BE(2, 12);
  const mehd = Buffer.alloc(8);
  mehd.writeUInt32BE(movieDuration, 4);
  const mvex = box("mvex", box("mehd", mehd), slice(vInit, trexOf(vInit, vMoov)), aTrex);

  // HEVC tagged "hev1" plays in VLC and Android players but not in Apple's; "hvc1"
  // plays everywhere (what ffmpeg's -tag:v hvc1 does).
  const vTrakBuf = Buffer.from(slice(vInit, vTrak));
  const hev1 = vTrakBuf.indexOf("hev1", 0, "latin1");
  if (hev1 >= 0) vTrakBuf.write("hvc1", hev1, "latin1");

  const others = vMoov.filter((b) => !["mvhd", "trak", "mvex"].includes(b.type)).map((b) => slice(vInit, b));
  const moov = box("moov", mvhd, vTrakBuf, aTrak, mvex, ...others);
  return { head: Buffer.concat([slice(vInit, find(vTop, "ftyp")), moov]), videoScale: trackTimescale(vInit, vTrak) };
}

// The moof+mdat of a media segment (styp and the segment's own sidx are dropped),
// with its sequence number set and, for audio, its track id changed to 2.
function fragment(seg, seq, track) {
  const top = boxes(seg);
  const moofBox = find(top, "moof");
  const mdatBox = find(top, "mdat");
  if (!moofBox || !mdatBox) throw new Error("broken video segment");
  const frag = Buffer.from(seg.subarray(moofBox.at, mdatBox.at + mdatBox.size));
  const moof = inside(frag, { at: 0, size: moofBox.size, hdr: moofBox.hdr });
  const mfhd = find(moof, "mfhd");
  frag.writeUInt32BE(seq, mfhd.at + mfhd.hdr + 4);
  for (const traf of moof.filter((b) => b.type === "traf")) {
    const tfhd = find(inside(frag, traf), "tfhd");
    frag.writeUInt32BE(track, tfhd.at + tfhd.hdr + 4);
  }
  return frag;
}

// How long a video fragment plays, in its track's ticks (from tfhd defaults and trun).
function fragmentTicks(frag) {
  const moof = boxes(frag)[0];
  let ticks = 0;
  for (const traf of inside(frag, moof).filter((b) => b.type === "traf")) {
    const parts = inside(frag, traf);
    const tfhd = find(parts, "tfhd");
    const tFlags = frag.readUInt32BE(tfhd.at + tfhd.hdr) & 0xffffff;
    let p = tfhd.at + tfhd.hdr + 8; // after version/flags and track id
    if (tFlags & 0x1) p += 8; // base data offset
    if (tFlags & 0x2) p += 4; // sample description index
    const defaultDuration = tFlags & 0x8 ? frag.readUInt32BE(p) : 0;
    for (const trun of parts.filter((b) => b.type === "trun")) {
      const rFlags = frag.readUInt32BE(trun.at + trun.hdr) & 0xffffff;
      const count = frag.readUInt32BE(trun.at + trun.hdr + 4);
      if (!(rFlags & 0x100)) {
        ticks += count * defaultDuration;
        continue;
      }
      let q = trun.at + trun.hdr + 8 + (rFlags & 0x1 ? 4 : 0) + (rFlags & 0x4 ? 4 : 0);
      const stride = 4 * [0x100, 0x200, 0x400, 0x800].filter((f) => rFlags & f).length;
      for (let i = 0; i < count; i++, q += stride) ticks += frag.readUInt32BE(q);
    }
  }
  return ticks;
}

// sidx with one entry per (video piece + audio piece) pair.
function sidx(entries, timescale) {
  const body = Buffer.alloc(24 + entries.length * 12);
  body.writeUInt32BE(1, 4); // reference track: video
  body.writeUInt32BE(timescale, 8);
  // earliest presentation time, first offset: 0
  body.writeUInt16BE(entries.length, 22);
  entries.forEach(({ size, ticks }, i) => {
    body.writeUInt32BE(size, 24 + i * 12);
    body.writeUInt32BE(ticks, 28 + i * 12);
    body.writeUInt32BE(0x90000000, 32 + i * 12); // starts with a keyframe
  });
  return box("sidx", body);
}

// Writes `target` from the segments: init(kind) and segment(kind, i) return Buffers,
// kind being "video" or "audio"; counts is { video, audio }.
function mux(target, { init, segment, counts, duration }) {
  const { head, videoScale } = joinInit(init("video"), init("audio"), duration);

  // First pass: sizes and lengths for sidx. Second: the pieces themselves.
  const pairs = Math.max(counts.video, counts.audio);
  const build = (i, seq) => {
    const out = [];
    if (i < counts.video) out.push(fragment(segment("video", i), seq++, 1));
    if (i < counts.audio) out.push(fragment(segment("audio", i), seq++, 2));
    return out;
  };
  const entries = [];
  for (let i = 0, seq = 1; i < pairs; i++) {
    const frags = build(i, seq);
    seq += frags.length;
    entries.push({ size: frags.reduce((n, f) => n + f.length, 0), ticks: i < counts.video ? fragmentTicks(frags[0]) : 0 });
  }

  const fd = fs.openSync(target, "w");
  try {
    fs.writeSync(fd, head);
    fs.writeSync(fd, sidx(entries, videoScale));
    for (let i = 0, seq = 1; i < pairs; i++) {
      for (const f of build(i, seq)) {
        fs.writeSync(fd, f);
        seq++;
      }
    }
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { mux };
