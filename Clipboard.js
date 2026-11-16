// Bounded clipboard paste for the search fields.
//
// Qt's own paste (TextInput's Ctrl+V / Shift+Insert, and middle-click from
// the primary selection) calls QClipboard::text(), which on Wayland reads the
// offer's pipe until EOF on the GUI thread. Its one-second poll timeout
// restarts after every chunk, so a clipboard owner that keeps streaming would
// hang the shell and grow memory without bound. Fzf.qml therefore swallows
// those native paths and pastes through this subprocess instead:
//
// - `head -c` caps the bytes that ever reach the QML collector; wl-paste gets
//   SIGPIPE once the cap is hit, so an endless stream ends there.
// - `timeout` gives the read a total deadline, so a stalled owner that never
//   sends anything ends too. Fzf.qml adds its own watchdog on top.
// - The paste runs off the GUI thread: the shell never blocks on it.
//
// Nothing user-typed travels here; the command takes only a byte limit and the
// selection to read.

var pasteScript =
  "export LC_ALL=C\n" +
  "limit=$1\n" +
  "selection=$2\n" +
  "[[ $limit =~ ^[1-9][0-9]*$ ]] || exit 64\n" +
  "args=(--no-newline --type text)\n" +
  "[[ $selection == primary ]] && args+=(--primary)\n" +
  "command -v wl-paste >/dev/null 2>&1 || exit 69\n" +
  "timeout -k 0.5 1 wl-paste \"${args[@]}\" 2>/dev/null | head -c \"$limit\""

function normalizedLimit(maxBytes) {
  var value = Math.floor(Number(maxBytes))
  return isFinite(value) && value > 0 ? value : 1
}

// primary: true reads the primary selection (middle-click paste).
function pasteCommand(primary, maxBytes) {
  return {
    command: ["bash", "-c", pasteScript, "bash",
      String(normalizedLimit(maxBytes)), primary ? "primary" : "clipboard"],
    input: ""
  }
}

// Turns pasted bytes into one line of field text: the first line only,
// without control characters, a replacement character left by cutting a
// multi-byte sequence at the byte cap, or anything past maxChars.
function sanitize(raw, maxChars) {
  var text = String(raw || "")
  var newline = text.search(/[\r\n]/)
  if (newline !== -1) text = text.slice(0, newline)
  text = text.replace(/[\u0000-\u001f\u007f]/g, "")
  text = text.replace(/�+$/, "")
  var limit = Math.floor(Number(maxChars))
  if (isFinite(limit) && limit >= 0 && text.length > limit) text = text.slice(0, limit)
  return text
}

if (typeof module !== "undefined") {
  module.exports = { pasteCommand, sanitize }
}
