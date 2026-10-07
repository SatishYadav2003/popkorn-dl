// Watching without downloading: a tiny local HTTP server that a video player can
// play and seek in. Each byte range the player asks for is fetched from Telegram
// right then and passed straight through; nothing is written to disk.
const crypto = require("crypto");
const http = require("http");
const path = require("path");
const bigInt = require("big-integer");
const { tg } = require("./telegram");
const { CHUNK, STREAM_PORT } = require("./config");
const { requestFile } = require("./bot");
const { newTrail, clearTrail, tempSaved, deleteSaved } = require("./cleanup");
const { strings, fmt } = require("./shared");
const ui = require("./ui");

const MIME = { ".mkv": "video/x-matroska", ".mp4": "video/mp4", ".webm": "video/webm", ".avi": "video/x-msvideo" };

// "bytes=START-END" (either side optional) -> [start, end]; null without a Range
// header, "invalid" when it can't be served.
function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header || "");
  if (!m || (m[1] === "" && m[2] === "")) return null;
  const [start, end] =
    m[1] === ""
      ? [Math.max(0, size - Number(m[2])), size - 1] // "bytes=-N": the last N bytes
      : [Number(m[1]), m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1)];
  return start <= end ? [start, end] : "invalid";
}

function safeDecode(urlPath) {
  try {
    return decodeURIComponent(urlPath);
  } catch {
    return urlPath; // malformed %-escape: just won't match
  }
}

// Resolves once the player has taken what's buffered, or has hung up. Both
// listeners come off together, or every wait would leave one behind.
function waitForPlayer(res) {
  return new Promise((resolve) => {
    const done = () => {
      res.off("drain", done);
      res.off("close", done);
      resolve();
    };
    res.on("drain", done);
    res.on("close", done);
  });
}

// Sends bytes start..end from Telegram to the player.
async function pipeRange(res, savedId, start, end) {
  // Re-read the message each time: the file reference inside it expires after a
  // while, and a player opens a new request for every seek anyway.
  const [fresh] = await tg.client.getMessages("me", { ids: [savedId] });
  let pos = Math.floor(start / CHUNK) * CHUNK; // Telegram only serves whole aligned pieces
  for await (const data of tg.client.iterDownload({ file: fresh.media, offset: bigInt(pos), requestSize: CHUNK })) {
    if (res.destroyed) break; // player seeked or closed
    const from = Math.max(start - pos, 0);
    const to = Math.min(end + 1 - pos, data.length);
    if (to > from && !res.write(data.subarray(from, to))) await waitForPlayer(res);
    pos += data.length;
    if (pos > end) break;
  }
  res.end();
}

// Serves the file at /<slug> only.
function startServer(name, size, savedId, slug) {
  const type = MIME[path.extname(name).toLowerCase()] || "application/octet-stream";
  const server = http.createServer((req, res) => {
    // Only this stream's own link. Every stream uses the same port, so without this
    // an old link saved in the player would quietly play whatever is streaming now.
    if (safeDecode(req.url.split("?")[0]) !== `/${slug}`) {
      res.writeHead(404);
      return res.end();
    }
    const range = parseRange(req.headers.range, size);
    if (range === "invalid") {
      res.writeHead(416, { "Content-Range": `bytes */${size}` });
      return res.end();
    }
    const [start, end] = range || [0, size - 1];
    res.writeHead(range ? 206 : 200, {
      "Content-Type": type,
      "Accept-Ranges": "bytes",
      "Content-Length": end - start + 1,
      ...(range && { "Content-Range": `bytes ${start}-${end}/${size}` }),
    });
    if (req.method === "HEAD") return res.end();
    pipeRange(res, savedId, start, end).catch(() => res.destroy());
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

// A short, new-every-time link name such as "k3f9.mkv": short enough to copy on a
// phone, and different per stream so a link from an earlier stream stops working.
const makeSlug = (name) => crypto.randomBytes(3).toString("hex") + (path.extname(name).toLowerCase() || ".mkv");

// Serves the file on a local link until it's stopped. True if it streamed.
async function stream(button) {
  const trail = newTrail();
  let saved = null;
  try {
    const file = await ui.busy(strings.requesting, requestFile(button, trail));
    if (!file) {
      ui.notify("error", strings.botNoFile);
      return false;
    }
    saved = file.saved;
    tempSaved.add(saved.id);
    const slug = makeSlug(file.name);
    const server = await startServer(file.name, file.size, saved.id, slug);
    await ui.streamView(file.name, `http://127.0.0.1:${server.address().port}/${slug}`);
    server.closeAllConnections();
    server.close();
    ui.notify("info", fmt(strings.streamEnded, { name: file.name }));
    return true;
  } catch (err) {
    ui.notify("error", fmt(strings.streamStopped, { reason: err.message }));
    return false;
  } finally {
    // Nothing is kept: the Saved Messages copy was only there to stream from.
    if (saved) await deleteSaved([saved.id]);
    await clearTrail(trail);
  }
}

module.exports = { stream };
