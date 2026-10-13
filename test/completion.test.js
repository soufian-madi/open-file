const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const Search = require('../SearchCommand.js')

test('completes immediate directories and searches within completed paths', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fzf-completion-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  fs.mkdirSync(path.join(home, 'Adulting', 'Tax papers'), { recursive: true })
  fs.writeFileSync(path.join(home, 'Adulting', 'Tax papers', 'report.md'), '')
  fs.writeFileSync(path.join(home, 'adult-file.md'), '')
  fs.writeFileSync(path.join(home, 'outside-report.md'), '')
  function run(query, completion) {
    const cmd = Search.command(query, home, 200, 262144, completion)
    const result = spawnSync(cmd[0], cmd.slice(1), { timeout: 3000 })
    assert.equal(result.status, 0, result.stderr.toString())
    return result.stdout.toString().split('\0').filter(Boolean)
  }
  assert.deepEqual(run('adult', true), ['Adulting/'])
  assert.deepEqual(run('Adulting/tx', true), ['Adulting/Tax papers/'])
  assert.deepEqual(run('Adulting/Tax papers/', true), [])
  assert.deepEqual(run('Adulting/Tax papers/rep', false), ['Adulting/Tax papers/report.md'])
  assert.deepEqual(run('Adulting/rep', false), ['Adulting/Tax papers/report.md'])
})

test('does not scope absolute or parent-traversal queries', () => {
  for (const query of ['/etc/pass', '../foo', 'Adulting/../../foo'])
    assert.deepEqual(Search.scope(query), { prefix: '', query })
})
