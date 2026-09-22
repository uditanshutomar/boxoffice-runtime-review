const { test } = require('node:test')
const assert = require('node:assert/strict')
const { sandboxName } = require('../scripts/sandbox-name.cjs')
const { checkEvidence } = require('../scripts/check-evidence.cjs')
const expected = { repo: 'owner/boxoffice-demo', pr: '1', revision: 'a'.repeat(40), image: 'registry/storefront@sha256:' + 'b'.repeat(64) }
const good = () => ({
  name: sandboxName(expected.repo, expected.pr, expected.revision),
  spec: { labels: { 'signadot/github-repo': expected.repo, 'signadot/github-pull-request': expected.pr, 'boxoffice/revision': expected.revision },
    forks: [{ customizations: { images: [{ image: expected.image }] } }] },
  status: { ready: true, testExecutions: { phaseCounts: [{ phase: 'succeeded', count: 1 }, { phase: 'failed' }], checks: { passed: 5 }, trafficDiffs: { green: 2 } } },
})
test('complete evidence for the expected revision passes', () => assert.deepEqual(checkEvidence(good(), expected), []))
test('requires a traffic comparison summary while accepting omitted zero counters', () => {
  for (const value of [undefined, null, [], 'unavailable', 0]) {
    const s = good(); s.status.testExecutions.trafficDiffs = value
    assert.ok(checkEvidence(s, expected).length)
  }
  const s = good(); s.status.testExecutions.trafficDiffs = {}
  assert.deepEqual(checkEvidence(s, expected), [])
})
test('rejects malformed provided numeric counters', () => {
  for (const mutate of [
    t => { t.phaseCounts[1].count = null },
    t => { t.checks.failed = null },
    t => { t.trafficDiffs.red = null },
    t => { t.trafficDiffs.red = '0' },
    t => { t.trafficDiffs.green = -1 },
  ]) {
    const s = good(); mutate(s.status.testExecutions)
    assert.ok(checkEvidence(s, expected).length)
  }
})
test('returns evidence failures for malformed phase entries', () => {
  for (const value of [null, undefined, [], 0, 'succeeded', false]) {
    const s = good(); s.status.testExecutions.phaseCounts = [value]
    assert.ok(checkEvidence(s, expected).length)
  }
})
test('repository and commit changes get distinct valid sandbox names', () => {
  assert.notEqual(sandboxName('another/boxoffice-demo', '1', expected.revision), good().name)
  assert.notEqual(sandboxName(expected.repo, '1', 'c'.repeat(40)), good().name)
  assert.match(good().name, /^box-[a-f0-9]{20}$/)
})
for (const [name, mutate] of [
  ['no tests', s => { delete s.status.testExecutions }],
  ['zero tests', s => { s.status.testExecutions.phaseCounts = [] }],
  ['pending tests', s => s.status.testExecutions.phaseCounts.push({ phase: 'pending', count: 1 })],
  ['failed tests', s => { s.status.testExecutions.phaseCounts[1].count = 1 }],
  ['canceled tests', s => s.status.testExecutions.phaseCounts.push({ phase: 'canceled', count: 1 })],
  ['failed checks despite succeeded execution', s => { s.status.testExecutions.checks.failed = 1 }],
  ['missing checks', s => { delete s.status.testExecutions.checks }],
  ['too few checks', s => { s.status.testExecutions.checks.passed = 1 }],
  ['red differences', s => { s.status.testExecutions.trafficDiffs.red = 1 }],
  ['wrong revision', s => { s.spec.labels['boxoffice/revision'] = 'c'.repeat(40) }],
  ['other repository', s => { s.spec.labels['signadot/github-repo'] = 'another/boxoffice-demo' }],
  ['other PR', s => { s.spec.labels['signadot/github-pull-request'] = '2' }],
  ['wrong name', s => { s.name = 'pr-1' }],
  ['mutable image', s => { s.spec.forks[0].customizations.images[0].image = 'registry/storefront:swallow-errors' }],
  ['not ready', s => { s.status.ready = false }],
  ['unknown phase', s => s.status.testExecutions.phaseCounts.push({ phase: 'unknown', count: 1 })],
]) test(`rejects ${name}`, () => { const s = good(); mutate(s); assert.ok(checkEvidence(s, expected).length) })
