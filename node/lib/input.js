// Keyboard input for whole lines: the login code, and everything when input is piped.
// (The full-screen UI reads single keys itself, in ui/tui.js.)
const readline = require("readline");

const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);

// Piped input (no keyboard, e.g. tests): one long-lived reader with a line queue,
// so lines that arrive early aren't dropped.
const lines = [];
const waiters = [];
let pipeReader = null;
if (!interactive) {
  pipeReader = readline.createInterface({ input: process.stdin });
  pipeReader.on("line", (l) => (waiters.length ? waiters.shift()(l) : lines.push(l)));
  pipeReader.on("close", () => waiters.splice(0).forEach((w) => w("")));
}

function ask(prompt) {
  if (!interactive) {
    process.stdout.write(prompt);
    return new Promise((resolve) => {
      if (lines.length) resolve(lines.shift().trim());
      else waiters.push((l) => resolve(l.trim()));
    });
  }
  // A fresh reader per question: a long-lived one would also swallow the
  // full-screen UI's key presses and hand them back later as a typed line.
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl.on("SIGINT", () => process.emit("SIGINT")); // readline catches Ctrl+C otherwise
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

const closeInput = () => pipeReader?.close();

module.exports = { interactive, ask, closeInput };
