// MovieBox videos are DASH: a manifest (index.mpd) listing the qualities, with video
// and audio cut into ~5 second pieces ("segments"), each its own small file on the CDN.
// This reads the manifest and fetches segments; mux.js joins them into one file.
const { USER_AGENT } = require("./api");
const { settings } = require("../shared");

// The CDN slows a request down once it has sent 96 KB, so a segment comes fastest as
// several small byte ranges fetched side by side (MovieBox-TUI does the same).
const RANGE = settings.movieboxRange;

// "PT42M20.0S" -> 2540
function seconds(iso) {
  const m = /PT(?:([\d.]+)H)?(?:([\d.]+)M)?(?:([\d.]+)S)?/.exec(iso || "");
  return m ? (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0) : 0;
}

const attrs = (tag) => Object.fromEntries([...tag.matchAll(/([\w:]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));

// Expand <SegmentTimeline><S t? d r?/>...</SegmentTimeline> into { time, duration }
// per segment. `time` stays in timescale units (for $Time$); `duration` is seconds.
function expandTimeline(body, timescale) {
  const list = [];
  let t = 0;
  for (const [, sAttr] of body.matchAll(/<S\s+([^/>]*)\/?>/g)) {
    const a = Object.fromEntries([...sAttr.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
    if (a.t !== undefined) t = Number(a.t);
    const d = Number(a.d);
    const r = Number(a.r || 0);
    for (let i = 0; i <= r; i++) {
      list.push({ time: t, duration: d / timescale });
      t += d;
    }
  }
  return list;
}

// { duration, video: [rep, best first], audio: rep } where a rep is
// { id, height, width, bandwidth, codecs, init, media, start, count, segSeconds, segments }
// init/media are full URLs (media still has its $Number$/$Time$ in it). `segments` is
// per-segment { time, duration } — always present, even for fixed-duration templates.
function parseManifest(xml, mpdUrl) {
  const duration = seconds(attrs(/<MPD[^>]*>/.exec(xml)[0]).mediaPresentationDuration);
  const base = mpdUrl.replace(/[^/]*$/, "");
  const video = [];
  let audio = null;
  for (const [, setTag, body] of xml.matchAll(/(<AdaptationSet[^>]*>)([\s\S]*?)<\/AdaptationSet>/g)) {
    const set = attrs(setTag);
    const bodyNoReps = body.replace(/<Representation[\s\S]*?<\/Representation>/g, "");
    const setTemplate = /<SegmentTemplate[^>]*>/.exec(bodyNoReps);
    const setTimeline = /<SegmentTimeline>([\s\S]*?)<\/SegmentTimeline>/.exec(bodyNoReps)?.[1];
    for (const [, repTag, repBody] of body.matchAll(/(<Representation[^>]*>)([\s\S]*?)<\/Representation>/g)) {
      const rep = attrs(repTag);
      const tplTag = /<SegmentTemplate[^>]*>/.exec(repBody)?.[0] || setTemplate?.[0];
      if (!tplTag) throw new Error("this video's format isn't supported yet");
      const tpl = attrs(tplTag);
      const timescale = Number(tpl.timescale || 1);
      const timelineBody = /<SegmentTimeline>([\s\S]*?)<\/SegmentTimeline>/.exec(repBody)?.[1] ?? setTimeline;
      let segments;
      if (timelineBody) {
        segments = expandTimeline(timelineBody, timescale);
      } else {
        const dUnits = Number(tpl.duration);
        if (!dUnits) throw new Error("this video's format isn't supported yet");
        const segSeconds = dUnits / timescale;
        const count = Math.ceil(duration / segSeconds - 1e-6);
        segments = [];
        for (let i = 0; i < count; i++) {
          segments.push({ time: i * dUnits, duration: Math.min(segSeconds, duration - i * segSeconds) });
        }
      }
      const fill = (s) => base + s.replace(/\$RepresentationID\$/g, rep.id);
      const entry = {
        id: rep.id,
        height: Number(rep.height) || 0,
        width: Number(rep.width) || 0,
        bandwidth: Number(rep.bandwidth) || 0,
        codecs: rep.codecs || "",
        init: fill(tpl.initialization),
        media: fill(tpl.media),
        start: Number(tpl.startNumber ?? 1),
        count: segments.length,
        segSeconds: segments.reduce((m, s) => Math.max(m, s.duration), 0),
        segments,
      };
      const kind = set.contentType || (rep.mimeType || set.mimeType || "").split("/")[0];
      if (kind === "video") video.push(entry);
      else if (kind === "audio" && !audio) audio = entry;
    }
  }
  if (!video.length || !audio) throw new Error("the manifest has no video or no audio");
  video.sort((x, y) => y.height - x.height || y.bandwidth - x.bandwidth);
  return { duration, video, audio };
}

// URL of segment `n` (0-based) of a rep; -1 is its init segment.
function segmentUrl(rep, n) {
  if (n < 0) return rep.init;
  const number = rep.start + n;
  const time = rep.segments?.[n]?.time ?? 0;
  return rep.media
    .replace(/\$Number(?:%0(\d+)d)?\$/g, (_, w) => String(number).padStart(Number(w || 0), "0"))
    .replace(/\$Time\$/g, String(time));
}

// Fetches from the CDN with the signed cookie. `source` is { cookie, refresh() };
// the cookie expires, and on a 403 refresh() asks MovieBox for a new one.
class Cdn {
  constructor(source) {
    this.source = source;
    this.refreshing = null;
  }

  async get(url, range) {
    for (let attempt = 0; ; attempt++) {
      const cookie = this.source.cookie;
      let res;
      try {
        res = await fetch(url, {
          headers: { Cookie: cookie, "User-Agent": USER_AGENT, ...(range && { Range: `bytes=${range[0]}-${range[1]}` }) },
          signal: AbortSignal.timeout(30000),
        });
      } catch (err) {
        if (attempt >= 4) throw err;
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        continue;
      }
      if (res.ok) return res;
      await res.body?.cancel();
      if (res.status === 403 && attempt < 2) {
        // Every request waiting on a 403 shares one refresh.
        if (cookie === this.source.cookie) this.refreshing ??= this.source.refresh().finally(() => (this.refreshing = null));
        await this.refreshing;
        continue;
      }
      if (res.status >= 500 && attempt < 4) continue;
      throw new Error(`the video server answered ${res.status}`);
    }
  }

  async text(url) {
    return (await this.get(url)).text();
  }

  // A whole segment: the first RANGE bytes tell the total, the rest come in parallel.
  async segment(url) {
    const first = await this.get(url, [0, RANGE - 1]);
    const head = Buffer.from(await first.arrayBuffer());
    const total = Number(/\/(\d+)$/.exec(first.headers.get("content-range") || "")?.[1]);
    if (first.status !== 206 || !total || total <= head.length) return head;
    const ranges = [];
    for (let at = head.length; at < total; at += RANGE) ranges.push([at, Math.min(at + RANGE, total) - 1]);
    const rest = await Promise.all(ranges.map(async (r) => Buffer.from(await (await this.get(url, r)).arrayBuffer())));
    return Buffer.concat([head, ...rest]);
  }
}

module.exports = { parseManifest, segmentUrl, Cdn };
