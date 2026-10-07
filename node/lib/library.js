// What's already on disk, so results can be marked as had (✔) or half-downloaded (↺ 45%).
const fs = require("fs");
const path = require("path");
const { downloadDir, incompleteDir } = require("./config");

// The bot's result name and the real file name differ only in separators:
//   "The Flash 2014 S05E19 720p WEBRip x265 PSA mkv"  vs  "The_Flash_2014_S05E19_720p_WEBRip_x265_PSA.mkv"
// so both are compared as just their letters and digits.
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

const listDir = (dir) => {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile());
  } catch {
    return []; // folder doesn't exist yet
  }
};

// key -> { size, pct, file }; pct is null for a finished file, and `file` is a
// half-done one's real name in .incomplete/ (what discardPartial needs).
function scanLocal() {
  const local = new Map();
  for (const e of listDir(downloadDir)) {
    local.set(norm(e.name), { size: fs.statSync(path.join(downloadDir, e.name)).size, pct: null });
  }
  for (const e of listDir(incompleteDir)) {
    if (!e.name.endsWith(".part.json")) continue;
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(incompleteDir, e.name), "utf8"));
      const pct = Math.min(100, (rec.done.length * rec.chunk * 100) / rec.size);
      const file = e.name.slice(0, -".part.json".length);
      local.set(norm(file), { size: rec.size, pct, file });
    } catch {
      // unreadable record: no marker
    }
  }
  return local;
}

// For one result (from describeResult): { kind: "have" } / { kind: "partial", pct, file } / null.
function markerFor(result, local) {
  const hit = local.get(norm(result.name));
  // The bot rounds the size it shows, so allow 2%; a bigger gap means a different file.
  if (!hit || (result.bytes && Math.abs(hit.size - result.bytes) / result.bytes > 0.02)) return null;
  return hit.pct === null ? { kind: "have" } : { kind: "partial", pct: Math.floor(hit.pct), file: hit.file };
}

// The same marker for any file whose name starts with `prefix`, e.g. an episode
// downloaded in any quality ("The Flash S05E21" matches "The Flash S05E21 720p.mp4").
function markerForPrefix(prefix, local) {
  const key = norm(prefix);
  const hits = [...local].filter(([name]) => name.startsWith(key)).map(([, hit]) => hit);
  if (hits.some((h) => h.pct === null)) return { kind: "have" };
  return hits.length ? { kind: "partial", pct: Math.floor(Math.max(...hits.map((h) => h.pct))) } : null;
}

// Throws away a half-done download: everything named `file` in .incomplete/
// (Telegram's .part, MovieBox's .parts/ folder, the record), and the folder too
// once nothing else is waiting in it. Returns the Saved Messages ids the record
// listed (Telegram only), for the caller to delete.
function discardPartial(file) {
  let saved = [];
  try {
    saved = JSON.parse(fs.readFileSync(path.join(incompleteDir, file + ".part.json"), "utf8")).saved || [];
  } catch {
    // no readable record: just the files go
  }
  for (const suffix of [".part", ".part.json", ".part.json.tmp", ".parts"]) {
    fs.rmSync(path.join(incompleteDir, file + suffix), { recursive: true, force: true });
  }
  try {
    if (fs.readdirSync(incompleteDir).every((n) => n === ".nomedia")) {
      fs.rmSync(incompleteDir, { recursive: true, force: true });
    }
  } catch {
    // folder already gone
  }
  return saved;
}

module.exports = { scanLocal, markerFor, markerForPrefix, discardPartial };
