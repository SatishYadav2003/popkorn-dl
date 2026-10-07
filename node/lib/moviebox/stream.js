// Watching a MovieBox video without downloading it. The CDN only answers with the
// signed cookie, which a video player can't send, so a local server stands in
// between: it gives the player an HLS playlist of the chosen quality (HLS plays in
// nearly every player, DASH doesn't) and fetches each segment the player asks for,
// with the cookie, the fast way.
const crypto = require("crypto");
const http = require("http");
const { STREAM_PORT } = require("../config");
const { strings, fmt } = require("../shared");
const { segmentUrl } = require("./dash");
const ui = require("../ui");

// A segment's file name on the CDN (they all sit next to the manifest).
const fileOf = (rep, n) => segmentUrl(rep, n).replace(/^.*\//, "");

// One track's playlist: its init segment, then every segment with its length.
function mediaPlaylist(rep) {
  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:7",
    `#EXT-X-TARGETDURATION:${Math.ceil(rep.segSeconds)}`,
    "#EXT-X-PLAYLIST-TYPE:VOD",
    "#EXT-X-MEDIA-SEQUENCE:0",
    `#EXT-X-MAP:URI="${fileOf(rep, -1)}"`,
  ];
  for (let i = 0; i < rep.count; i++) {
    lines.push(`#EXTINF:${rep.segments[i].duration.toFixed(3)},`, fileOf(rep, i));
  }
  lines.push("#EXT-X-ENDLIST", "");
  return lines.join("\n");
}

// The playlist the link points at (/<slug>.m3u8, short enough to copy on a phone):
// the video, with the audio as its sound track. Everything else is under /<slug>/.
const mainPlaylist = (rep, audio, slug) =>
  [
    "#EXTM3U",
    "#EXT-X-VERSION:7",
    "#EXT-X-INDEPENDENT-SEGMENTS",
    `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Audio",DEFAULT=YES,AUTOSELECT=YES,URI="${slug}/audio.m3u8"`,
    `#EXT-X-STREAM-INF:BANDWIDTH=${rep.bandwidth + audio.bandwidth},RESOLUTION=${rep.width}x${rep.height},AUDIO="audio"`,
    `${slug}/video.m3u8`,
    "",
  ].join("\n");

const M3U8 = "application/vnd.apple.mpegurl";

function startServer({ cdn, mpdUrl, rep, manifest }, slug) {
  const base = mpdUrl.replace(/[^/]*$/, "");
  const playlists = {
    [`/${slug}.m3u8`]: mainPlaylist(rep, manifest.audio, slug),
    [`/${slug}/video.m3u8`]: mediaPlaylist(rep),
    [`/${slug}/audio.m3u8`]: mediaPlaylist(manifest.audio),
  };
  const videoInit = fileOf(rep, -1);
  const recent = new Map(); // the last few segments, as promises, for repeat and range requests

  function segment(file) {
    if (!recent.has(file)) {
      const p = cdn.segment(base + file).then((data) => {
        // Same retag as in mux.js, so Apple players take the HEVC too.
        if (file === videoInit) {
          const at = data.indexOf("hev1", 0, "latin1");
          if (at >= 0) data.write("hvc1", at, "latin1");
        }
        return data;
      });
      p.catch(() => recent.delete(file)); // a failed fetch isn't kept
      recent.set(file, p);
      if (recent.size > 8) recent.delete(recent.keys().next().value);
    }
    return recent.get(file);
  }

  const server = http.createServer(async (req, res) => {
    const urlPath = req.url.split("?")[0];
    if (playlists[urlPath]) {
      res.writeHead(200, { "Content-Type": M3U8 });
      return res.end(req.method === "HEAD" ? undefined : playlists[urlPath]);
    }
    const [, linkSlug, file] = /^\/([^/]+)\/([\w.-]+\.m4s)$/.exec(urlPath) || [];
    // Only this stream's own links; an old one saved in the player gets nothing.
    if (linkSlug !== slug) {
      res.writeHead(404);
      return res.end();
    }
    try {
      const data = await segment(file);
      const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || "");
      const [start, end] = m ? [Number(m[1]), m[2] ? Math.min(Number(m[2]), data.length - 1) : data.length - 1] : [0, data.length - 1];
      res.writeHead(m ? 206 : 200, {
        "Content-Type": "video/mp4",
        "Accept-Ranges": "bytes",
        "Content-Length": end - start + 1,
        ...(m && { "Content-Range": `bytes ${start}-${end}/${data.length}` }),
      });
      res.end(req.method === "HEAD" ? undefined : data.subarray(start, end + 1));
    } catch {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    }
  });
  return new Promise((resolve, reject) => {
    server.on("error", (err) => {
      if (err.code === "EADDRINUSE") server.listen(0, "127.0.0.1");
      else reject(err);
    });
    server.once("listening", () => resolve(server));
    server.listen(STREAM_PORT, "127.0.0.1");
  });
}

// Serves the video on a local link until it's stopped. True if it streamed.
async function stream(video) {
  try {
    const slug = crypto.randomBytes(3).toString("hex");
    const server = await startServer(video, slug);
    await ui.streamView(video.name, `http://127.0.0.1:${server.address().port}/${slug}.m3u8`);
    server.closeAllConnections();
    server.close();
    ui.notify("info", fmt(strings.streamEnded, { name: video.name }));
    return true;
  } catch (err) {
    ui.notify("error", fmt(strings.streamStopped, { reason: err.message }));
    return false;
  }
}

module.exports = { stream };
