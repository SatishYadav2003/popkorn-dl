// Downloading a MovieBox video: every segment of the chosen quality and of the audio,
// several at a time, each kept as its own file until all are in, then joined into one
// MP4. A segment file only appears once it's complete, so after Ctrl+C or a dropped
// connection the next try fetches just the ones that are missing.
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");
const execFileAsync = promisify(execFile);
const { downloadDir, incompleteDir } = require("../config");
const { writeRecord } = require("../resume");
const { strings, settings, fmt } = require("../shared");
const { segmentUrl } = require("./dash");
const { mux } = require("./mux");
const ui = require("../ui");

const WORKERS = settings.movieboxWorkers;

// `video` is { name, cdn, manifest, rep, subtitle? } from the quality list. True once it's on disk.
async function download(video) {
  const { name, cdn, subtitle } = video;
  const target = path.join(downloadDir, name);
  if (fs.existsSync(target)) {
    ui.notify("success", fmt(strings.alreadyHave, { name }));
    return true;
  }
  try {
    await fetchAll(video, target);
    if (subtitle) {
      await embedSubtitle(target, subtitle, cdn);
    }
    ui.notify("success", fmt(strings.saved, { name }));
    return true;
  } catch (err) {
    ui.notify("error", fmt(strings.downloadStopped, { reason: err.message }));
    return false;
  }
}

async function fetchAll({ name, cdn, manifest, rep }, target) {
  const tracks = { video: rep, audio: manifest.audio };
  const partsDir = path.join(incompleteDir, name + ".parts");
  const recFile = path.join(incompleteDir, name + ".part.json");
  fs.mkdirSync(partsDir, { recursive: true });
  fs.writeFileSync(path.join(incompleteDir, ".nomedia"), ""); // keep video players out
  const file = (kind, i) => path.join(partsDir, `${kind[0]}${i < 0 ? "-init" : String(i).padStart(5, "0")}.m4s`);

  // Every piece as [kind, index]; the two init segments first, they're tiny.
  const pieces = [];
  for (const kind of ["video", "audio"]) {
    pieces.push([kind, -1]);
    for (let i = 0; i < tracks[kind].count; i++) pieces.push([kind, i]);
  }
  // The record only feeds the ↺ marker in result lists; the segment files are the truth.
  const rec = { size: pieces.length, chunk: 1, done: [] };
  pieces.forEach(([kind, i], n) => fs.existsSync(file(kind, i)) && rec.done.push(n));
  const todo = pieces.map((p, n) => [...p, n]).filter(([, , n]) => !rec.done.includes(n));

  const estimate = Math.round(((rep.bandwidth + manifest.audio.bandwidth) / 8) * manifest.duration);
  const view = ui.startDownload(name, estimate);
  let bytes = rec.done.reduce((sum, n) => sum + fs.statSync(file(...pieces[n])).size, 0);
  if (rec.done.length) view.resumed(rec.done.length, pieces.length, bytes);
  writeRecord(recFile, rec);

  let next = 0;
  let failed = null; // the first error stops every worker
  async function worker() {
    while (!failed && next < todo.length) {
      const [kind, i, n] = todo[next++];
      try {
        const data = await cdn.segment(segmentUrl(tracks[kind], i));
        // Written under a temporary name and renamed: a half-written segment never counts.
        fs.writeFileSync(file(kind, i) + ".tmp", data);
        fs.renameSync(file(kind, i) + ".tmp", file(kind, i));
        bytes += data.length;
        view.progress(bytes);
        rec.done.push(n);
        writeRecord(recFile, rec);
      } catch (err) {
        failed ??= err;
      }
    }
  }
  try {
    await Promise.all(Array.from({ length: WORKERS }, worker));
  } finally {
    ui.endDownload();
  }
  if (failed) throw failed;

  // Joining blocks for a few seconds; setImmediate lets the spinner draw first.
  const part = path.join(incompleteDir, name + ".part");
  await ui.busy(
    strings.joining,
    new Promise((resolve, reject) =>
      setImmediate(() => {
        try {
          mux(part, {
            init: (kind) => fs.readFileSync(file(kind, -1)),
            segment: (kind, i) => fs.readFileSync(file(kind, i)),
            counts: { video: rep.count, audio: manifest.audio.count },
            duration: manifest.duration,
          });
          resolve();
        } catch (err) {
          reject(err);
        }
      })
    )
  );
  fs.mkdirSync(downloadDir, { recursive: true });
  fs.renameSync(part, target);
  fs.rmSync(partsDir, { recursive: true, force: true });
  fs.rmSync(recFile, { force: true });
  // Drop the folder too, unless another stopped download is still waiting in it.
  if (fs.readdirSync(incompleteDir).every((f) => f === ".nomedia")) {
    fs.rmSync(incompleteDir, { recursive: true, force: true });
  }
}

// Embed a subtitle SRT into the finished MP4 using ffmpeg.
// Falls back to saving the .srt alongside the video if ffmpeg is unavailable or fails.
async function embedSubtitle(videoPath, subtitle, cdn) {
  let srtContent;
  try {
    const res = await fetch(subtitle.url, { headers: { Cookie: cdn.source.cookie }, signal: AbortSignal.timeout(15000) });
    if (res.ok) srtContent = await res.text();
  } catch {}
  if (!srtContent) {
    try {
      const res = await fetch(subtitle.url, { signal: AbortSignal.timeout(15000) });
      if (res.ok) srtContent = await res.text();
    } catch {}
  }
  if (!srtContent) {
    ui.notify("warning", strings.subtitleFailed || "Subtitle download failed");
    return;
  }

  const srtPath = videoPath + ".tmp.srt";
  const tmpMp4 = videoPath + ".tmp.mp4";
  fs.writeFileSync(srtPath, srtContent);
  try {
    await execFileAsync("ffmpeg", ["-i", videoPath, "-i", srtPath, "-c", "copy", "-c:s", "mov_text", "-y", tmpMp4], { stdio: "pipe" });
    fs.renameSync(tmpMp4, videoPath);
    ui.notify("info", `Subtitle embedded (${subtitle.lang})`);
  } catch {
    // ffmpeg not installed or failed → save srt alongside the video
    const srtFinal = videoPath.replace(/\.mp4$/, `.${subtitle.langCode || subtitle.lang}.srt`);
    fs.renameSync(srtPath, srtFinal);
    ui.notify("warning", "ffmpeg not found — subtitle saved separately");
  } finally {
    try { fs.rmSync(srtPath, { force: true }); } catch {}
    try { fs.rmSync(tmpMp4, { force: true }); } catch {}
  }
}

module.exports = { download };
