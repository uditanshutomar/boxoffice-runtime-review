const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const path = require('node:path')
const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boxoffice-services-'))
const { Pool } = require('../pkg/inventory/node_modules/pg')
const root = path.resolve(__dirname, '..')
const children = []
const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const inventory = 'http://127.0.0.1:18081'
const pricing = 'http://127.0.0.1:18082'
const baseline = 'http://127.0.0.1:18080'
const safe = 'http://127.0.0.1:18083'
const broken = 'http://127.0.0.1:18084'
const dropFees = 'http://127.0.0.1:18085'
const deadUpstream = 'http://127.0.0.1:18086'

async function start(file, service, port, extra = {}) {
  let logs = ''
  const serviceDir = path.join(runtimeDir, String(port))
  fs.mkdirSync(serviceDir)
  fs.copyFileSync(path.join(root, file), path.join(serviceDir, 'app.js'))
  fs.symlinkSync(path.join(root, `pkg/${service}/node_modules`), path.join(serviceDir, 'node_modules'))
  const child = spawn(process.execPath, [path.join(serviceDir, 'app.js')], {
    env: { ...process.env, PORT: String(port), INVENTORY_URL: inventory, PRICING_URL: pricing,
      NODE_PATH: path.join(root, `pkg/${service}/node_modules`), ...extra },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.push(child)
  child.stdout.on('data', data => { logs += data })
  child.stderr.on('data', data => { logs += data })
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(logs)
    try {
      if ((await fetch(`http://127.0.0.1:${port}/${service === 'storefront' ? 'healthz' : 'readyz'}`)).ok) return
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`Service did not become ready: ${logs}`)
}
async function post(base, route, body, headers = {}) {
  const r = await fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body), signal: AbortSignal.timeout(8000) })
  return { status: r.status, body: await r.json() }
}
const reservation = (key, seats, extra = {}) => ({ showId: 'show-1', seats, idempotencyKey: key, ...extra })

before(async () => {
  assert.ok(process.env.DATABASE_URL, 'Use scripts/test-local.sh with disposable databases')
  await start('pkg/inventory/app.js', 'inventory', 18081)
  await start('pkg/pricing/app.js', 'pricing', 18082)
  await start('pkg/storefront/app.js', 'storefront', 18080)
  await start('lessons/safe-refactor/storefront/app.js', 'storefront', 18083)
  await start('lessons/swallow-errors/storefront/app.js', 'storefront', 18084)
  await start('lessons/drop-fees/pricing/app.js', 'pricing', 18085, { CACHE_NAMESPACE: 'drop-fees' })
  await start('pkg/storefront/app.js', 'storefront', 18086, { INVENTORY_URL: 'http://127.0.0.1:1' })
})
after(async () => {
  await Promise.all(children.map(child => new Promise(resolve => {
    if (child.exitCode !== null) return resolve()
    child.once('exit', resolve); child.kill()
  })))
  await pool.end()
  fs.rmSync(runtimeDir, { recursive: true, force: true })
})

