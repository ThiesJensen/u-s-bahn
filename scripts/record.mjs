import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import { promisify } from 'node:util'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const flags = ['dir', 'budget', 'api', 'network', 'minutes', 'key', 'gtfs', 'no-context']
const unknown = argv.filter(a => a.startsWith('--') && !flags.includes(a.slice(2).split('=')[0]))
if (unknown.length) {
  console.error(`unknown option ${unknown.join(' ')} (known: ${flags.map(f => `--${f}`).join(' ')})`)
  process.exit(1)
}
const opt = (name, env, fallback) => {
  const inline = argv.find(a => a.startsWith(`--${name}=`))
  if (inline) return inline.slice(name.length + 3)
  const i = argv.indexOf(`--${name}`)
  if (i < 0) return process.env[env] ?? fallback
  const value = argv[i + 1]
  return value === undefined || value.startsWith('--') ? 'true' : value
}
const config = {
  dir: path.resolve(opt('dir', 'REC_DIR', path.join(root, 'recordings'))),
  budget: Number(opt('budget', 'REC_BUDGET', 45)),
  api: opt('api', 'REC_API', 'https://v6.bvg.transport.rest').replace(/\/$/, ''),
  network: path.resolve(opt('network', 'REC_NETWORK', path.join(root, 'public/data/network.json'))),
  minutes: Number(opt('minutes', 'REC_MINUTES', 0)),
  key: String(opt('key', 'REC_KEY', '')).split(',').map(s => s.trim()).filter(s => /^\d+$/.test(s)),
  gtfs: ['true', '1'].includes(String(opt('gtfs', 'REC_GTFS', 'false'))),
  context: !argv.includes('--no-context') && process.env.REC_CONTEXT !== '0',
}
if (!(Number.isFinite(config.budget) && config.budget > 0 && Number.isFinite(config.minutes) && config.minutes >= 0)) {
  console.error(`invalid --budget ${opt('budget', 'REC_BUDGET', 45)} or --minutes ${opt('minutes', 'REC_MINUTES', 0)}: budget must be a number > 0, minutes a number >= 0`)
  process.exit(1)
}

const v1 = path.join(config.dir, 'v1')
const staticDir = path.join(v1, 'static')
const statePath = path.join(config.dir, 'state.json')
const lockPath = path.join(config.dir, 'lock')
fs.mkdirSync(staticDir, { recursive: true })

const lockPid = () => {
  try { return Number(fs.readFileSync(lockPath, 'utf8')) || 0 } catch { return 0 }
}
const holder = lockPid()
if (holder && holder !== process.pid) {
  let alive = false
  try {
    alive = Date.now() - fs.statSync(lockPath).mtimeMs < 3 * 60000
    process.kill(holder, 0)
  } catch (e) {
    alive &&= e.code === 'EPERM'
  }
  if (alive) {
    console.error(`${config.dir} is in use by recorder pid ${holder}; stop it first or choose another --dir`)
    process.exit(1)
  }
}
fs.writeFileSync(lockPath, String(process.pid))

const H = 3600000
const sha = (alg, data) => crypto.createHash(alg).update(data).digest('hex')
const at = (iso) => (iso ? Date.parse(iso) : null)
const berlin = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
const local = (ms) => {
  const p = Object.fromEntries(berlin.formatToParts(ms).map(x => [x.type, x.value]))
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), minute: Number(p.minute) }
}

const days = () => fs.readdirSync(v1).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort()
for (const day of days())
  for (const name of fs.readdirSync(path.join(v1, day))) {
    const file = path.join(v1, day, name)
    if (name.endsWith('.gz.tmp')) {
      if (fs.existsSync(file.slice(0, -7))) fs.unlinkSync(file)
      else fs.renameSync(file, file.slice(0, -4))
    }
    if (!name.endsWith('.ndjson')) continue
    const buf = fs.readFileSync(file)
    const end = buf.lastIndexOf(10) + 1
    if (end < buf.length) fs.truncateSync(file, end)
  }

const open = new Map()
const write = (stream, rec) => {
  const hour = new Date().toISOString().slice(0, 13)
  let file = open.get(stream)
  if (file?.hour !== hour) {
    if (file) fs.closeSync(file.fd)
    fs.mkdirSync(path.join(v1, hour.slice(0, 10)), { recursive: true })
    file = { hour, fd: fs.openSync(path.join(v1, hour.slice(0, 10), `${hour.slice(11)}Z.${stream}.ndjson`), 'a') }
    open.set(stream, file)
  }
  fs.writeSync(file.fd, JSON.stringify({ v: 1, stream, ...rec }) + '\n')
}
const log = (type, data = {}) => write('log', { ms: Date.now(), latMs: null, status: null, type, ...data })

