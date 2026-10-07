// Downloading a file to disk: 4 pieces at a time, resumable.
const fs = require("fs");
const path = require("path");
const bigInt = require("big-integer");
const { tg } = require("./telegram");
const { CHUNK, WORKERS, downloadDir, incompleteDir } = require("./config");
const { requestFile } = require("./bot");
const { newTrail, clearTrail } = require("./cleanup");
const { readRecord, writeRecord } = require("./resume");
const { strings, fmt } = require("./shared");
const ui = require("./ui");

// Download in CHUNK-sized pieces with WORKERS requests in flight, like the Telegram app does.
// Each finished piece is recorded, so after Ctrl+C or a dropped connection the next
// try only fetches what's missing. Progress goes to `view` (from ui.startDownload).
// Returns every Saved Messages copy used for this file.
async function fetchParallel(media, size, target, savedId, view) {
  fs.mkdirSync(incompleteDir, { recursive: true });
  fs.writeFileSync(path.join(incompleteDir, ".nomedia"), ""); // keep video players out
  const part = path.join(incompleteDir, path.basename(target) + ".part");
  const recFile = part + ".json";
  const chunks = Math.ceil(size / CHUNK);
  const chunkBytes = (i) => Math.min(CHUNK, size - i * CHUNK);

  let rec = readRecord(recFile, part, size);
  if (!rec) {
    rec = { size, chunk: CHUNK, done: [], saved: [] };
    const fd = fs.openSync(part, "w");
    fs.ftruncateSync(fd, size);
    fs.closeSync(fd);
  }
  if (!rec.saved.includes(savedId)) rec.saved.push(savedId);
  writeRecord(recFile, rec);

  const done = new Set(rec.done);
  const todo = [...Array(chunks).keys()].filter((i) => !done.has(i));
  let bytes = [...done].reduce((sum, i) => sum + chunkBytes(i), 0);
  if (done.size) view.resumed(done.size, chunks, bytes);
  let next = 0;

  const fd = fs.openSync(part, "r+");
  async function worker() {
    while (next < todo.length) {
      const i = todo[next++];
      for await (const data of tg.client.iterDownload({
        file: media,
        offset: bigInt(i * CHUNK),
        requestSize: CHUNK,
        limit: 1,
      })) {
        fs.writeSync(fd, data, 0, data.length, i * CHUNK);
        bytes += data.length;
        view.progress(bytes, size);
      }
      // Only after the piece is written; recording it first would let a Ctrl+C
      // mark a piece as done while the file still has zeros there.
      done.add(i);
      rec.done = [...done];
      writeRecord(recFile, rec);
    }
  }

  try {
    await Promise.all(Array.from({ length: WORKERS }, worker));
  } finally {
    fs.closeSync(fd);
  }
  if (done.size !== chunks || fs.statSync(part).size !== size) {
    throw new Error(`incomplete, ${done.size}/${chunks} pieces`);
  }
  fs.renameSync(part, target);
  fs.unlinkSync(recFile);
  // Drop the folder too, unless another stopped download is still waiting in it.
  if (fs.readdirSync(incompleteDir).every((f) => f === ".nomedia")) {
    fs.rmSync(incompleteDir, { recursive: true, force: true });
  }
  return rec.saved;
}

async function fetchFile(button, trail) {
  const file = await ui.busy(strings.requesting, requestFile(button, trail));
  if (!file) {
    ui.notify("error", strings.botNoFile);
    return false;
  }
  const { saved, name, size } = file;
  const target = path.join(downloadDir, name);
  let savedIds = [saved.id];
  if (fs.existsSync(target) && fs.statSync(target).size === size) {
    ui.notify("success", fmt(strings.alreadyHave, { name }));
  } else {
    fs.mkdirSync(downloadDir, { recursive: true });
    const view = ui.startDownload(name, size);
    try {
      savedIds = await fetchParallel(saved.media, size, target, saved.id, view);
    } finally {
      ui.endDownload();
    }
    ui.notify("success", fmt(strings.saved, { name }));
  }
  // Only once the file is safely on disk; if the download failed it stays in Saved
  // Messages. After a resume this also removes the copies left by earlier tries.
  await tg.client.deleteMessages("me", savedIds, { revoke: true });
  return true;
}

// True once the file is on disk.
async function download(button) {
  const trail = newTrail();
  try {
    return await fetchFile(button, trail);
  } catch (err) {
    ui.notify("error", fmt(strings.downloadStopped, { reason: err.message }));
    return false;
  } finally {
    await clearTrail(trail);
  }
}

module.exports = { download };
