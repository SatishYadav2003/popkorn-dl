// Settings and paths shared by every module. Numbers come from shared/settings.json;
// values from .env arrive through process.env, loaded by run.sh.
const path = require("path");
const { settings } = require("./shared");

const downloadDir = path.resolve(process.env.DOWNLOAD_DIR || "downloads");

module.exports = {
  SEARCH_TIMEOUT: settings.searchTimeout * 1000, // ms to wait for the result list / a page turn
  FILE_TIMEOUT: settings.fileTimeout * 1000,     // ms to wait for the file after /start
  CHUNK: settings.chunk,                         // Telegram's max request size
  WORKERS: settings.workers,                     // parallel requests
  STREAM_PORT: settings.streamPort,              // falls back to any free port if taken

  SESSION_FILE: path.join(__dirname, "..", "popkorn.node-session"),
  downloadDir,
  // Half-done downloads and their resume records live here, out of sight. It sits
  // inside downloadDir so the finished file can simply be renamed into place.
  incompleteDir: path.join(downloadDir, ".incomplete"),
};