const gzip = promisify(zlib.gzip)
const lineMs = (buf) => {
  try { return JSON.parse(buf).ms ?? null } catch { return null }
}
let compressing = false
const compress = async () => {
  if (compressing) return
  compressing = true
  try {
    const hour = new Date().toISOString().slice(0, 13)
    for (const [stream, file] of open) if (file.hour !== hour) { fs.closeSync(file.fd); open.delete(stream) }
    for (const day of days())
      for (const name of fs.readdirSync(path.join(v1, day)).filter(n => n.endsWith('.ndjson')).sort()) {
        if (`${day}T${name.slice(0, 2)}` === hour) continue
        const file = path.join(v1, day, name)
        try {
          const buf = fs.readFileSync(file)
          if (!buf.length) { fs.unlinkSync(file); continue }
          const old = fs.existsSync(`${file}.gz`) ? fs.readFileSync(`${file}.gz`) : null
          const out = old ? Buffer.concat([old, await gzip(buf)]) : await gzip(buf)
          const fd = fs.openSync(`${file}.gz.tmp`, 'w')
          fs.writeSync(fd, out)
          fs.fsyncSync(fd)
          fs.closeSync(fd)
          const all = old ? zlib.gunzipSync(out) : buf
          let rows = 0
          for (let i = all.indexOf(10); i >= 0; i = all.indexOf(10, i + 1)) rows++
          const entry = {
            path: `${day}/${name}.gz`, rows, bytes: out.length, sha256: sha('sha256', out),
            firstMs: lineMs(all.subarray(0, all.indexOf(10))), lastMs: lineMs(all.subarray(all.lastIndexOf(10, all.length - 2) + 1)),
          }
          fs.unlinkSync(file)
          fs.renameSync(`${file}.gz.tmp`, `${file}.gz`)
          fs.appendFileSync(path.join(v1, 'manifest.ndjson'), JSON.stringify(entry) + '\n')
        } catch (e) {
          log('error', { where: 'compress', msg: `${name}: ${e?.stack ?? e}` })
        }
      }
  } catch (e) {
    log('error', { where: 'compress', msg: String(e?.stack ?? e) })
  } finally {
    compressing = false
  }
}

const state = {
  v: 1, lastAliveMs: 0, radarMs: 0, runningMs: 0, trips: {}, boards: {}, rows: {}, plan: { slot: null, pending: [] }, ctx: {},
  ...(() => { try { return JSON.parse(fs.readFileSync(statePath)) } catch { return {} } })(),
}
const planning = new Set()
const saveState = () => {
  state.lastAliveMs = Date.now()
  const fd = fs.openSync(`${statePath}.tmp`, 'w')
  fs.writeSync(fd, JSON.stringify({ ...state, plan: { ...state.plan, pending: [...planning, ...state.plan.pending] } }))
  fs.fsyncSync(fd)
  fs.closeSync(fd)
  fs.renameSync(`${statePath}.tmp`, statePath)
}

const network = (() => {
  try {
    const n = JSON.parse(fs.readFileSync(config.network))
    if (n.lines?.length && n.stations?.length) return n
  } catch {}
  const copy = fs.readdirSync(staticDir)
    .filter(f => /^network-[0-9a-f]{12}\.json$/.test(f))
    .map(f => path.join(staticDir, f))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0]
  if (!copy) throw new Error(`network missing or invalid: ${config.network}`)
  return JSON.parse(fs.readFileSync(copy))
})()
const termini = new Set(network.lines.flatMap(l => [l.stations[0], l.stations.at(-1)]))
const targets = network.stations.flatMap(s => s.ids.map(id => ({
  id, key: termini.has(s.id) || s.lines.length >= 3 || config.key.includes(s.id) || config.key.includes(id),
})))

const seen = new Set()
const dict = (kind, id, data) => {
  if (seen.has(kind + id)) return
  seen.add(kind + id)
  write('dict', { ms: Date.now(), latMs: null, status: null, kind, id, data })
}
const stopId = (stop) => {
  if (!stop?.id) return null
  const products = Object.keys(stop.products ?? {}).filter(k => stop.products[k])
  dict('stop', stop.id, { name: stop.name ?? null, lat: stop.location?.latitude ?? null, lon: stop.location?.longitude ?? null, products })
  return stop.id
}
const hashes = (remarks) => (remarks ?? []).map(r => {
  const id = sha('sha1', `${r.type}|${r.code}|${r.summary}|${r.text}`).slice(0, 12)
  dict('remark', id, {
    type: r.type ?? null, code: r.code ?? null, summary: r.summary ?? null, text: r.text ?? null,
    validFrom: r.validFrom ?? null, validUntil: r.validUntil ?? null,
  })
  return id
})
const lineRef = (l) => ({ line: l?.name ?? null, lineId: l?.id ?? null, fahrtNr: l?.fahrtNr ?? null, product: l?.product ?? null, operator: l?.operator?.id ?? null })
const so = (s) => ({
  stop: stopId(s.stop),
  cancelled: s.cancelled === true,
  plannedArrival: s.plannedArrival ?? null,
  arrival: s.arrival ?? null,
  arrivalDelay: s.arrivalDelay ?? null,
  arrivalPlatform: s.arrivalPlatform ?? null,
  plannedArrivalPlatform: s.plannedArrivalPlatform ?? null,
  arrivalPrognosisType: s.arrivalPrognosisType ?? null,
  plannedDeparture: s.plannedDeparture ?? null,
  departure: s.departure ?? null,
  departureDelay: s.departureDelay ?? null,
  departurePlatform: s.departurePlatform ?? null,
  plannedDeparturePlatform: s.plannedDeparturePlatform ?? null,
  departurePrognosisType: s.departurePrognosisType ?? null,
  occupancy: s.occupancy ?? null,
  remarks: hashes(s.remarks),
})
const rail = (l) => ['suburban', 'subway'].includes(l?.product)
const keep = (l, direction) => rail(l) || (
  l?.product === 'bus'
  && (/s-bahn|u-bahn/.test(l.id ?? '') || /^[SU]\d/.test(l.name ?? ''))
  && /ev\d*$|sev|ersatz/i.test(`${l.id} ${l.name} ${direction}`)
)
const bad = (remarks) => (remarks ?? []).some(r => r.type !== 'hint' && /^text\.realtime\.journey\./.test(r.code ?? ''))
const disturbed = (stops) => stops.some(s => s.cancelled || Math.max(s.arrivalDelay ?? 0, s.departureDelay ?? 0, s.delay ?? 0) >= 180 || bad(s.remarks))
const lastDelay = (stops) => stops.map(s => s.arrivalDelay ?? s.departureDelay ?? null).filter(d => d != null && d >= -1800 && d <= 6 * 3600).at(-1) ?? null

