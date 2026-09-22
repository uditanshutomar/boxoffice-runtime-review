#!/usr/bin/env node
// A deterministic check of the summary available to the MCP reviewer.
// This is not proof of which test produced the summary; inspect the execution too.
const fs = require('node:fs')
const { sandboxName } = require('./sandbox-name.cjs')
function checkEvidence(sandbox, { repo, pr, revision, image }) {
  sandbox = sandbox?.sandbox ?? sandbox
  const failures = []
  if (!/@sha256:[a-f0-9]{64}$/.test(image || '')) failures.push('expected image must be pinned by digest')
  if (sandbox?.name !== sandboxName(repo, pr, revision)) failures.push('wrong sandbox name')
  const labels = sandbox?.spec?.labels || {}
  if (labels['signadot/github-repo']?.toLowerCase() !== repo.toLowerCase() ||
      labels['signadot/github-pull-request'] !== String(pr) || labels['boxoffice/revision'] !== revision) {
    failures.push('repository, PR or revision mismatch')
  }
  const images = (sandbox?.spec?.forks || []).flatMap(f => (f.customizations?.images || []).map(i => i.image))
  if (images.length !== 1 || images[0] !== image) failures.push('fork image does not match the expected build digest')
  if (sandbox?.status?.ready !== true) failures.push('sandbox is not ready')
  const tests = sandbox?.status?.testExecutions
  if (!tests || !Array.isArray(tests.phaseCounts)) failures.push('no Smart Test execution evidence')
  else {
    const phases = new Map()
    for (const item of tests.phaseCounts) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        failures.push('invalid execution phase entry'); continue
      }
      const count = item.count === undefined ? 0 : item.count
      if (!['pending', 'in_progress', 'failed', 'succeeded', 'canceled'].includes(item.phase) ||
          !Number.isInteger(count) || count < 0 || phases.has(item.phase)) {
        failures.push('invalid or unknown execution phase'); continue
      }
      phases.set(item.phase, count)
    }
    if ((phases.get('succeeded') || 0) < 1) failures.push('no completed successful execution')
    for (const phase of ['pending', 'in_progress', 'failed', 'canceled']) {
      if ((phases.get(phase) || 0) > 0) failures.push(`execution ${phase}`)
    }
    if (!Number.isInteger(tests.checks?.passed) || tests.checks.passed < 5 ||
        (tests.checks.failed !== undefined && tests.checks.failed !== 0)) {
      failures.push('five passing contract checks with no failures are required')
    }
    const diffs = tests.trafficDiffs
    if (!diffs || typeof diffs !== 'object' || Array.isArray(diffs)) {
      failures.push('no traffic comparison summary')
    } else if (['green', 'yellow', 'red'].some(k => diffs[k] !== undefined &&
        (!Number.isInteger(diffs[k]) || diffs[k] < 0))) {
      failures.push('invalid traffic difference counts')
    } else if ((diffs.red || 0) !== 0) failures.push('unexplained red traffic differences')
  }
  return failures
}
module.exports = { checkEvidence }
if (require.main === module) {
  try {
    const [file, repo, pr, revision, image] = process.argv.slice(2)
    const failures = checkEvidence(JSON.parse(fs.readFileSync(file, 'utf8')), { repo, pr, revision, image })
    if (failures.length) throw new Error(failures.join('; '))
    console.log('PASS: identity, immutable image and completed Smart Test summary')
  } catch (err) { console.error('FAIL:', err.message); process.exitCode = 1 }
}
