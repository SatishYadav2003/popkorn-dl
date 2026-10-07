// The one UI everything talks to: the full-screen app with a keyboard, the
// line-by-line one when input is piped in.
const { interactive } = require("../input");
const { Tui } = require("./tui");
const { Plain } = require("./plain");

module.exports = interactive ? new Tui() : new Plain();