test('baseline creates a real hold and correct integer quote', async () => {
  const r = await post(baseline, '/reservations', reservation('valid', ['A1', 'A2']))
  assert.equal(r.status, 201)
  assert.equal(r.body.status, 'held')
  assert.match(r.body.reservationId, /^rsv_[a-f0-9]+$/)
  assert.deepEqual(r.body.seats, ['A1', 'A2'])
  assert.ok(Date.parse(r.body.expiresAt) > Date.now())
  assert.deepEqual(r.body.quote, { currency: 'USD', subtotal: 9000, fees: 450, total: 9450 })
})
test('a retry and safe refactor return the same active reservation', async () => {
  const input = reservation('retry', ['B1', 'B2'])
  const first = await post(baseline, '/reservations', input)
  const repeat = await post(baseline, '/reservations', input)
  const refactor = await post(safe, '/reservations', input)
  assert.deepEqual(repeat, first)
  assert.deepEqual(refactor, first)
})
test('an idempotency key cannot be reused with different seats or show', async () => {
  assert.equal((await post(inventory, '/reservations', reservation('retry', ['B3']))).status, 409)
  assert.equal((await post(inventory, '/reservations', reservation('retry', ['B1', 'B2'], { showId: 'other' }))).status, 409)
})
test('concurrent attempts at one free seat produce exactly one hold', async () => {
  const results = await Promise.all(Array.from({ length: 24 }, (_, i) =>
    post(inventory, '/reservations', reservation(`race-${i}`, ['A3']))))
  assert.equal(results.filter(r => r.status === 201).length, 1)
  assert.equal(results.filter(r => r.status === 409).length, 23)
  assert.equal((await pool.query("select * from reservations where 'A3' = any(seats) and status = 'held'")).rowCount, 1)
})
test('concurrent retries create only one reservation', async () => {
  const results = await Promise.all(Array.from({ length: 12 }, () =>
    post(inventory, '/reservations', reservation('same-race', ['A4']))))
  assert.equal(results.filter(r => r.status === 201).length, 1)
  assert.equal(results.filter(r => r.status === 200).length, 11)
  for (const r of results) assert.deepEqual(r.body, results[0].body)
})
test('nonexistent and malformed requests never acquire seats', async () => {
  for (const seats of [['A0'], ['A13'], ['A5', 'A5'], [42], [], ['__proto__']]) {
    assert.equal((await post(inventory, '/reservations', reservation('invalid', seats))).status, 400)
  }
  assert.equal((await post(inventory, '/reservations', reservation('unknown', ['A5'], { showId: 'missing' }))).status, 404)
  assert.equal((await post(inventory, '/reservations', reservation(42, ['A5']))).status, 400)
  assert.equal((await pool.query("select status from seats where show_id='show-1' and seat='A5'")).rows[0].status, 'free')
})
test('expiry frees seats on read and permits a fresh hold', async () => {
  const initial = await post(inventory, '/reservations', reservation('expiry', ['A6']))
  await pool.query("update reservations set expires_at = now() - interval '1 second' where reservation_id=$1", [initial.body.reservationId])
  const seats = await (await fetch(inventory + '/shows/show-1/seats')).json()
  assert.equal(seats.seats.find(s => s.seat === 'A6').status, 'free')
  const renewed = await post(inventory, '/reservations', reservation('expiry', ['A6']))
  assert.equal(renewed.status, 201)
  assert.equal(renewed.body.reservationId, initial.body.reservationId)
  assert.notEqual(renewed.body.expiresAt, initial.body.expiresAt)
})
test('conflict is 409 on baseline and safe refactor; swallow-errors is detected', async () => {
  await post(baseline, '/reservations', reservation('conflict-owner', ['C1']))
  for (const base of [baseline, safe]) {
    const r = await post(base, '/reservations', reservation('conflict-other', ['C1']))
    assert.equal(r.status, 409)
    assert.deepEqual(r.body.unavailable, ['C1'])
  }
  const r = await post(broken, '/reservations', reservation('conflict-other', ['C1']))
  assert.equal(r.status, 201)
  assert.equal(r.body.reservationId, undefined)
  assert.equal(r.body.status, undefined)
  assert.ok(r.body.quote)
})
test('sandbox pricing cannot consume a baseline cached quote or poison it', async () => {
  const body = { showId: 'show-1', seats: ['C2'], currency: 'USD' }
  assert.equal((await post(pricing, '/quotes', body)).body.fees, 125)
  const changed = await post(dropFees, '/quotes', body)
  assert.equal(changed.body.fees, undefined)
  assert.equal(changed.body.total, 2500)
  assert.equal((await post(pricing, '/quotes', body)).body.total, 2625)
})
test('currency quote keeps integer components and rejects inherited object keys', async () => {
  const body = { showId: 'show-1', seats: ['A7'], currency: 'EUR' }
  assert.deepEqual((await post(pricing, '/quotes', body)).body, { currency: 'EUR', subtotal: 4140, fees: 207, total: 4347 })
  for (const currency of ['toString', '__proto__', 'AUD', ['USD'], null, 1, true, { toString: 'USD' }]) {
    assert.equal((await post(pricing, '/quotes', { ...body, currency })).status, 400)
    assert.equal((await post(baseline, '/reservations', reservation('bad-currency', ['A7'], { currency }))).status, 400)
  }
})
test('downstream connection failure returns 502 and leaves storefront alive', async () => {
  assert.equal((await post(deadUpstream, '/reservations', reservation('network', ['A8']))).status, 502)
  assert.equal((await fetch(deadUpstream + '/healthz')).status, 200)
})
test('malformed JSON returns 400 instead of crashing', async () => {
  for (const base of [baseline, safe, inventory, pricing]) {
    const r = await fetch(base + (base === pricing ? '/quotes' : '/reservations'), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad' })
    assert.equal(r.status, 400)
  }
})
test('storefront forwards routing and trace headers to both dependencies', async () => {
  const seen = []
  const server = http.createServer((req, res) => {
    seen.push(req.headers)
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(req.url === '/reservations' ? { reservationId: 'rsv-test', status: 'held', seats: ['A9'], expiresAt: new Date().toISOString() } : { total: 4725 }))
  })
  await new Promise(resolve => server.listen(18087, '127.0.0.1', resolve))
  try {
    await start('pkg/storefront/app.js', 'storefront', 18088, {
      INVENTORY_URL: 'http://127.0.0.1:18087', PRICING_URL: 'http://127.0.0.1:18087' })
    const headers = { baggage: 'sd-routing-key=example', traceparent: '00-12345678901234567890123456789012-1234567890123456-01', tracestate: 'test=value', 'x-request-id': 'request-1' }
    assert.equal((await post('http://127.0.0.1:18088', '/reservations', reservation('headers', ['A9']), headers)).status, 201)
    assert.equal(seen.length, 2)
    for (const actual of seen) for (const [name, value] of Object.entries(headers)) assert.equal(actual[name], value)
  } finally { await new Promise(resolve => server.close(resolve)) }
})

test('the shipped guard passes baseline and safe, and fails swallow-errors', async () => {
  const { promisify } = require('node:util')
  const execFile = promisify(require('node:child_process').execFile)
  const yaml = fs.readFileSync(path.join(root, 'signadot/reservation-guard-job.yaml'), 'utf8')
  const script = yaml.match(/  script: \|\n([\s\S]*?)  routingContext:/)[1].replace(/^    /gm, '')
  for (const base of [baseline, safe]) {
    const result = await execFile('sh', ['-c', script], { env: { ...process.env, BOXOFFICE_BASE_URL: base }, timeout: 15000 })
    assert.match(result.stdout, /PASS:/)
  }
  await assert.rejects(execFile('sh', ['-c', script], {
    env: { ...process.env, BOXOFFICE_BASE_URL: broken }, timeout: 15000,
  }), err => err.code === 1 && /already-held seats must return 409/.test(err.stderr))
})