const track = (id, ref, src, ms, info) => {
  if (!rail(ref)) return
  const t = state.trips[id] ??= { plannedStart: null, plannedEnd: null, eta: null, firstSeen: {} }
  t.firstSeen[src] ??= ms
  if (t.done) return
  if (info.plannedStart && (src === 'trip' || !t.plannedStart)) t.plannedStart = info.plannedStart
  if (info.plannedEnd && (src === 'trip' || !t.plannedEnd)) t.plannedEnd = info.plannedEnd
  if (info.delay != null && info.delay >= -1800 && info.delay <= 6 * 3600) t.delay = info.delay
  if (info.disturbed) t.disturbed = true
  if (info.eta && (src !== 'radar' || info.plannedEnd === t.plannedEnd) && !(Math.abs(info.eta - t.plannedEnd) > 6 * H)) t.eta = info.eta
  else if (t.plannedEnd) t.eta = t.plannedEnd + (t.delay ?? 0) * 1000
}

const stats = {}
const caps = { live: [], late: [], plan: [], mid: [] }
let budgetNow = config.budget, slowUntil = 0, pauseUntil = 0, netDownMs = 0, radarOkMs = 0, radarTrains = 0, runningTrains = 0
let tokens = 3, refillMs = Date.now(), lastTick = Date.now(), lastMono = performance.now(), lastMinute = Date.now()
const rewind = (now) => {
  state.radarMs = Math.min(state.radarMs, now)
  state.runningMs = Math.min(state.runningMs, now)
  for (const id in state.boards) if (state.boards[id] > now) state.boards[id] = now - Math.random() * 15 * 60000
  for (const t of Object.values(state.trips)) for (const k of ['liveMs', 'fetchMs', 'midTry', 'firstMs', 'retryAt']) if (t[k] > now) t[k] = now
  for (const k of ['weatherMs', 'alertsMs', 'calendarMs', 'gtfsMs', 'gtfsTryMs']) if (state.ctx[k] > now) state.ctx[k] = now
  for (const k in caps) caps[k] = []
  radarOkMs = Math.min(radarOkMs, now)
  netDownMs = Math.min(netDownMs, now)
  refillMs = Math.min(refillMs, now)
  if (lastMinute > now) lastMinute = now - 60000
}
const gap = (fromMs, toMs, reason) => {
  log('gap', { fromMs, toMs, reason })
  if (toMs - fromMs < 5 * 60000) return
  for (const t of Object.values(state.trips)) {
    const started = t.plannedStart ?? t.firstSeen.radar ?? t.firstSeen.running ?? Infinity
    if (!t.done && started <= toMs && toMs < (t.eta ?? 0)) t.midDue = true
  }
}
const request = async (stream, url, timeout = 15000) => {
  const ms = Date.now()
  let res = null, body = null, failure = null
  try {
    res = await fetch(url, { headers: { 'accept-encoding': 'gzip' }, signal: AbortSignal.timeout(timeout) })
    if (res.ok || res.status === 404) body = await res.json()
    else await res.body?.cancel()
  } catch (e) {
    failure = e
  }
  const latMs = Date.now() - ms
  const s = stats[stream] ??= { n: 0, ok: 0, s4xx: 0, s429: 0, s5xx: 0, timeout: 0, err: 0, lat: [] }
  s.n++
  s.lat.push(latMs)
  if (failure?.name === 'TimeoutError') s.timeout++
  else if (failure) s.err++
  else if (res.status === 429) s.s429++
  else if (res.status >= 500) s.s5xx++
  else if (res.ok) s.ok++
  else s.s4xx++
  if (failure) s.lastErr = `${failure.name}: ${failure.cause?.code ?? failure.message}`
  else if (!res.ok) s.lastErr = `HTTP ${res.status}`
  if (failure && !res && failure.name !== 'TimeoutError') netDownMs ||= ms
  if (res) {
    if (netDownMs && Date.now() - netDownMs >= 60000) gap(netDownMs, Date.now(), 'offline')
    netDownMs = 0
  }
  if (res?.status === 429 && url.startsWith(config.api)) {
    budgetNow = config.budget / 2
    slowUntil = Date.now() + 5 * 60000
    pauseUntil = Date.now() + (Number(res.headers.get('retry-after')) || 0) * 1000
  }
  const status = res?.status ?? (failure?.name === 'TimeoutError' ? 'timeout' : 'error')
  return { ms, latMs, status, body: failure ? null : body }
}

