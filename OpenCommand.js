// xdg-open does not reliably launch Terminal=true handlers in this session.
// Resolve the file association, and give Neovim its own terminal explicitly
// (foot is Omarchy's default terminal since 4.0).
function command(path) {
  return ["bash", "-c",
    'mime=$(xdg-mime query filetype "$1")\n' +
    'handler=$(xdg-mime query default "$mime")\n' +
    'case "$handler" in\n' +
    '  nvim.desktop|neovim.desktop) exec foot nvim -- "$1" ;;\n' +
    '  *) exec xdg-open "$1" ;;\n' +
    'esac', "bash", String(path)]
}

if (typeof module !== "undefined") module.exports = { command: command }
