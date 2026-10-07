// The files in ../../shared/, which the Python version reads too: colours and logo,
// on-screen text, the bot's reply format, and the numbers both versions use.
// moviebox.json (how the MovieBox app talks to its server) is Node-only for now.
const fs = require("fs");
const path = require("path");

const SHARED_DIR = path.join(__dirname, "..", "..", "shared");
const load = (name) => JSON.parse(fs.readFileSync(path.join(SHARED_DIR, `${name}.json`), "utf8"));

const theme = load("theme");
const strings = load("strings");
const botFormat = load("bot");
const settings = load("settings");
const movieboxApp = load("moviebox");

// fmt("Saved {name}", { name: "x.mkv" }) -> "Saved x.mkv"; {dot} is the theme's separator.
const fmt = (template, vars = {}) =>
  template.replace(/\{(\w+)\}/g, (m, key) =>
    key in vars ? String(vars[key]) : key === "dot" ? theme.symbols.dot : m
  );

module.exports = { theme, strings, botFormat, settings, movieboxApp, fmt };
