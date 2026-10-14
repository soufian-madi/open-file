const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const Search = require('../SearchCommand.js')

test('completes the best immediate folder and then subfolders', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'open-file-completion-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  fs.mkdirSync(path.join(home, 'Adulting', 'Tax papers'), { recursive: true })
  fs.writeFileSync(path.join(home, 'Adulting', 'Tax papers', 'report.md'), '')
  fs.writeFileSync(path.join(home, 'adult-file.md'), '')

  function complete(query) {
    const cmd = Search.completionCommand(query, home, 200, 262144)
    const result = spawnSync(cmd[0], cmd.slice(1), { timeout: 3000 })
    assert.equal(result.status, 0, result.stderr.toString())
    return result.stdout.toString().split('\0').filter(Boolean)
  }

  assert.deepEqual(complete('adult'), ['Adulting/'])
  assert.deepEqual(complete('Adulting/tx'), ['Adulting/Tax papers/'])
  assert.deepEqual(complete('Adulting/Tax papers/'), [])
  // A plain file never completes: completion only ever returns folders.
  assert.deepEqual(complete('adult-file'), [])
})

test('does not scope absolute or parent-traversal queries', () => {
  for (const query of ['/etc/pass', '../foo', 'Adulting/../../foo'])
    assert.deepEqual(Search.scope(query), { prefix: '', query })
})

test('splits completed folder prefixes from the remaining query', () => {
  assert.deepEqual(Search.scope('Adulting/Tax papers/rep'),
    { prefix: 'Adulting/Tax papers/', query: 'rep' })
  assert.deepEqual(Search.scope('report'), { prefix: '', query: 'report' })
})