const radar = async () => {
  const r = await request('radar', `${config.api}/radar?north=52.76&south=52.29&west=13.06&east=13.91&results=3000&duration=30&frames=1&polylines=false`)
  if (!Array.isArray(r.body?.movements)) return
  if (radarOkMs && r.ms - radarOkMs > 90000) gap(radarOkMs, r.ms, 'noradar')
  radarOkMs = r.ms
  const trains = []
  for (const m of r.body.movements) {
    if (!keep(m.line, m.direction)) continue
    const stops = m.nextStopovers ?? []
    const train = { tripId: m.tripId, ...lineRef(m.line), direction: m.direction ?? null, lat: m.location?.latitude ?? null, lon: m.location?.longitude ?? null, next: stops.map(so) }
    trains.push(train)
    const last = stops.at(-1)
    track(m.tripId, train, 'radar', r.ms, { plannedEnd: at(last?.plannedArrival), eta: at(last?.arrival ?? last?.plannedArrival), delay: lastDelay(stops), disturbed: disturbed(stops) })
  }
  radarTrains = trains.filter(rail).length
  write('radar', { ms: r.ms, latMs: r.latMs, status: r.status, rt: r.body.realtimeDataUpdatedAt ?? null, total: r.body.movements.length, trains })
}

const railOnly = 'subway=true&suburban=true&tram=false&bus=false&ferry=false&express=false&regional=false'
const running = async () => {
  const r = await request('running', `${config.api}/trips?query=*&onlyCurrentlyRunning=true&${railOnly}`)
  if (!r.body) return
  const trains = []
  for (const t of r.body.trips ?? []) {
    const loc = t.currentLocation ?? t.origin?.location
    if (!keep(t.line) || !(loc?.latitude > 52.2 && loc.latitude < 52.9 && loc.longitude > 12.8 && loc.longitude < 14.1)) continue
    const train = {
      tripId: t.id, ...lineRef(t.line), direction: t.direction ?? null, origin: stopId(t.origin), destination: stopId(t.destination),
      plannedDeparture: t.plannedDeparture ?? null, plannedArrival: t.plannedArrival ?? null,
      lat: t.currentLocation?.latitude ?? null, lon: t.currentLocation?.longitude ?? null,
    }
    trains.push(train)
    track(t.id, train, 'running', r.ms, { plannedStart: at(t.plannedDeparture), plannedEnd: at(t.plannedArrival) })
  }
  runningTrains = trains.length
  write('running', { ms: r.ms, latMs: r.latMs, status: r.status, rt: r.body.realtimeDataUpdatedAt ?? null, trains })
}

const board = async (target, duration) => {
  const r = await request('board', `${config.api}/stops/${target.id}/departures?duration=${duration}&results=300&${railOnly}&remarks=true&language=de`)
  if (!r.body) return
  const departures = r.body.departures ?? []
  const rows = []
  for (const d of departures) {
    if (!keep(d.line, d.direction)) continue
    const row = {
      tripId: d.tripId, ...lineRef(d.line), direction: d.direction ?? null, destination: stopId(d.destination),
      plannedWhen: d.plannedWhen ?? null, when: d.when ?? null, delay: d.delay ?? null,
      plannedPlatform: d.plannedPlatform ?? null, platform: d.platform ?? null, prognosisType: d.prognosisType ?? null,
      cancelled: d.cancelled === true, occupancy: d.occupancy ?? null, remarks: hashes(d.remarks),
    }
    const stop = stopId(d.stop) ?? target.id
    if (stop !== target.id) row.stop = stop
    const signature = sha('sha1', JSON.stringify([row.when, row.delay, row.platform, row.cancelled, row.prognosisType, row.occupancy, row.remarks, row.direction])).slice(0, 12)
    if (state.rows[`${d.tripId}|${stop}`]?.[0] !== signature) {
      state.rows[`${d.tripId}|${stop}`] = [signature, at(row.plannedWhen) ?? r.ms]
      rows.push(row)
    }
    track(d.tripId, row, 'board', r.ms, { delay: row.delay, disturbed: disturbed([d]) })
  }
  write('board', { ms: r.ms, latMs: r.latMs, status: r.status, stop: target.id, duration, total: departures.length, rows })
}

