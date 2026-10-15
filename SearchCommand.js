// Builds the direct headless fd/fzf pipeline used by the overlay. User fzf options are
// cleared because options that change the output protocol (for example
// --print-query or --print0) would otherwise turn non-path data into results.
//
// Typed searches are private. /proc/<pid>/cmdline is world-readable, so a query
// or folder scope placed in argv is visible to every local user while the
// search runs. Builders therefore return { command, input }: the command line
// carries only static text and limits, the typed values travel to the shell
// over standard input as NUL-delimited records, and fzf receives the query as
// a quoted --filter option — from an inherited file descriptor on fzf >= 0.47,
// or from FZF_DEFAULT_OPTS (owner-only on procfs) on older fzf. Never an
// argument.

var fdFlags =
  "--hidden --no-ignore-vcs --exclude .git --exclude .cache --exclude node_modules " +
  "--exclude .npm --exclude .steam --exclude .gradle --exclude .cua-driver " +
  "--exclude .local/share/Steam --exclude .local/share/Trash --print0 --strip-cwd-prefix"

var emitFunction =
  "emit_bounded_results() {\n" +
  "  local max_results=$1 max_bytes=$2 count=0 total=0 result size\n" +
  "  while IFS= read -r -d '' result; do\n" +
  "    result=\"$3$result\"\n" +
  "    size=${#result}\n" +
  "    if (( count >= max_results || total + size + 1 > max_bytes )); then break; fi\n" +
  "    printf '%s\\0' \"$result\"\n" +
  "    count=$((count + 1))\n" +
  "    total=$((total + size + 1))\n" +
  "  done\n" +
  "}\n"

var searchScript =
  "export LC_ALL=C\n" +
  "IFS= read -r -d '' fzf_filter || exit 64\n" +
  "IFS= read -r -d '' directory || exit 64\n" +
  "IFS= read -r -d '' prefix || exit 64\n" +
  emitFunction +
  "if [[ ! $1 =~ ^[1-9][0-9]*$ || ! $2 =~ ^[1-9][0-9]*$ ]]; then\n" +
  "  printf 'Invalid search output limit\\n' >&2\n" +
  "  exit 64\n" +
  "fi\n" +
  "if ! cd -- \"$directory\" 2>/dev/null; then\n" +
  "  printf 'Directory is not available: %s\\n' \"$directory\" >&2\n" +
  "  exit 66\n" +
  "fi\n" +
  "if ! command -v fd >/dev/null 2>&1; then\n" +
  "  printf 'Required command not found: fd\\n' >&2\n" +
  "  exit 127\n" +
  "fi\n" +
  "if ! command -v fzf >/dev/null 2>&1; then\n" +
  "  printf 'Required command not found: fzf\\n' >&2\n" +
  "  exit 127\n" +
  "fi\n" +
  // The quoted --filter record must not become an argument: fzf >= 0.47 reads
  // its options from the inherited file descriptor below, so the query is in
  // neither argv nor the environment. Older fzf has no such channel, and
  // FZF_DEFAULT_OPTS is the only alternative that is not a command line;
  // /proc/<pid>/environ is readable only by the owning user.
  "exec 3<<< \"$fzf_filter\"\n" +
  "if fzf --help 2>&1 | grep -q FZF_DEFAULT_OPTS_FILE; then\n" +
  "  export FZF_DEFAULT_OPTS= FZF_DEFAULT_OPTS_FILE=/dev/fd/3\n" +
  "else\n" +
  "  export FZF_DEFAULT_OPTS=\"$fzf_filter\" FZF_DEFAULT_OPTS_FILE=\n" +
  "fi\n" +
  "fd --type f --type d " + fdFlags + " | " +
    "fzf --scheme=path --read0 --print0 | " +
    "emit_bounded_results \"$1\" \"$2\" \"$prefix\"\n" +
  "statuses=(\"${PIPESTATUS[@]}\")\n" +
  "if (( statuses[0] != 0 && statuses[0] != 141 )); then exit \"${statuses[0]}\"; fi\n" +
  "if (( statuses[1] != 0 && statuses[1] != 1 && statuses[1] != 141 )); then exit \"${statuses[1]}\"; fi\n" +
  "exit \"${statuses[2]}\""

function scope(query) {
  var text = String(query)
  var slash = text.lastIndexOf("/")
  var prefix = slash >= 0 ? text.slice(0, slash + 1) : ""
  // Only relative paths below the home root can become a search scope.
  if (prefix.charAt(0) === "/" || prefix.split("/").some(function(part) { return part === ".." || part === "." }))
    return { prefix: "", query: text }
  return { prefix: prefix, query: text.slice(prefix.length) }
}

function normalizedLimit(max) {
  var value = Math.floor(Number(max))
  return isFinite(value) && value > 0 ? value : 1
}

// NUL-delimited records for the subprocess's standard input. NUL is the one
// byte that cannot travel in a C string, so it is stripped defensively.
function inputRecords(values) {
  return values.map(function(value) {
    return String(value).replace(/\0/g, "")
  }).join("\0") + "\0"
}

// POSIX single-quote encoding for fzf's option parser: a value wrapped in
// single quotes is read literally, and an embedded quote is written as '\''
// (close, escaped quote, reopen). Round-trips spaces, quotes, backslashes and
// newlines byte-exactly, and cannot smuggle extra options past the parser.
function quotedOptionValue(value) {
  return "'" + String(value).replace(/\0/g, "").replace(/'/g, "'\\''") + "'"
}

function buildCommand(script, query, directory, maxResults, maxOutputBytes) {
  var scoped = scope(query)
  return {
    command: ["bash", "-c", script, "bash",
      String(normalizedLimit(maxResults)), String(normalizedLimit(maxOutputBytes))],
    input: inputRecords([
      "--filter=" + quotedOptionValue(scoped.query),
      String(directory) + "/" + scoped.prefix,
      scoped.prefix
    ])
  }
}

function searchCommand(query, directory, maxResults, maxOutputBytes) {
  return buildCommand(searchScript, query, directory, maxResults, maxOutputBytes)
}

function completionCommand(query, directory, maxResults, maxOutputBytes) {
  return buildCommand(searchScript.replace("fd --type f --type d", "fd --max-depth 1 --type d"),
    query, directory, maxResults, maxOutputBytes)
}

if (typeof module !== "undefined") {
  module.exports = {
    searchScript: searchScript,
    scope: scope,
    inputRecords: inputRecords,
    quotedOptionValue: quotedOptionValue,
    searchCommand: searchCommand,
    completionCommand: completionCommand
  }
}
