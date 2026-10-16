const test = require("node:test")
const assert = require("node:assert/strict")
const ScopeState = require("../ScopeState.js")

test("round-trips the remembered folder scope", () => {
  assert.equal(ScopeState.parse(ScopeState.serialize("Projects/open-file/")), "Projects/open-file/")
  assert.equal(ScopeState.parse(ScopeState.serialize("")), "")
  assert.equal(ScopeState.parse(ScopeState.serialize("Documents/Tax papers/")), "Documents/Tax papers/")
})

test("treats the empty scope as the home root", () => {
  assert.equal(ScopeState.parse(""), "")
  assert.equal(ScopeState.parse("not json"), "")
  assert.equal(ScopeState.parse("null"), "")
  assert.equal(ScopeState.parse('{"version":2,"scope":"Projects/"}'), "")
  assert.equal(ScopeState.parse('{"version":1}'), "")
  assert.equal(ScopeState.parse('{"version":1,"scope":7}'), "")
})

test("rejects absolute, traversal, and malformed scopes", () => {
  for (const scope of ["/etc/", "../other/", "a/../b/", "a/./b/", "a//b/", "relative"]) {
    assert.equal(ScopeState.validate(scope), null, scope)
    assert.equal(ScopeState.serialize(scope), "", scope)
    assert.equal(ScopeState.parse(JSON.stringify({ version: 1, scope })), "", scope)
  }
})
