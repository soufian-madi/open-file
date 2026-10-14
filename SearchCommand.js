// Builds the two headless search steps used by the overlay: an fd pass that
// indexes the current search scope into a cache file once per scope, and an
// fzf pass that filters that cache on every keystroke. User fzf options are
// cleared because options that change the output protocol (for example
// --print-query or --print0) would otherwise turn non-path data into results.

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

var indexScript =
  "export LC_ALL=C\n" +
  "if ! cd -- \"$1\" 2>/dev/null; then\n" +
  "  printf 'Directory is not available: %s\\n' \"$1\" >&2\n" +
  "  exit 66\n" +
  "fi\n" +
  "if ! command -v fd >/dev/null 2>&1; then\n" +
  "  printf 'Required command not found: fd\\n' >&2\n" +
  "  exit 127\n" +
  "fi\n" +
  "if [[ ! $3 =~ ^[1-9][0-9]*$ ]]; then\n" +
  "  printf 'Invalid index output limit\\n' >&2\n" +
  "  exit 64\n" +
  "fi\n" +
  "directory=${2%/*}\n" +
  "[[ -n $directory && -d $directory && ! -L $directory ]] || exit 73\n" +
  "umask 077\n" +
  "temporary=$(mktemp --tmpdir=\"$directory\" .soufian-open-file-index.XXXXXX) || exit 73\n" +
  "trap 'rm -f -- \"$temporary\"' EXIT\n" +
  "write_bounded() {\n" +
  "  local total=0 size\n" +
  "  while IFS= read -r -d '' result; do\n" +
  "    size=${#result}\n" +
  "    if (( total + size + 1 > $1 )); then break; fi\n" +
  "    printf '%s\\0' \"$result\"\n" +
  "    total=$((total + size + 1))\n" +
  "  done\n" +
  "}\n" +
  "fd --type f --type d " + fdFlags + " | write_bounded \"$3\" > \"$temporary\"\n" +
  "statuses=(\"${PIPESTATUS[@]}\")\n" +
  "if (( statuses[0] != 0 && statuses[0] != 141 )); then exit \"${statuses[0]}\"; fi\n" +
  "mv -fT -- \"$temporary\" \"$2\" || exit 74\n" +
  "trap - EXIT"

var filterScript =
  "export LC_ALL=C\n" +
  emitFunction +
  "if [[ ! $3 =~ ^[1-9][0-9]*$ || ! $4 =~ ^[1-9][0-9]*$ ]]; then\n" +
  "  printf 'Invalid search output limit\\n' >&2\n" +
  "  exit 64\n" +
  "fi\n" +
  "if [[ ! -r $2 ]]; then\n" +
  "  printf 'Search index is not available\\n' >&2\n" +
  "  exit 66\n" +
  "fi\n" +
  "if ! command -v fzf >/dev/null 2>&1; then\n" +
  "  printf 'Required command not found: fzf\\n' >&2\n" +
  "  exit 127\n" +
  "fi\n" +
  "env FZF_DEFAULT_OPTS= FZF_DEFAULT_OPTS_FILE= " +
    "fzf --scheme=path --read0 --print0 --filter=\"$1\" < \"$2\" | " +
    "emit_bounded_results \"$3\" \"$4\" \"$5\"\n" +
  "statuses=(\"${PIPESTATUS[@]}\")\n" +
  "if (( statuses[0] != 0 && statuses[0] != 1 && statuses[0] != 141 )); then exit \"${statuses[0]}\"; fi\n" +
  "exit \"${statuses[1]}\""

var completionScript =
  "export LC_ALL=C\n" +
  emitFunction +
  "if [[ ! $3 =~ ^[1-9][0-9]*$ || ! $4 =~ ^[1-9][0-9]*$ ]]; then\n" +
  "  printf 'Invalid search output limit\\n' >&2\n" +
  "  exit 64\n" +
  "fi\n" +
  "if ! cd -- \"$2\" 2>/dev/null; then\n" +
  "  printf 'Directory is not available: %s\\n' \"$2\" >&2\n" +
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
  "fd --max-depth 1 --type d " + fdFlags + " | " +
    "env FZF_DEFAULT_OPTS= FZF_DEFAULT_OPTS_FILE= " +
    "fzf --scheme=path --read0 --print0 --filter=\"$1\" | " +
    "emit_bounded_results \"$3\" \"$4\" \"$5\"\n" +
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

function indexCommand(directory, cachePath, maxIndexBytes) {
  return [
    "bash", "-c", indexScript, "bash", String(directory), String(cachePath),
    String(normalizedLimit(maxIndexBytes))
  ]
}

function searchCommand(query, cachePath, maxResults, maxOutputBytes) {
  var scoped = scope(query)
  return [
    "bash", "-c", filterScript, "bash", scoped.query, String(cachePath),
    String(normalizedLimit(maxResults)), String(normalizedLimit(maxOutputBytes)), scoped.prefix
  ]
}

function completionCommand(query, directory, maxResults, maxOutputBytes) {
  var scoped = scope(query)
  return [
    "bash", "-c", completionScript, "bash", scoped.query, String(directory) + "/" + scoped.prefix,
    String(normalizedLimit(maxResults)), String(normalizedLimit(maxOutputBytes)), scoped.prefix
  ]
}

if (typeof module !== "undefined") {
  module.exports = {
    indexScript: indexScript,
    filterScript: filterScript,
    completionScript: completionScript,
    scope: scope,
    indexCommand: indexCommand,
    searchCommand: searchCommand,
    completionCommand: completionCommand
  }
}
