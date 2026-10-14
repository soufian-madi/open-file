// Persistent state for the folder scope the overlay last searched in. A scope
// is a home-relative folder prefix such as "Projects/open-file/" — the query
// text up to and including its last slash. The empty scope is the home root.

function validate(scope) {
  var value = String(scope)
  if (value === "") return ""
  if (value.charAt(0) === "/") return null
  if (value.charAt(value.length - 1) !== "/") return null
  var parts = value.split("/")
  for (var i = 0; i < parts.length - 1; i++) {
    if (parts[i] === "" || parts[i] === "." || parts[i] === "..") return null
  }
  return value
}

function parse(raw) {
  var text = String(raw || "").trim()
  try {
    var state = JSON.parse(text)
    if (!state || state.version !== 1 || typeof state.scope !== "string") return ""
    var scope = validate(state.scope)
    return scope === null ? "" : scope
  } catch (e) {
    return ""
  }
}

function serialize(scope) {
  var value = validate(scope)
  if (value === null) return ""
  return JSON.stringify({ version: 1, scope: value }) + "\n"
}

if (typeof module !== "undefined") {
  module.exports = {
    validate: validate,
    parse: parse,
    serialize: serialize
  }
}
