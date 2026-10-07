// The resume record kept next to "<name>.part" as "<name>.part.json":
//   { size, chunk, done: [pieces already on disk], saved: [Saved Messages ids] }
const fs = require("fs");
const { CHUNK } = require("./config");

// The record for this .part, or null if there's none we can trust.
function readRecord(recFile, part, size) {
  try {
    const rec = JSON.parse(fs.readFileSync(recFile, "utf8"));
    // Only trust it for the same file, cut the same way, with the .part still there.
    if (rec.size === size && rec.chunk === CHUNK && fs.statSync(part).size === size) return rec;
  } catch {
    // no record, unreadable, or no .part: start fresh
  }
  return null;
}

function writeRecord(recFile, rec) {
  // Write a temp file and rename it, so a Ctrl+C mid-write never leaves half a record.
  fs.writeFileSync(recFile + ".tmp", JSON.stringify(rec));
  fs.renameSync(recFile + ".tmp", recFile);
}

module.exports = { readRecord, writeRecord };