const tripFetch = async (id, reason) => {
  const t = state.trips[id]
  const r = await request('trip', `${config.api}/trips/${encodeURIComponent(id)}?stopovers=true&remarks=true&language=de`)
  const trip = r.body?.trip
  if (r.body) write('trip', {
    ms: r.ms, latMs: r.latMs, status: r.status, reason, tripId: id,
    trip: trip ? {
      id: trip.id, ...lineRef(trip.line), direction: trip.direction ?? null, origin: stopId(trip.origin), destination: stopId(trip.destination),
      plannedDeparture: trip.plannedDeparture ?? null, departure: trip.departure ?? null, departureDelay: trip.departureDelay ?? null,
      plannedArrival: trip.plannedArrival ?? null, arrival: trip.arrival ?? null, arrivalDelay: trip.arrivalDelay ?? null,
      cancelled: trip.cancelled === true, occupancy: trip.occupancy ?? null, remarks: hashes(trip.remarks), stopovers: (trip.stopovers ?? []).map(so),
    } : null,
  })
  if (!t) return
  if (r.status === 'error') {
    t.retryAt = Date.now() + 8000
    return
  }
  if (reason === 'first') t.nFirst = (t.nFirst ?? 0) + 1
  if (!trip) {
    if (r.status >= 400 && r.status < 500 && r.status !== 429) {
      t.done = true
      log('lost', { tripId: id, reason: `HTTP ${r.status}`, fetch: reason })
    } else if (reason === 'end') {
      t.tries = (t.tries ?? 0) + 1
      if (t.tries < 3) t.retryAt = Date.now() + (t.tries === 1 ? 2000 : 8000)
      else if (Date.now() < t.eta + 180000) { t.tries = 0; t.late = true }
      else { t.done = true; log('lost', { tripId: id, reason: `end ${r.status}`, fetch: reason }) }
    } else if (reason === 'late' || (reason === 'first' && t.nFirst >= 2)) {
      t.done = true
      log('lost', { tripId: id, reason: `${reason} ${r.status}`, fetch: reason })
    }
    return
  }
  t.tries = 0
  t.fetchMs = r.ms
  t.midDue = false
  t.late = false
  const stops = trip.stopovers ?? []
  const first = stops.find(s => !s.cancelled || s.departure)
  const last = stops.filter(s => !s.cancelled || s.arrival).at(-1)
  track(id, lineRef(trip.line), 'trip', r.ms, {
    plannedStart: at(first?.plannedDeparture ?? trip.plannedDeparture),
    plannedEnd: at(last?.plannedArrival ?? trip.plannedArrival),
    eta: last ? at(last.arrival ?? last.plannedArrival) : at(trip.plannedArrival),
    delay: lastDelay(stops),
    disturbed: disturbed(stops) || bad(trip.remarks),
  })
  if (reason === 'end') t.nEnd = (t.nEnd ?? 0) + 1
  if (!last || t.nEnd >= 3 || t.eta - Date.now() <= 150000) t.done = true
}

const plan = async (item) => {
  const fromWhen = new Date(item.from).toISOString(), untilWhen = new Date(item.until).toISOString()
  const r = await request('plan', `${config.api}/trips?` + [
    `query=${encodeURIComponent(item.line)}`,
    `fromWhen=${encodeURIComponent(fromWhen)}`,
    `untilWhen=${encodeURIComponent(untilWhen)}`,
    'onlyCurrentlyRunning=false',
    `suburban=${item.product === 'suburban'}`,
    `subway=${item.product === 'subway'}`,
    'tram=false&bus=false&ferry=false&express=false&regional=false',
  ].join('&'))
  if (!r.body) {
    const free = r.status === 'error' || r.status === 429
    if (free || item.tries < 2) state.plan.pending.push({ ...item, tries: item.tries + (free ? 0 : 1) })
    else log('error', { where: 'plan', msg: `dropped ${item.line} ${fromWhen} to ${untilWhen} after 3 attempts, last ${r.status}` })
    return
  }
  const trips = (r.body.trips ?? []).filter(t => t.line?.name === item.line && t.line.id?.startsWith('de-vbb-') && at(t.plannedArrival) >= item.from && at(t.plannedDeparture) < item.until)
  write('plan', {
    ms: r.ms, latMs: r.latMs, status: r.status, line: item.line, fromWhen, untilWhen,
    trips: trips.map(t => ({
      tripId: t.id, lineId: t.line.id, fahrtNr: t.line.fahrtNr ?? null, direction: t.direction ?? null, origin: stopId(t.origin), destination: stopId(t.destination),
      plannedDeparture: t.plannedDeparture ?? null, plannedArrival: t.plannedArrival ?? null, cancelled: t.cancelled === true,
    })),
  })
  for (const t of trips) if (at(t.plannedArrival) > Date.now() - 6 * H) track(t.id, lineRef(t.line), 'plan', r.ms, { plannedStart: at(t.plannedDeparture), plannedEnd: at(t.plannedArrival) })
}

