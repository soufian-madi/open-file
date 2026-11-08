// Builds the subprocess plans behind the text preview: one that renders the
// first screenful of a text file with bat, the way Omarchy's `ff` previews
// (`bat --style=numbers --color=always`, BAT_THEME=ansi), and one that reads
// the theme's terminal palette so the pane can color bat's ANSI codes.
//
// Privacy: the selected path comes from a typed search, so it is treated like
// the query in SearchCommand.js. The command line carries only static text
// and numeric limits. The path travels over standard input. bat still needs
// the file's name for syntax detection, so that name reaches bat through
// BAT_CONFIG_PATH pointing at an inherited file descriptor (like fzf's
// options in SearchCommand.js), never as an argument. File content reaches
// file(1) and bat through pipes, so no tool sees the path in its argv.
//
// Limits, all enforced inside the subprocess before data reaches QML:
//   - at most maxInputBytes are read from the file at all;
//   - at most maxLines lines, each cut to maxColumns bytes, reach bat, so a
//     multi-megabyte minified line costs no more than a short one (bat leaves
//     such lines unhighlighted and would print all of them);
//   - file(1) and bat run under `timeout`;
//   - bat's output is cut to maxOutputBytes.
//
// What counts as text: file(1)'s charset for the bytes that would be shown
// must be ASCII, UTF-8 or an 8-bit charset. "binary" (NUL bytes, most control
// characters, executables, archives), empty files and UTF-16/32 (which the
// byte-wise line cut would mangle) are refused with a non-zero exit, and the
// pane keeps its placeholder. bat's own binary detection is set to
// no-printing as a second check: it prints nothing then, and an empty result
// also keeps the placeholder.
//
// Control characters other than tab and newline are replaced with U+FFFD
// before bat sees them. bat passes them through unchanged, so a file
// containing "ESC[31m" would otherwise be indistinguishable from bat's own
// color codes. A CR before LF is dropped, so CRLF files read normally.

var previewScript =
  "export LC_ALL=C\n" +
  "IFS= read -r -d '' path || exit 64\n" +
  "IFS= read -r -d '' bat_config || exit 64\n" +
  "max_lines=$1 max_columns=$2 max_input=$3 max_output=$4 seconds=$5\n" +
  "for limit in \"$max_lines\" \"$max_columns\" \"$max_input\" \"$max_output\"; do\n" +
  "  [[ $limit =~ ^[1-9][0-9]*$ ]] || exit 64\n" +
  "done\n" +
  "[[ $seconds =~ ^[1-9][0-9]*$ ]] || exit 64\n" +
  "[[ -f $path && -r $path ]] || exit 66\n" +
  "[[ -s $path ]] || exit 67\n" +
  "for tool in bat file timeout head cut sed; do\n" +
  "  command -v \"$tool\" >/dev/null 2>&1 || exit 127\n" +
  "done\n" +
  "encoding=$(head -c \"$max_input\" < \"$path\" 2>/dev/null |\n" +
  "  timeout -k 1 \"$seconds\" file --brief --mime-encoding -) || exit 69\n" +
  "case $encoding in\n" +
  "  us-ascii|utf-8|iso-8859-*|unknown-8bit) ;;\n" +
  "  *) exit 65 ;;\n" +
  "esac\n" +
  // The user's bat environment and config must not change the output
  // protocol (pager, style, theme, wrapping...). The config file we provide
  // carries only --file-name; every format option is an explicit argument.
  "unset \"${!BAT_@}\"\n" +
  "exec 3<<< \"$bat_config\"\n" +
  "export BAT_CONFIG_PATH=/dev/fd/3\n" +
  "head -c \"$max_input\" < \"$path\" 2>/dev/null |\n" +
  "  head -n \"$max_lines\" |\n" +
  "  cut -b \"1-$max_columns\" |\n" +
  "  sed -e $'s/\\r$//' -e 's/[\\x01-\\x08\\x0b-\\x1f\\x7f]/\\xef\\xbf\\xbd/g' |\n" +
  "  timeout -k 1 \"$seconds\" bat --color=always --style=plain --theme=ansi \\\n" +
  "    --paging=never --wrap=never --tabs=4 --italic-text=never --binary=no-printing \\\n" +
  "    --line-range=\":$max_lines\" 2>/dev/null |\n" +
  "  head -c \"$max_output\"\n" +
  "statuses=(\"${PIPESTATUS[@]}\")\n" +
  // bat stops with SIGPIPE (141) when the output limit closes the pipe.
  "(( statuses[4] == 0 || statuses[4] == 141 )) || exit \"${statuses[4]}\"\n" +
  "exit 0"

var paletteScript =
  "export LC_ALL=C\n" +
  "[[ $1 =~ ^[1-9][0-9]*$ ]] || exit 64\n" +
  "command -v omarchy-theme-color >/dev/null 2>&1 || exit 127\n" +
  "timeout -k 1 2 omarchy-theme-color --all 2>/dev/null | head -c \"$1\"\n" +
  "exit \"${PIPESTATUS[0]}\""

function normalizedLimit(value, fallback) {
  var n = Math.floor(Number(value))
  return isFinite(n) && n > 0 ? n : fallback
}

// The last path segment, with any trailing slash ignored.
function baseName(path) {
  var p = String(path || "").replace(/\/+$/, "")
  return p.slice(p.lastIndexOf("/") + 1)
}

// One line of a bat config file. bat splits its config into lines and each
// line into words like a POSIX shell, so the name is single-quoted (an
// embedded quote becomes '\'') and line breaks, which no quoting survives,
// become spaces. The name is only used to pick a syntax.
function fileNameConfig(path) {
  var name = baseName(path).replace(/\0/g, "").replace(/[\r\n]/g, " ")
  return "--file-name='" + name.replace(/'/g, "'\\''") + "'\n"
}

// NUL-delimited records for standard input (see SearchCommand.inputRecords).
function inputRecords(values) {
  return values.map(function(value) {
    return String(value).replace(/\0/g, "")
  }).join("\0") + "\0"
}

var defaults = {
  maxLines: 60,
  maxColumns: 512,
  maxInputBytes: 65536,
  maxOutputBytes: 131072,
  seconds: 2
}
// Never ask for more than this many lines, whatever the pane's height.
var lineCeiling = 200

function previewCommand(path, limits) {
  var l = limits || {}
  return {
    command: ["bash", "-c", previewScript, "bash",
      String(Math.min(lineCeiling, normalizedLimit(l.maxLines, defaults.maxLines))),
      String(normalizedLimit(l.maxColumns, defaults.maxColumns)),
      String(normalizedLimit(l.maxInputBytes, defaults.maxInputBytes)),
      String(normalizedLimit(l.maxOutputBytes, defaults.maxOutputBytes)),
      String(normalizedLimit(l.seconds, defaults.seconds))],
    input: inputRecords([String(path), fileNameConfig(path)])
  }
}

function paletteCommand(maxBytes) {
  return {
    command: ["bash", "-c", paletteScript, "bash", String(normalizedLimit(maxBytes, 16384))],
    input: ""
  }
}

if (typeof module !== "undefined") {
  module.exports = {
    previewScript: previewScript,
    paletteScript: paletteScript,
    defaults: defaults,
    lineCeiling: lineCeiling,
    baseName: baseName,
    fileNameConfig: fileNameConfig,
    inputRecords: inputRecords,
    previewCommand: previewCommand,
    paletteCommand: paletteCommand
  }
}
