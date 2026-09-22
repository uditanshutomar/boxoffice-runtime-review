const { test } = require('node:test')
const assert = require('node:assert/strict')
const { checkHostedExecution } = require('../scripts/check-hosted-execution.cjs')
const expected = { name: 'box-test', cluster: 'minikube' }
function fixture() {
  const checks = ['active-hold-idempotent', 'held-seats-rejected', 'quote-with-fees', 'reservation-contract', 'reservation-created'].map(name => ({ name, errors: null }))
  return [{ execution: { id: 'execution-1', spec: { hosted: { testName: 'boxoffice-reservation-contract' }, executionContext: { routing: { sandbox: expected.name }, cluster: expected.cluster } }, status: { phase: 'succeeded' }, results: { checks: { baseline: structuredClone(checks), sandbox: checks } } } }]
}
test('accepts complete named baseline and sandbox checks', () => assert.deepEqual(checkHostedExecution(fixture(), expected), []))
test('rejects missing, unrelated and pending executions', () => {
  assert.notEqual(checkHostedExecution([], expected).length, 0)
  for (const change of [e => e.spec.hosted.testName = 'another-test', e => e.spec.executionContext.routing.sandbox = 'other', e => e.spec.executionContext.cluster = 'other', e => e.status.phase = 'in_progress']) {
    const data = fixture(); change(data[0].execution)
    assert.notEqual(checkHostedExecution(data, expected).length, 0)
  }
})
test('a succeeded phase cannot hide failed baseline or sandbox assertions', () => {
  for (const side of ['baseline', 'sandbox']) {
    const data = fixture(); data[0].execution.results.checks[side][0].errors = [{ message: 'failed' }]
    assert.notEqual(checkHostedExecution(data, expected).length, 0)
  }
})
test('rejects incomplete, duplicate, unrelated or malformed check results', () => {
  for (const change of [c => c.pop(), c => c[0].name = c[1].name, c => c[0].name = 'unrelated', c => delete c[0].errors, c => c[0].errors = 'unknown']) {
    const data = fixture(); change(data[0].execution.results.checks.sandbox)
    assert.notEqual(checkHostedExecution(data, expected).length, 0)
  }
})