const points = [['Mitte', 52.52, 13.405], ['Spandau', 52.535, 13.2], ['Lichterfelde', 52.43, 13.32], ['Erkner', 52.43, 13.75], ['Oranienburg', 52.75, 13.24]]
const staticRecord = (gtfs) => {
  const files = {}
  for (const name of ['network', 'tracks3d', 'zones']) {
    try {
      const buf = fs.readFileSync(name === 'network' ? config.network : path.join(path.dirname(config.network), `${name}.json`))
      const sha256 = sha('sha256', buf)
      files[name] = { sha256, bytes: buf.length }
      if (name !== 'network') continue
      const copy = path.join(staticDir, `network-${sha256.slice(0, 12)}.json`)
      if (!fs.existsSync(copy) && JSON.parse(buf).lines?.length) fs.writeFileSync(copy, buf)
      files.network.copy = fs.existsSync(copy) ? path.relative(v1, copy) : null
    } catch {}
  }
  write('static', { ms: Date.now(), latMs: null, status: null, files, ...(gtfs ? { gtfs } : {}) })
}
let contextBusy = false
const context = async (now) => {
  contextBusy = true
  try {
    if (now - (state.ctx.weatherMs ?? 0) >= 15 * 60000) {
      state.ctx.weatherMs = now
      const url = 'https://api.open-meteo.com/v1/forecast?' + [
        `latitude=${points.map(p => p[1]).join(',')}`,
        `longitude=${points.map(p => p[2]).join(',')}`,
        'current=temperature_2m,precipitation,rain,snowfall,snow_depth,wind_speed_10m,wind_gusts_10m,weather_code,visibility,relative_humidity_2m',
        'minutely_15=precipitation,snowfall,wind_gusts_10m',
        'forecast_minutely_15=8',
        'timezone=UTC',
      ].join('&')
      const r = await request('context', url)
      const list = Array.isArray(r.body) ? r.body : r.body ? [r.body] : []
      if (list.length) write('context', {
        ms: r.ms, latMs: r.latMs, status: r.status, kind: 'weather',
        points: list.map((p, i) => ({
          name: points[i]?.[0] ?? null, lat: points[i]?.[1] ?? p.latitude, lon: points[i]?.[2] ?? p.longitude,
          current: p.current ?? null, minutely15: p.minutely_15 ?? null,
        })),
      })
    }
    if (now - (state.ctx.alertsMs ?? 0) >= 15 * 60000) {
      state.ctx.alertsMs = now
      const r = await request('context', 'https://api.brightsky.dev/alerts?lat=52.52&lon=13.405')
      if (r.body) write('context', { ms: r.ms, latMs: r.latMs, status: r.status, kind: 'alerts', alerts: r.body.alerts ?? [] })
    }
    if (state.ctx.calendarDay !== local(now).date && now - (state.ctx.calendarMs ?? 0) >= 30 * 60000) {
      state.ctx.calendarMs = now
      const year = local(now).date.slice(0, 4)
      const query = `countryIsoCode=DE&subdivisionCode=DE-BE&languageIsoCode=DE&validFrom=${year}-01-01&validTo=${year}-12-31`
      const pub = await request('context', `https://openholidaysapi.org/PublicHolidays?${query}`)
      const school = await request('context', `https://openholidaysapi.org/SchoolHolidays?${query}`)
      if (Array.isArray(pub.body) && Array.isArray(school.body)) {
        state.ctx.calendarDay = local(now).date
        write('context', { ms: pub.ms, latMs: pub.latMs + school.latMs, status: pub.status, kind: 'calendar', year: Number(year), public: pub.body, school: school.body })
      }
    }
  } catch (e) {
    log('error', { where: 'context', msg: String(e?.stack ?? e) })
  }
  contextBusy = false
}
let gtfsBusy = false
const fetchGtfs = async (now) => {
  gtfsBusy = true
  state.ctx.gtfsTryMs = now
  const file = path.join(staticDir, `gtfs-${local(now).date}.zip`)
  try {
    const res = await fetch('https://www.vbb.de/gtfs', { signal: AbortSignal.timeout(15 * 60000) })
    if (!res.ok) {
      await res.body?.cancel()
      throw new Error(`HTTP ${res.status}`)
    }
    const etag = res.headers.get('etag') ?? res.headers.get('last-modified') ?? res.headers.get('content-length')
    if (etag !== state.ctx.gtfsEtag) {
      await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(`${file}.tmp`))
      fs.renameSync(`${file}.tmp`, file)
      state.ctx.gtfsEtag = etag
      staticRecord({ etag, bytes: fs.statSync(file).size, path: path.relative(v1, file) })
    } else await res.body?.cancel()
    state.ctx.gtfsMs = now
  } catch (e) {
    fs.rmSync(`${file}.tmp`, { force: true })
    log('error', { where: 'gtfs', msg: String(e?.stack ?? e) })
  }
  gtfsBusy = false
}

const flying = new Set()
let hourOpen = new Date().toISOString().slice(0, 13), queue = 0, pendingEnd = 0, serviceDay = local(Date.now() - 3 * H).date
const startMs = Date.now()
const launch = (key, job) => {
  tokens--
  flying.add(key)
  job().catch(e => log('error', { where: key, msg: String(e?.stack ?? e) })).finally(() => flying.delete(key))
}
const capOk = (kind, perMinute, now) => (caps[kind] = caps[kind].filter(x => now - x < 60000)).length < perMinute

