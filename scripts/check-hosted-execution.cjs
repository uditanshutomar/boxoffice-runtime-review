const names = ['active-hold-idempotent', 'held-seats-rejected', 'quote-with-fees', 'reservation-contract', 'reservation-created']

function checkHostedExecution(entries, { name, cluster }) {
  const failures = []
  if (!Array.isArray(entries)) return ['hosted execution list is unavailable']
  const executions = entries.map(item => item.execution ?? item).filter(e =>
    e.spec?.hosted?.testName === 'boxoffice-reservation-contract' &&
    e.spec?.executionContext?.routing?.sandbox === name &&
    e.spec?.executionContext?.cluster === cluster)
  if (!executions.length) return ['no matching hosted reservation execution']
  for (const execution of executions) {
    if (execution.status?.phase !== 'succeeded') failures.push(`hosted execution ${execution.id} is not complete`)
    for (const side of ['baseline', 'sandbox']) {
      const checks = execution.results?.checks?.[side]
      if (!Array.isArray(checks) || checks.length !== names.length ||
          new Set(checks.map(c => c.name)).size !== names.length ||
          !names.every(name => checks.some(c => c.name === name))) {
        failures.push(`${side}: expected five named reservation checks`)
      } else if (checks.some(c => c.errors !== null && (!Array.isArray(c.errors) || c.errors.length))) {
        failures.push(`${side}: reservation assertions failed or results are malformed`)
      }
    }
  }
  return failures
}
module.exports = { checkHostedExecution }