const tick = () => {
  const now = Date.now(), mono = performance.now()
  if (now - lastTick > 30000) gap(lastTick, now, mono - lastMono > now - lastTick - 30000 ? 'sleep' : 'clock')
  if (now - lastTick < -30000) {
    gap(lastTick, now, 'clock')
    rewind(now)
  }
  lastTick = now
  lastMono = mono
  if (new Date(now).toISOString().slice(0, 13) !== hourOpen) {
    hourOpen = new Date(now).toISOString().slice(0, 13)
    compress()
  }
  if (now > slowUntil) budgetNow = config.budget
  tokens = Math.min(3, tokens + Math.max(0, now - refillMs) / 1000 * budgetNow / 60)
  refillMs = now

  const clock = local(now)
  const shifted = local(now - 150 * 60000)
  const slot = `${shifted.date} ${shifted.hour * 60 + shifted.minute >= 690 ? '14:00' : '02:30'}`
  if (state.plan.slot !== slot) {
    const windows = []
    for (let from = Math.floor(now / H) * H; from < Math.floor(now / H) * H + 24 * H;) {
      const midnight = from + ((24 - local(from).hour) * 60 - local(from).minute) * 60000
      const until = Math.min(from + 4 * H, midnight)
      windows.push([from, until === midnight ? until - 60000 : until])
      from = until
    }
    state.plan = { slot, startedMs: now, pending: network.lines.flatMap(l => windows.map(([from, until]) => ({ line: l.id, product: l.product, from, until, tries: 0 }))) }
  }
  if (config.context && !contextBusy) context(now)
  if (config.gtfs && !gtfsBusy && now - (state.ctx.gtfsMs ?? 0) >= 7 * 24 * H && now - (state.ctx.gtfsTryMs ?? 0) >= H) fetchGtfs(now)
  if (state.ctx.staticDay !== clock.date) {
    state.ctx.staticDay = clock.date
    staticRecord()
  }
  if (serviceDay !== local(now - 3 * H).date) {
    serviceDay = local(now - 3 * H).date
    seen.clear()
  }

  const due = { end: [], live: [], first: [], mid: [], late: [] }
  for (const [id, t] of Object.entries(state.trips)) {
    if (t.done || flying.has(id)) continue
    if (t.eta && now > t.eta + 180000 && !t.late) {
      if (t.nEnd) { t.done = true; continue }
      t.late = true
    }
    if (t.late) {
      if (now - t.eta > 6 * H) { t.done = true; log('lost', { tripId: id, reason: 'late expired' }) }
      else due.late.push([-t.eta, id])
      continue
    }
    const fresh = Math.max(t.liveMs ?? 0, t.fetchMs ?? 0)
    const long = t.plannedStart && t.plannedEnd - t.plannedStart >= H
    if (t.eta && now >= t.eta - 90000) {
      if (now >= (t.retryAt ?? 0)) due.end.push([t.eta, id])
    } else if (t.disturbed && (t.nLive ?? 0) < 12 && now - fresh >= 300000 && (t.plannedStart ?? 0) - 600000 <= now) {
      due.live.push([fresh, id])
    } else if (!t.eta && (t.nFirst ?? 0) < 2 && now - (t.firstMs ?? 0) >= 120000 && !state.plan.pending.length) {
      due.first.push([t.firstSeen.board ?? now, id])
    } else if (now - (t.midTry ?? 0) >= 120000 && (t.midDue || (long && now - Math.max(t.plannedStart, t.fetchMs ?? 0) >= 50 * 60000 && t.eta - now >= 10 * 60000))) {
      due.mid.push([t.plannedStart ?? 0, id])
    }
  }
  for (const list of Object.values(due)) list.sort((a, b) => a[0] - b[0])
  const night = clock.hour >= 1 && clock.hour < 4
  pendingEnd = due.end.length
  queue = Object.values(due).reduce((n, l) => n + l.length, 0) + state.plan.pending.length

  while (tokens >= 1 && flying.size < 3 && now >= pauseUntil) {
    if (!flying.has('radar') && now - state.radarMs >= 30000) {
      state.radarMs = now
      launch('radar', radar)
      continue
    }
    const end = !netDownMs && due.end.shift()
    if (end) {
      launch(end[1], () => tripFetch(end[1], 'end'))
      continue
    }
    if (!flying.has('running') && now - state.runningMs >= 60000) {
      state.runningMs = now
      launch('running', running)
      continue
    }
    if (!netDownMs && capOk('live', 4, now)) {
      const live = due.live.shift()
      if (live) {
        const t = state.trips[live[1]]
        t.liveMs = now
        t.nLive = (t.nLive ?? 0) + 1
        caps.live.push(now)
        launch(live[1], () => tripFetch(live[1], 'live'))
        continue
      }
      const first = due.first.shift()
      if (first) {
        state.trips[first[1]].firstMs = now
        caps.live.push(now)
        launch(first[1], () => tripFetch(first[1], 'first'))
        continue
      }
    }
    const mid = !netDownMs && capOk('mid', 8, now) && due.mid.shift()
    if (mid) {
      state.trips[mid[1]].midTry = now
      caps.mid.push(now)
      launch(mid[1], () => tripFetch(mid[1], 'mid'))
      continue
    }
    const item = !netDownMs && capOk('plan', 5, now) && state.plan.pending.shift()
    if (item) {
      caps.plan.push(now)
      planning.add(item)
      launch(`plan ${item.line} ${item.from}`, () => plan(item).finally(() => planning.delete(item)))
      continue
    }
    const late = !netDownMs && capOk('late', 2, now) && due.late.shift()
    if (late) {
      caps.late.push(now)
      launch(late[1], () => tripFetch(late[1], 'late'))
      continue
    }
    let next = null, ratio = 1
    for (const b of targets) {
      if (flying.has(b.id)) continue
      const r = (now - (state.boards[b.id] ?? 0)) / ((b.key ? (night ? 8 : 4) : (night ? 30 : 15)) * 60000)
      if (r >= ratio) { next = b; ratio = r }
    }
    if (!next) break
    state.boards[next.id] = now
    launch(next.id, () => board(next, next.key ? 30 : 45))
  }

  if (now - lastMinute >= 60000) {
    const spanS = Math.round((now - lastMinute) / 1000)
    lastMinute = now
    const streams = Object.fromEntries(Object.entries(stats).map(([k, s]) => {
      const lat = s.lat.sort((a, b) => a - b)
      return [k, {
        n: s.n, ok: s.ok, s4xx: s.s4xx, s429: s.s429, s5xx: s.s5xx, timeout: s.timeout, err: s.err,
        p50: lat[Math.floor(lat.length * 0.5)] ?? null, p95: lat[Math.min(lat.length - 1, Math.floor(lat.length * 0.95))] ?? null,
        ...(s.lastErr ? { lastErr: s.lastErr } : {}),
      }]
    }))
    for (const k of Object.keys(stats)) delete stats[k]
    const tracked = Object.values(state.trips).filter(t => !t.done).length
    log('health', { spanS, streams, budgetNow, tokens: Math.round(tokens * 100) / 100, queue, radarTrains, runningTrains, tracked, pendingEnd })
    const perMinute = (n) => Math.round(n * 60 / Math.max(60, spanS))
    const bvg = Object.entries(streams).filter(([k]) => k !== 'context').reduce((n, [, s]) => n + s.n, 0)
    const errors = Object.values(streams).reduce((n, s) => n + s.s429 + s.s5xx + s.timeout + s.err, 0)
    const time = `${clock.date} ${String(clock.hour).padStart(2, '0')}:${String(clock.minute).padStart(2, '0')}`
    const parts = Object.entries(streams).map(([k, s]) => `${k} ${perMinute(s.n)}`).join(', ')
    console.log(`${time}  ${perMinute(bvg)} req/min (${parts})  radar ${radarTrains}  running ${runningTrains}  tracked ${tracked}  end due ${pendingEnd}  queue ${queue}  budget ${budgetNow}  errors ${errors}`)
    for (const [id, t] of Object.entries(state.trips)) {
      if ((t.plannedEnd ?? t.eta ?? Math.min(...Object.values(t.firstSeen))) > now - 6 * H) continue
      if (!t.done) log('lost', { tripId: id, reason: 'expired' })
      delete state.trips[id]
    }
    for (const [k, [, planned]] of Object.entries(state.rows)) if (planned < now - 3 * H) delete state.rows[k]
    const owner = lockPid()
    if (owner && owner !== process.pid) {
      log('error', { where: 'lock', msg: `recordings taken over by pid ${owner}` })
      stop('lock')
    }
    fs.writeFileSync(lockPath, String(process.pid))
    saveState()
  }
  if (config.minutes && now - startMs >= config.minutes * 60000) stop('minutes')
}

const stop = (signal) => {
  clearInterval(timer)
  if (signal !== 'lock') saveState()
  log('stop', { signal })
  for (const file of open.values()) fs.closeSync(file.fd)
  open.clear()
  if (lockPid() === process.pid) fs.rmSync(lockPath, { force: true })
  process.exit(signal === 'lock' ? 1 : 0)
}

rewind(Date.now())
log('start', { config, node: process.version, pid: process.pid, targets: targets.length, keyTargets: targets.filter(t => t.key).length })
if (state.lastAliveMs && Date.now() - state.lastAliveMs > 60000) gap(state.lastAliveMs, Date.now(), 'restart')
console.log(`recording to ${config.dir}  budget ${config.budget}/min  ${targets.length} boards (${targets.filter(t => t.key).length} key)  ${network.lines.length} lines`)
compress()
const timer = setInterval(tick, 1000)
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => stop(signal))
process.on('uncaughtException', e => log('error', { where: 'uncaught', msg: String(e?.stack ?? e) }))
process.on('unhandledRejection', e => log('error', { where: 'unhandled', msg: String(e?.stack ?? e) }))
