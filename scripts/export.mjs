import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import readline from 'node:readline'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const inline = argv.find(a => a.startsWith(`--${name}=`))
  if (inline) return inline.slice(name.length + 3)
  const i = argv.indexOf(`--${name}`)
  if (i < 0) return fallback
  return argv[i + 1] === undefined || argv[i + 1].startsWith('--') ? true : argv[i + 1]
}
const from = arg('from'), to = arg('to', from)
if (!/^\d{4}-\d{2}-\d{2}$/.test(String(from)) || !/^\d{4}-\d{2}-\d{2}$/.test(String(to))) {
  console.error('usage: node scripts/export.mjs --from YYYY-MM-DD [--to YYYY-MM-DD] [--dir recordings] [--out exports] [--gzip] [--positions] [--events events.json] [--network public/data/network.json]')
  process.exit(1)
}
const dir = path.resolve(arg('dir', process.env.REC_DIR ?? path.join(root, 'recordings')))
const outDir = path.resolve(arg('out', path.join(root, 'exports')))
const gzipOut = arg('gzip', false) === true
const withPositions = arg('positions', false) === true
const events = arg('events') ? JSON.parse(fs.readFileSync(path.resolve(arg('events')))) : []
const fallbackNetwork = path.resolve(arg('network', path.join(root, 'public/data/network.json')))
const tracks3d = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(path.dirname(fallbackNetwork), 'tracks3d.json'))).segments ?? [] } catch { return [] }
})()

const H = 3600000, M = 60000
const at = (iso) => (iso ? Date.parse(iso) : null)
const sec = (ms) => (ms == null || !Number.isFinite(ms) ? null : Math.round(ms / 1000))
const berlin = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
const offset = (ms) => {
  const p = Object.fromEntries(berlin.formatToParts(ms).map(x => [x.type, x.value]))
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - Math.floor(ms / M) * M
}
const midnight = (day) => {
  const guess = Date.parse(`${day}T00:00:00Z`)
  return guess - offset(guess - offset(guess))
}
const nextDay = (day) => new Date(Date.parse(`${day}T12:00:00Z`) + 24 * H).toISOString().slice(0, 10)
const dist = ([lon1, lat1], [lon2, lat2]) => {
  const r = Math.PI / 180
  return 6371000 * Math.hypot((lon2 - lon1) * r * Math.cos((lat1 + lat2) / 2 * r), (lat2 - lat1) * r)
}
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null)
const cv = (a) => {
  const m = mean(a)
  return a.length < 2 || !m ? null : Math.round(Math.sqrt(mean(a.map(x => (x - m) ** 2))) / m * 1000) / 1000
}
const platformKey = (p) => String(p).trim().split(/[\s(]/)[0]
const plausible = (delay) => delay != null && delay >= -1800 && delay <= 6 * 3600
const push = (map, key, value) => {
  const list = map.get(key)
  if (list) list.push(value)
  else map.set(key, [value])
}
const weights = { low: 1, medium: 2, high: 3 }
const weatherFields = ['temperature_2m', 'precipitation', 'rain', 'snowfall', 'snow_depth', 'wind_speed_10m', 'wind_gusts_10m', 'weather_code', 'visibility', 'relative_humidity_2m']
const forecastFields = ['precipitation', 'snowfall', 'wind_gusts_10m']
const categories = [
  ['accessibility', /aufzug|fahrstuhl|fahrtreppe|rolltreppe|rollstuhl|mobilitätseingeschränkt|barrierefrei/i],
  ['passenger_info', /fahrgastinformation/i],
  ['persons_on_track', /personen? (im|am|auf dem) gleis|personen im gleisbereich|unbefugte|persons? on (the )?track/i],
  ['police', /polizei|police/i],
  ['medical', /notarzt|rettungsdienst|rettungseinsatz|medizinisch|ärztlich|erkrankt|medical|ambulance/i],
  ['fire', /feuer|\bbrand\b|brandeinsatz|\bfire\b/i],
  ['interlocking', /stellwerk|interlocking/i],
  ['signal', /signal/i],
  ['points', /weiche|\bpoints\b/i],
  ['vehicle_defect', /fahrzeugstörung|zugstörung|defekt|reparatur|technische störung am zug|vehicle|repair/i],
  ['construction', /bauarbeit|baumaßnahme|baustelle|gleisbau|gleisarbeit|construction|engineering works/i],
  ['weather', /unwetter|sturm|schnee|glätte|vereis|hitze|gewitter|umgestürzt|\bbaum|storm|snow|weather|heat/i],
  ['strike', /streik|strike/i],
  ['previous_delay', /vorherigen fahrt|vorausfahrend|verzögerungen im betriebsablauf|previous/i],
]
const notDisruption = new Set(['hint', 'accessibility', 'passenger_info'])
const singleTrack = [
  { line: 'S5', from: '900320004', to: '900320001', name: 'Strausberg – Strausberg Nord', verified: false },
  { line: 'S47', from: '900192001', to: '900180003', name: 'Schöneweide – Spindlersfeld', verified: false },
  { line: 'S2', from: '900245028', to: '900245027', name: 'Mahlow – Blankenfelde', verified: false },
  { line: 'S25', from: '900091203', to: '900200000', name: 'Heiligensee – Hennigsdorf', verified: false },
]

fs.mkdirSync(outDir, { recursive: true })
for (let day = from; day <= to; day = nextDay(day)) {
  const started = Date.now()
  const startMs = midnight(day) + 3 * H
  const endMs = midnight(nextDay(day)) + 3 * H
  const minutes = (endMs - startMs) / M
  const suffixes = [`|${day.slice(8, 10)}${day.slice(5, 7)}${day.slice(0, 4)}`, `|${Number(day.slice(8, 10))}${day.slice(5, 7)}${day.slice(0, 4)}`]
  const ofDay = (tripId) => suffixes.some(x => tripId.endsWith(x))
  const inDay = (ms) => ms >= startMs && ms < endMs
  const minuteOf = (ms) => Math.floor((ms - startMs) / M)
  const read = async (stream, fn) => {
    for (let h = Math.floor(startMs / H) * H - H; h < endMs + 3 * H; h += H) {
      const iso = new Date(h).toISOString()
      const base = path.join(dir, 'v1', iso.slice(0, 10), `${iso.slice(11, 13)}Z.${stream}.ndjson`)
      for (const file of [`${base}.gz`, base]) {
        if (!fs.existsSync(file)) continue
        const input = fs.createReadStream(file)
        for await (const line of readline.createInterface({ input: file.endsWith('.gz') ? input.pipe(zlib.createGunzip()) : input, crlfDelay: Infinity })) {
          if (!line) continue
          let rec
          try { rec = JSON.parse(line) } catch { continue }
          fn(rec)
        }
      }
    }
  }

  let networkSha = null
  await read('static', r => { if (r.files?.network?.sha256) networkSha = r.files.network.sha256 })
  const copy = networkSha && path.join(dir, 'v1', 'static', `network-${networkSha.slice(0, 12)}.json`)
  const network = JSON.parse(fs.readFileSync(copy && fs.existsSync(copy) ? copy : fallbackNetwork))
  const stationOfStop = new Map(network.stations.flatMap(s => s.ids.map(id => [id, s.id])))
  const stationById = new Map(network.stations.map(s => [s.id, s]))
  const lineById = new Map(network.lines.map(l => [l.id, l]))
  const lineIndex = new Map(network.lines.map(l => [l.id, new Map(l.stations.map((s, i) => [s, i]))]))
  const ring = new Set(network.lines
    .filter(l => network.segments.some(s => s.lines.includes(l.id) && [s.from, s.to].includes(l.stations[0]) && [s.from, s.to].includes(l.stations.at(-1))))
    .map(l => l.id))
  const termini = Object.fromEntries(network.lines.map(l => [l.id, [l.stations[0], l.stations.at(-1)]]))
  const allTermini = new Set(Object.values(termini).flat())
  const segments = network.segments.map(s => ({ from: s.from, to: s.to, lines: s.lines, lengthM: Math.round(s.coords.slice(1).reduce((n, c, i) => n + dist(s.coords[i], c), 0)) }))
  const geom = new Map()
  for (const s of [...network.segments, ...tracks3d]) for (const [a, b, coords] of [[s.from, s.to, s.coords], [s.to, s.from, [...s.coords].reverse()]]) {
    const cum = [0]
    for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + dist(coords[i - 1], coords[i]))
    geom.set(`${a}|${b}`, { coords, cum })
  }
  const corridors = [], corridorOf = new Map()
  const groups = new Map()
  for (const s of network.segments) if (s.lines.length >= 2) push(groups, [...s.lines].sort().join('+'), s)
  for (const [key, segs] of groups) {
    const adj = new Map()
    for (const s of segs) for (const [a, b] of [[s.from, s.to], [s.to, s.from]]) adj.set(a, [...new Set([...(adj.get(a) ?? []), b])])
    const used = new Set()
    for (const start of [...adj.keys()].sort((a, b) => (adj.get(a).length === 2) - (adj.get(b).length === 2)))
      for (const first of adj.get(start)) {
        if (used.has(`${start}|${first}`)) continue
        const chain = [start]
        let prev = start, cur = first
        while (cur && !used.has(`${prev}|${cur}`)) {
          used.add(`${prev}|${cur}`)
          used.add(`${cur}|${prev}`)
          chain.push(cur)
          const next = adj.get(cur).length === 2 ? adj.get(cur).find(x => x !== prev) : null
          prev = cur
          cur = next
        }
        const id = `${key}#${corridors.filter(c => c.lines.join('+') === key).length + 1}`
        corridors.push({ id, lines: key.split('+'), stations: chain })
        for (let i = 1; i < chain.length; i++) { corridorOf.set(`${chain[i - 1]}|${chain[i]}`, id); corridorOf.set(`${chain[i]}|${chain[i - 1]}`, id) }
      }
  }

  const stopInfo = new Map(), remarkInfo = new Map()
  await read('dict', r => (r.kind === 'stop' ? stopInfo : remarkInfo).set(r.id, r.data))
  const coords = (station, stop) => {
    const s = stationById.get(station), d = stopInfo.get(stop)
    return s ? [s.lon, s.lat] : d?.lat != null ? [d.lon, d.lat] : null
  }
  const code = (hash) => remarkInfo.get(hash)?.code ?? ''
  const remarkCode = (T, pattern) => [...T.t.remarkFirst].filter(([h]) => pattern.test(code(h)))

  const gaps = [], lost = new Map()
  await read('log', r => {
    if (r.type === 'gap' && Math.max(r.fromMs, r.toMs) > startMs && Math.min(r.fromMs, r.toMs) < endMs) gaps.push({ fromS: sec(r.fromMs), toS: sec(r.toMs), reason: r.reason })
    if (r.type === 'lost') lost.set(r.tripId, r.reason)
  })

  const weather = [], forecast15 = [], alerts = new Map()
  let calendar = null
  await read('context', r => {
    if (r.kind === 'calendar') calendar = r
    if (!inDay(r.ms)) return
    if (r.kind === 'weather') for (const p of r.points) {
      weather.push([sec(r.ms), p.name, ...weatherFields.map(f => p.current?.[f] ?? null)])
      for (const [i, time] of (p.minutely15?.time ?? []).entries()) forecast15.push([sec(r.ms), p.name, sec(at(`${time}Z`)), ...forecastFields.map(f => p.minutely15[f]?.[i] ?? null)])
    }
    if (r.kind === 'alerts') for (const a of r.alerts) alerts.set(a.id ?? JSON.stringify(a), a)
  })

  const cover = { radar: new Array(minutes).fill(0), running: new Array(minutes).fill(0), board: new Array(minutes).fill(0), trip: new Array(minutes).fill(0) }
  const live = new Set()
  const covered = (ms) => ms != null && live.has(Math.floor(ms / M))
  const trips = new Map(), usage = new Map(), forecasts = []
  const trip = (id) => trips.get(id) ?? trips.set(id, { id, seen: {}, ev: new Map(), fetches: 0, remarkFirst: new Map(), pos: [], seenAt: [], obs: [] }).get(id)
  const event = (t, stop, plannedMs) => {
    const station = stationOfStop.get(stop) ?? null
    const key = `${station ?? stop}|${plannedMs}`
    return t.ev.get(key) ?? t.ev.set(key, { stop, station, pa: null, pd: null, actual: {}, pred: {}, last: {}, cancel: {}, depObs: [], remarks: new Set() }).get(key)
  }
  const use = (hash, ms, t, station) => {
    const u = usage.get(hash) ?? usage.set(hash, { first: ms, last: ms, lines: new Set(), stations: new Set(), trips: new Set() }).get(hash)
    u.first = Math.min(u.first, ms)
    u.last = Math.max(u.last, ms)
    if (t.ref?.line) u.lines.add(t.ref.line)
    if (station) u.stations.add(station)
    u.trips.add(t.id)
    if (!(t.remarkFirst.get(hash) <= ms)) t.remarkFirst.set(hash, ms)
  }
  const predict = (t, e, kind, src, obsMs, timeMs, delay) => {
    if (!plausible(delay) || timeMs == null || e.last[`${kind}|${src}`] === delay) return
    e.last[`${kind}|${src}`] = delay
    if (!e.pred[kind] || e.pred[kind][2] <= obsMs) e.pred[kind] = [timeMs, delay, obsMs, src]
    if (kind === 'dep') e.depObs.push([obsMs, delay])
    forecasts.push([obsMs, src, t, e, kind, delay])
    t.obs.push([obsMs, delay])
  }
  const observe = (e, ms, src, rt, arrCancelled, depCancelled, platform) => {
    if (!rt) {
      e.staticPlatform = platform ?? e.staticPlatform ?? null
      return
    }
    if (arrCancelled || depCancelled) e.cancelSeen = Math.min(e.cancelSeen ?? Infinity, ms)
    for (const [kind, value] of [['arr', arrCancelled], ['dep', depCancelled]]) if (value != null && !(e.cancel[kind]?.[0] > ms)) e.cancel[kind] = [ms, value]
    if (platform && e.plannedPlatform && platformKey(platform) !== platformKey(e.plannedPlatform) && !(e.platformSeen?.[0] <= ms)) e.platformSeen = [ms, src, platform]
    if (ms < (e.rtMs ?? -Infinity)) return
    e.rtMs = ms
    if (platform != null) e.platform = platform
  }
  const refOf = (x) => ({ line: x.line ?? null, lineId: x.lineId ?? null, fahrtNr: x.fahrtNr ?? null, product: x.product ?? null, operator: x.operator ?? null })
  const stopover = (t, s, ms, src) => {
    const pa = at(s.plannedArrival), pd = at(s.plannedDeparture)
    const e = event(t, s.stop, pd ?? pa)
    e.pa ??= pa
    e.pd ??= pd
    e.plannedPlatform = s.plannedDeparturePlatform ?? s.plannedArrivalPlatform ?? e.plannedPlatform ?? null
    const rt = s.cancelled || s.arrivalDelay != null || s.departureDelay != null
    const arr = s.cancelled && s.arrival == null && pa != null ? true : s.arrivalDelay != null ? false : null
    const dep = s.cancelled && s.departure == null && pd != null ? true : s.departureDelay != null ? false : null
    observe(e, ms, src, rt, src === 'trip' ? arr : null, src === 'trip' ? dep : null, s.departurePlatform ?? s.arrivalPlatform ?? null)
    for (const h of s.remarks) { use(h, ms, t, e.station); e.remarks.add(h) }
    return e
  }

  const planCover = new Map(), turnPoints = new Map()
  const endPoint = (product, stop, line, side, value = line) => {
    const station = stationOfStop.get(stop)
    if (!station || !product || ring.has(line)) return
    const key = `${product}|${station}`
    const p = turnPoints.get(key) ?? turnPoints.set(key, { station, product, lines: new Set(), starts: new Set(), ends: new Set(), cuts: new Set(), turns: [] }).get(key)
    p.lines.add(line)
    p[side].add(value)
  }
  await read('plan', r => {
    push(planCover, r.line, [at(r.fromWhen), at(r.untilWhen)])
    for (const p of r.trips) {
      endPoint(lineById.get(r.line)?.product, p.origin, r.line, 'starts')
      endPoint(lineById.get(r.line)?.product, p.destination, r.line, 'ends')
      if (!ofDay(p.tripId)) continue
      const t = trip(p.tripId)
      t.seen.plan ??= r.ms
      t.inPlan = true
      t.ref ??= { line: r.line, lineId: p.lineId, fahrtNr: p.fahrtNr, product: lineById.get(r.line)?.product ?? null, operator: null }
      t.ends ??= { origin: p.origin, destination: p.destination, pd: at(p.plannedDeparture), pa: at(p.plannedArrival) }
      t.direction ??= p.direction
    }
  })

  await read('trip', r => {
    if (inDay(r.ms)) cover.trip[minuteOf(r.ms)]++
    if (!r.trip || !ofDay(r.tripId)) return
    const t = trip(r.tripId), x = r.trip
    t.seen.trip ??= r.ms
    t.fetches++
    t.ref = refOf(x)
    t.direction = x.direction ?? t.direction ?? null
    t.occupancy = x.occupancy ?? t.occupancy ?? null
    for (const h of x.remarks) use(h, r.ms, t, null)
    x.stopovers.forEach((s, i) => {
      const e = stopover(t, s, r.ms, 'trip')
      Object.assign(e, { seq: i, pa: at(s.plannedArrival), pd: at(s.plannedDeparture), fetched: true })
      e.occupancy = s.occupancy ?? e.occupancy ?? null
      for (const [kind, time, delay] of [['arr', at(s.arrival), s.arrivalDelay], ['dep', at(s.departure), s.departureDelay]]) {
        if (!plausible(delay) || time == null) continue
        if (time <= r.ms + 2 * M) {
          e.actual[kind] = [time, delay, r.ms]
          t.obs.push([r.ms, delay])
        } else predict(t, e, kind, 'trip', r.ms, time, delay)
      }
    })
  })

  await read('board', r => {
    if (inDay(r.ms)) cover.board[minuteOf(r.ms)]++
    for (const row of r.rows) {
      if (!ofDay(row.tripId) || !['suburban', 'subway'].includes(row.product)) continue
      const t = trip(row.tripId)
      t.seen.board ??= r.ms
      t.ref ??= refOf(row)
      t.direction ??= row.direction
      const e = event(t, row.stop ?? r.stop, at(row.plannedWhen))
      e.pd ??= at(row.plannedWhen)
      e.plannedPlatform ??= row.plannedPlatform
      e.occupancy ??= row.occupancy
      observe(e, r.ms, 'board', row.cancelled || row.delay != null, null, row.cancelled ? true : row.delay != null ? false : null, row.platform)
      for (const h of row.remarks) { use(h, r.ms, t, e.station); e.remarks.add(h) }
      predict(t, e, 'dep', 'board', r.ms, at(row.when), row.delay)
    }
  })

  const sevSnaps = [], positions = []
  await read('radar', r => {
    live.add(Math.floor(r.ms / M))
    if (inDay(r.ms)) cover.radar[minuteOf(r.ms)] = 1
    const sev = {}
    for (const x of r.trains) {
      if (x.product === 'bus') { sev[x.line] = (sev[x.line] ?? 0) + 1; continue }
      if (withPositions && inDay(r.ms)) positions.push([sec(r.ms), 'radar', x.tripId, x.line, x.lat, x.lon])
      if (!ofDay(x.tripId)) continue
      const t = trip(x.tripId)
      t.seen.radar ??= r.ms
      t.ref ??= refOf(x)
      t.direction ??= x.direction
      t.seenAt.push(r.ms)
      if (x.lat != null) t.pos.push([r.ms, x.lon, x.lat])
      for (const s of x.next) {
        const e = stopover(t, s, r.ms, 'radar')
        predict(t, e, 'arr', 'radar', r.ms, at(s.arrival), s.arrivalDelay)
        predict(t, e, 'dep', 'radar', r.ms, at(s.departure), s.departureDelay)
      }
    }
    if (inDay(r.ms)) sevSnaps.push([r.ms, sev])
  })

  await read('running', r => {
    live.add(Math.floor(r.ms / M))
    if (inDay(r.ms)) cover.running[minuteOf(r.ms)] = 1
    for (const x of r.trains) {
      if (withPositions && inDay(r.ms)) positions.push([sec(r.ms), 'running', x.tripId, x.line, x.lat, x.lon])
      if (!ofDay(x.tripId)) continue
      const t = trip(x.tripId)
      t.seen.running ??= r.ms
      t.ref ??= refOf(x)
      t.seenAt.push(r.ms)
      t.ends ??= { origin: x.origin, destination: x.destination, pd: at(x.plannedDeparture), pa: at(x.plannedArrival) }
    }
  })
  const lastLive = live.size ? Math.max(...live) * M : -Infinity
  const segmentStart = (ms) => {
    let m = Math.floor(ms / M)
    while (live.has(m - 1)) m--
    return m * M
  }

  const all = []
  for (const t of trips.values()) {
    if (!t.fetches && t.ends) for (const [stop, pd, pa] of [[t.ends.origin, t.ends.pd, null], [t.ends.destination, null, t.ends.pa]]) {
      if (!stop || (pd ?? pa) == null) continue
      const e = event(t, stop, pd ?? pa)
      e.pd ??= pd
      e.pa ??= pa
    }
    const list = [...t.ev.values()]
      .filter(e => !t.fetches || e.fetched)
      .filter(e => (e.pa ?? e.pd) != null)
      .sort((a, b) => (a.pa ?? a.pd) - (b.pa ?? b.pd) || (a.seq ?? 0) - (b.seq ?? 0))
    if (!list.length) continue
    for (const e of list) {
      e.arrCancelled = Boolean(e.cancel.arr?.[1] && e.pa != null)
      e.depCancelled = Boolean(e.cancel.dep?.[1] && e.pd != null)
      e.cancelled = (e.arrCancelled || e.pa == null) && (e.depCancelled || e.pd == null)
      const arr = e.arrCancelled ? null : e.actual.arr ? [...e.actual.arr, 'trip'] : e.pred.arr
      const dep = e.depCancelled ? null : e.actual.dep ? [...e.actual.dep, 'trip'] : e.pred.dep
      e.arrS = arr?.[0] ?? null
      e.arrDelay = arr?.[1] ?? null
      e.depS = dep?.[0] ?? null
      e.depDelay = dep?.[1] ?? null
      e.rtArr = Boolean(!e.arrCancelled && e.actual.arr)
      e.rtDep = Boolean(!e.depCancelled && e.actual.dep)
      e.rt = e.rtArr || e.rtDep
      e.src = e.rt ? 'trip' : (dep ?? arr)?.[3] ?? null
      e.platformFinal = e.platform ?? e.staticPlatform ?? null
      e.cancelSeen = Number.isFinite(e.cancelSeen) ? e.cancelSeen : null
    }
    const ref = t.ref ?? {}
    const line = lineById.get(ref.line)
    const index = line && lineIndex.get(line.id)
    let sign = 0
    if (index) for (let i = 1; i < list.length; i++) {
      const a = index.get(list[i - 1].station), b = index.get(list[i].station)
      if (a != null && b != null && Math.abs(b - a) === 1) sign += b - a
    }
    const mapped = index ? list.filter(e => index.has(e.station)) : []
    if (!sign && mapped.length >= 2) sign = ring.has(line.id) ? 1 : index.get(mapped.at(-1).station) - index.get(mapped[0].station)
    const running = list.filter(e => !e.cancelled)
    const delays = list.flatMap(e => [e.arrDelay, e.depDelay]).filter(d => d != null)
    const realtimeSeen = Math.min(...['trip', 'board', 'radar', 'running'].map(k => t.seen[k] ?? Infinity))
    const ghost = !t.fetches && /HTTP 4/.test(lost.get(t.id) ?? '')
    const T = {
      id: t.id, t, line: ref.line ?? null, lineKnown: Boolean(line), product: ref.product ?? line?.product ?? null, operator: ref.operator ?? null,
      lineVariant: ref.lineId ?? null, fahrtNr: ref.fahrtNr ?? null, direction: t.direction ?? null,
      dirTo: line && sign ? (sign > 0 ? line.stations.at(-1) : line.stations[0]) : (list.at(-1).station ?? list.at(-1).stop), dirKnown: Boolean(line && sign),
      events: list, running,
      status: running.length === 0 ? 'cancelled' : running.length < list.length ? 'partial' : t.fetches ? 'ok' : ghost ? 'ghost' : 'unfetched',
      observed: Number.isFinite(realtimeSeen), realtimeSeen: Number.isFinite(realtimeSeen) ? realtimeSeen : null,
      plannedStart: list[0].pd ?? list[0].pa, start: running[0]?.depS ?? null,
      plannedEnd: list.at(-1).pa ?? list.at(-1).pd, end: running.at(-1)?.arrS ?? null,
      maxDelay: delays.length ? Math.max(...delays) : null, endDelay: running.at(-1)?.arrDelay ?? null,
      firstSeen: Math.min(...Object.values(t.seen)), runs: [],
    }
    T.train = T
    for (const e of list) e.T = T
    all.push(T)
  }
  all.sort((a, b) => a.plannedStart - b.plannedStart)
  const byId = new Map(all.map(T => [T.id, T]))

  const rootOf = (T) => {
    while (T.train !== T) T = T.train
    return T
  }
  const link = (a, b) => {
    const [early, late] = [rootOf(a), rootOf(b)].sort((x, y) => x.plannedStart - y.plannedStart)
    if (early !== late) late.train = early
  }
  const owner = new Map()
  const rank = (e) => (e.rtMs != null || e.rt ? 8 : 0) + (e.cancelled ? 0 : 4) + (e.T.t.fetches ? 2 : 0) + (e.T.observed ? 1 : 0)
  const candidates = all.filter(T => T.lineKnown && T.status !== 'ghost').flatMap(T => T.events.filter(e => e.station))
  candidates.sort((a, b) => rank(b) - rank(a) || a.T.plannedStart - b.T.plannedStart)
  for (const e of candidates) {
    const base = `${e.T.line}|${e.T.dirTo}|${e.station}`
    const keys = [e.pa != null && `${base}|a${e.pa}`, e.pd != null && `${base}|d${e.pd}`].filter(Boolean)
    const primary = keys.map(k => owner.get(k)).find(o => o && o.T !== e.T)
    if (!primary) {
      for (const k of keys) if (!owner.has(k)) owner.set(k, e)
      continue
    }
    e.dupOf = primary
    link(e.T, primary.T)
  }
  const ringEnds = new Map()
  for (const T of all) if (ring.has(T.line) && T.status !== 'ghost') ringEnds.set(`${T.line}|${T.events.at(-1).station}|${T.events.at(-1).pa}`, T)
  for (const T of all) if (ring.has(T.line) && T.status !== 'ghost') {
    const before = [0, 1, 2].map(lag => ringEnds.get(`${T.line}|${T.events[0].station}|${T.events[0].pd - lag * M}`)).find(x => x && x !== T)
    if (before) link(before, T)
  }
  for (const T of all) {
    T.twin = T.events.every(e => e.dupOf)
    if (!T.observed && T.events.some(e => e.dupOf && covered(e.pa ?? e.pd))) T.status = 'ghost'
  }
  const real = all.filter(T => T.status !== 'ghost')

  const stopEvents = [], runs = [], headways = [], turnbacks = []
  for (const T of all) {
    T.events.forEach((e, i) => stopEvents.push([
      T.id, i, e.station, e.stop, sec(e.pa), sec(e.arrS), e.arrDelay, sec(e.pd), sec(e.depS), e.depDelay,
      e.pa != null && e.pd != null ? sec(e.pd - e.pa) : null, e.arrS != null && e.depS != null ? sec(e.depS - e.arrS) : null,
      e.plannedPlatform ?? null, e.platformFinal, e.cancelled, e.arrCancelled, e.depCancelled, e.rt, e.occupancy ?? null, e.src, sec(e.cancelSeen),
      e.dupOf?.T.id ?? null,
    ]))
    if (T.status === 'ghost') continue
    for (let i = 1; i < T.running.length; i++) {
      const a = T.running[i - 1], b = T.running[i]
      if (b.dupOf || a.depCancelled || b.arrCancelled) continue
      const planned = a.pd != null && b.pa != null ? b.pa - a.pd : null
      const measured = a.rtDep && b.rtArr ? b.actual.arr[0] - a.actual.dep[0] : null
      const actual = measured != null && planned != null && measured < planned - M ? null : measured
      if (measured != null) b.arrFloor = a.actual.dep[1] - 60
      T.runs.push({ T, a, b, planned, actual })
      runs.push([
        T.id, T.line, T.dirTo, a.station ?? a.stop, b.station ?? b.stop, sec(planned), sec(actual),
        planned != null && actual != null ? sec(planned - actual) : null, corridorOf.get(`${a.station}|${b.station}`) ?? null,
      ])
    }
  }

  const hwGroups = new Map()
  for (const T of real) if (T.line) for (const e of T.events) if (e.station && e.pd != null && !e.dupOf) push(hwGroups, `${e.station}|${T.line}|${T.dirTo}`, e)
  for (const group of hwGroups.values()) {
    group.sort((a, b) => a.pd - b.pd)
    group.forEach((e, i) => { e.hPlan = i ? e.pd - group[i - 1].pd : null })
    const actual = group.filter(e => !e.depCancelled && !e.cancelled && e.depS != null).sort((a, b) => a.depS - b.depS)
    actual.forEach((e, i) => {
      e.leader = actual[i - 1] ?? null
      e.follower = actual[i + 1] ?? null
      e.h = e.leader ? e.depS - e.leader.depS : null
    })
    for (const e of group) {
      if (e.cancelled || e.depCancelled) continue
      e.hRt = e.h != null && e.rtDep && e.leader.rtDep
      const ratio = e.h != null && e.hPlan ? Math.round(e.h / e.hPlan * 100) / 100 : null
      e.bunch = e.hRt && ratio != null && ratio < 0.5
      e.gap = e.hRt && ratio != null && ratio > 1.5
      headways.push([e.station, e.T.line, e.T.dirTo, e.T.id, sec(e.pd), sec(e.depS), sec(e.hPlan), sec(e.h), ratio, e.bunch, e.gap, e.hRt])
    }
  }

  const ends = new Map()
  for (const T of real) if (T.dirKnown && !ring.has(T.line) && T.running.length >= 2) {
    const first = T.running[0], last = T.running.at(-1)
    for (const [key, side, e, time] of [[`${T.line}|${last.station}`, 'ins', last, last.arrS ?? last.pa], [`${T.line}|${first.station}`, 'outs', first, first.depS ?? first.pd]]) {
      if (e.dupOf) continue
      if (!ends.has(key)) ends.set(key, { ins: [], outs: [] })
      ends.get(key)[side].push({ T, e, time })
    }
  }
  for (const { ins, outs } of ends.values()) {
    const used = new Set()
    for (const a of ins.sort((x, y) => x.time - y.time)) {
      const options = outs.filter(o => !used.has(o) && o.T.dirTo !== a.T.dirTo && o.time - a.time >= 4 * M && o.time - a.time <= 20 * M).sort((x, y) => x.time - y.time)
      const o = options.find(x => a.e.platformFinal && x.e.platformFinal === a.e.platformFinal) ?? options[0]
      if (!o) continue
      used.add(o)
      turnbacks.push({ station: a.e.station, line: a.T.line, inT: a.T, outT: o.T, a: a.e, o: o.e })
    }
  }

  for (const T of real) {
    if (T.t.fetches && !T.t.inPlan && !remarkCode(T, /additional\.service/).length) {
      endPoint(T.product, T.events[0].stop, T.line, 'starts')
      endPoint(T.product, T.events.at(-1).stop, T.line, 'ends')
    }
    if (T.status !== 'partial' || !T.t.fetches) continue
    if (T.events[0].cancelled) endPoint(T.product, T.running[0].stop, T.line, 'cuts', T.id)
    if (T.events.at(-1).cancelled) endPoint(T.product, T.running.at(-1).stop, T.line, 'cuts', T.id)
  }
  for (const x of turnbacks) if (x.a.arrS != null && x.o.depS != null) turnPoints.get(`${x.inT.product}|${x.station}`)?.turns.push((x.o.depS - x.a.arrS) / 1000)
  const turnable = (T, station) => {
    const p = turnPoints.get(`${T.product}|${station}`)
    return ring.has(T.line) ? null : Boolean(p && (p.starts.size || p.ends.size || [...p.cuts].some(id => id !== T.id)))
  }
  const headwayPairs = new Map()
  for (const T of real) for (let i = 1; i < T.running.length; i++) {
    const a = T.running[i - 1], b = T.running[i]
    if (!geom.has(`${a.station}|${b.station}`) || a.dupOf || a.depCancelled || a.pd == null) continue
    const key = `${a.station}|${b.station}`
    const p = headwayPairs.get(key) ?? headwayPairs.set(key, { from: a.station, to: b.station, lines: new Set(), planned: [], observed: [] }).get(key)
    p.lines.add(T.line)
    p.planned.push(a.pd)
    if (a.rtDep) p.observed.push(a.actual.dep[0])
  }
  const minGap = (list) => {
    const sorted = [...list].sort((x, y) => x - y)
    let min = null
    for (let i = 1; i < sorted.length; i++) if (min == null || sorted[i] - sorted[i - 1] < min) min = sorted[i] - sorted[i - 1]
    return sec(min)
  }
  const minHeadways = [...headwayPairs.values()].filter(p => p.planned.length >= 2).map(p => ({
    from: p.from, to: p.to, lines: [...p.lines].sort(), n: p.planned.length, plannedMinS: minGap(p.planned), observedMinS: minGap(p.observed), nObserved: p.observed.length,
  }))
  const turnStations = [...turnPoints.values()].map(p => ({
    station: p.station, product: p.product, lines: [...p.lines].sort(), starts: [...p.starts].sort(), ends: [...p.ends].sort(), cuts: p.cuts.size, terminus: allTermini.has(p.station),
    turns: p.turns.length, turnMinS: p.turns.length ? Math.round(Math.min(...p.turns)) : null,
    turnMedianS: p.turns.length ? [...p.turns].sort((x, y) => x - y)[Math.floor(p.turns.length / 2)] : null,
  })).sort((a, b) => a.station.localeCompare(b.station))

  const feeders = new Map()
  for (const T of real) for (const e of T.running) if (e.station && e.rtArr && !e.dupOf) push(feeders, e.station, e)
  const actions = []
  const action = (type, subtype, T, e, plannedMs, decidedRaw, confidence, evidence, feasible = null) => {
    const decidedMs = Number.isFinite(decidedRaw) ? decidedRaw : null
    const observedFrom = Math.max(decidedMs == null ? -Infinity : segmentStart(decidedMs), T?.realtimeSeen ?? -Infinity)
    actions.push({
      id: `${type}:${T?.id ?? 'line'}:${e?.station ?? e?.stop ?? actions.length}`, type, subtype,
      tripId: T?.id ?? null, line: T?.line ?? null, dirTo: T?.dirTo ?? null, station: e?.station ?? e?.stop ?? null,
      plannedS: sec(plannedMs), decidedS: sec(decidedMs), leadS: plannedMs != null && decidedMs != null ? sec(plannedMs - decidedMs) : null,
      censored: decidedMs == null || decidedMs - observedFrom <= M, feasible, confidence, evidence,
      stateT: decidedMs != null ? Math.floor(decidedMs / M) * 60 : plannedMs != null ? Math.floor(plannedMs / M) * 60 : null,
    })
  }
  const firstCancel = (list) => list.map(e => e.cancelSeen).filter(x => x != null).reduce((a, b) => Math.min(a, b), Infinity)
  const renumbered = new Set()
  for (const T of real) {
    if (T.status === 'cancelled' && !T.twin) {
      const seen = firstCancel(T.events)
      const decided = Number.isFinite(seen) ? seen : T.realtimeSeen ?? T.firstSeen
      action('cancel', null, T, T.events[0], T.plannedStart, decided, 1, [{ src: 'trip', obsS: sec(decided), field: 'cancelled', value: true }], true)
      continue
    }
    if (T.status !== 'partial') continue
    const head = [], tail = []
    for (const e of T.events) { if (!e.cancelled) break; head.push(e) }
    for (const e of [...T.events].reverse()) { if (!e.cancelled) break; tail.push(e) }
    if (head.length && !T.running[0].dupOf) {
      const cut = T.running[0]
      const decided = Math.min(firstCancel(head), cut.cancelSeen ?? Infinity)
      action('partial', 'head', T, cut, cut.pd ?? cut.pa, decided, 0.9, [{ src: 'trip', obsS: sec(decided), field: 'cancelledStops', value: head.length }], turnable(T, cut.station))
    }
    if (tail.length && !T.running.at(-1).dupOf) {
      const cut = T.running.at(-1)
      const decided = Math.min(firstCancel(tail), cut.cancelSeen ?? Infinity)
      const cutTime = cut.arrS ?? cut.pa
      const lostStations = new Set(tail.map(e => e.station))
      const successor = T.t.fetches && real.find(o =>
        o !== T
        && o.running[0]?.station === cut.station
        && Math.abs((o.running[0].pd ?? 0) - (cut.pd ?? cut.pa)) <= M
        && (o.line === T.line || !o.lineKnown)
        && o.running.slice(1).some(e => lostStations.has(e.station)))
      const turn = !successor && real.find(o =>
        o.line === T.line
        && o.dirTo !== T.dirTo
        && o.events.some(e => {
          const leaves = e.depS ?? e.pd
          return e.station === cut.station && !e.cancelled && !e.depCancelled && e.pd != null && leaves - cutTime >= 3 * M && leaves - cutTime <= 15 * M
        }))
      if (successor) {
        renumbered.add(successor.id)
        action('renumber', null, T, cut, cut.pd ?? cut.pa, Math.min(decided, successor.firstSeen), 0.9, [
          { src: 'trip', obsS: sec(successor.firstSeen), field: 'successorTripId', value: successor.id },
          { src: 'trip', obsS: sec(successor.firstSeen), field: 'successorFahrtNr', value: successor.fahrtNr },
        ], true)
      } else if (turn) {
        action('short_turn', null, T, cut, cutTime, decided, 0.8, [{ src: 'trip', obsS: sec(decided), field: 'turnTripId', value: turn.id }], turnable(T, cut.station))
      } else {
        action('partial', 'tail', T, cut, cut.pa, decided, 0.9, [{ src: 'trip', obsS: sec(decided), field: 'cancelledStops', value: tail.length }], turnable(T, cut.station))
      }
    }
    T.events.forEach((e, i) => {
      if (!e.cancelled || e.dupOf || !T.events.slice(0, i).some(x => !x.cancelled) || !T.events.slice(i + 1).some(x => !x.cancelled)) return
      action('skip_stop', null, T, e, e.pa ?? e.pd, e.cancelSeen, 0.9, [{ src: 'trip', obsS: sec(e.cancelSeen), field: 'cancelled', value: true }], true)
    })
  }
  const diversions = []
  for (const T of real) {
    if (renumbered.has(T.id) || T.twin) continue
    const added = remarkCode(T, /additional\.service/)
    const windows = planCover.get(T.line) ?? []
    const missing = T.lineKnown && T.observed && !T.t.inPlan && windows.some(([a, b]) => T.plannedStart >= a && T.plannedStart < b)
    if (added.length) action('add', 'remark', T, T.events[0], T.plannedStart, Math.min(added[0][1], T.firstSeen), 0.9, [{ src: 'remark', obsS: sec(added[0][1]), field: 'remark', value: added[0][0] }])
    else if (missing) action('add', 'notInPlan', T, T.events[0], T.plannedStart, T.firstSeen, 0.7, [{ src: 'plan', obsS: sec(T.firstSeen), field: 'inPlan', value: false }])
    for (const e of T.events) {
      if (e.dupOf || !e.platform || !e.plannedPlatform || platformKey(e.platform) === platformKey(e.plannedPlatform)) continue
      const [seenMs, src] = e.platformSeen ?? [null, 'trip']
      action('platform_change', null, T, e, e.pd ?? e.pa, seenMs, 1, [{ src, obsS: sec(seenMs), field: 'platform', value: e.platform }])
    }
    for (const e of T.running.slice(1, -1)) {
      if (e.dupOf || !e.rtArr || !e.rtDep || e.pa == null || e.pd == null) continue
      const arrDelay = Math.max(e.actual.arr[1], e.arrFloor ?? -Infinity)
      const extra = e.actual.dep[1] - arrDelay
      if (arrDelay < 0 || extra < 180) continue
      const regulate = e.leader && e.hPlan && e.arrS - e.leader.depS < 0.7 * e.hPlan
      const hub = (stationById.get(e.station)?.lines.length ?? 0) >= 3
      const feeder = hub && (feeders.get(e.station) ?? []).find(f => f.T.line !== T.line && f.arrDelay >= 120 && e.depS - f.arrS >= 0 && e.depS - f.arrS <= 5 * M)
      const decided = e.depObs.sort((x, y) => x[0] - y[0]).find(([obs, d]) => d >= e.depDelay - 60 && obs <= e.depS)?.[0] ?? e.arrS
      action('hold', regulate ? 'regulate' : feeder ? 'connection' : 'other', T, e, e.pd, decided, 0.6, [
        { src: e.src, obsS: sec(e.depS), field: 'extraDwellS', value: extra },
        ...(feeder ? [{ src: feeder.src, obsS: sec(feeder.arrS), field: 'feederTripId', value: feeder.T.id }] : []),
      ], true)
    }
    const index = T.lineKnown && T.t.fetches && lineIndex.get(T.line)
    if (index) T.running.forEach((e, i) => {
      if (i === 0 || i === T.running.length - 1 || !e.station) return
      const additional = [...e.remarks].some(h => /stop\.additional/.test(code(h)))
      const offLine = !index.has(e.station) && T.running.slice(0, i).some(x => index.has(x.station)) && T.running.slice(i + 1).some(x => index.has(x.station))
      if (additional || offLine) diversions.push([T, e, additional ? 'additional_stop' : 'diversion'])
    })
  }
  const diversionCount = new Map()
  for (const [T, e, subtype] of diversions) diversionCount.set(`${T.line}|${e.station}|${subtype}`, (diversionCount.get(`${T.line}|${e.station}|${subtype}`) ?? 0) + 1)
  for (const [T, e, subtype] of diversions) {
    if (subtype === 'diversion' && diversionCount.get(`${T.line}|${e.station}|${subtype}`) >= 3) continue
    const decided = [...e.remarks].map(h => T.t.remarkFirst.get(h)).filter(Boolean).reduce((a, b) => Math.min(a, b), T.t.seen.trip ?? T.firstSeen)
    action('reroute', subtype, T, e, e.pa ?? e.pd, decided, subtype === 'additional_stop' ? 0.8 : 0.6, [{ src: 'trip', obsS: sec(decided), field: 'station', value: e.station }])
  }
  for (const turn of turnbacks) {
    if (!turn.a.rtArr || !turn.o.rtDep || turn.o.dupOf) continue
    const arrDelay = Math.max(turn.a.actual.arr[1], turn.a.arrFloor ?? -Infinity)
    const carry = turn.o.actual.dep[1] - arrDelay
    if (arrDelay < 0 || carry < 180) continue
    const decided = turn.o.depObs.sort((x, y) => x[0] - y[0]).find(([, d]) => d >= turn.o.depDelay - 60)?.[0] ?? turn.a.arrS
    action('hold', 'terminus', turn.outT, turn.o, turn.o.pd, decided, 0.6, [
      { src: turn.o.src, obsS: sec(turn.o.depS), field: 'carryS', value: carry },
      { src: turn.a.src, obsS: sec(turn.a.arrS), field: 'inTripId', value: turn.inT.id },
    ], true)
  }
  for (const lineId of lineById.keys()) {
    const bins = new Map()
    for (const T of real) if (T.line === lineId && T.t.fetches && T.running.length && !T.twin) push(bins, Math.floor(T.plannedStart / (30 * M)), T)
    for (const [bin, list] of bins) {
      const cut = list.filter(T => T.events[0].cancelled || T.events.at(-1).cancelled)
      if (cut.length < 2 || cut.length / list.length < 0.5) continue
      const decided = Math.min(...cut.map(T => firstCancel(T.events)))
      const station = cut[0].events.at(-1).cancelled ? cut[0].running.at(-1).station : cut[0].running[0].station
      actions.push({
        id: `pendel:${lineId}:${bin}`, type: 'pendel', subtype: 'cut', tripId: null, line: lineId, dirTo: null, station,
        plannedS: bin * 1800, decidedS: sec(decided), leadS: Number.isFinite(decided) ? bin * 1800 - sec(decided) : null,
        censored: !Number.isFinite(decided) || decided - segmentStart(decided) <= M, feasible: null, confidence: 0.7,
        evidence: cut.slice(0, 5).map(T => ({ src: 'trip', obsS: sec(firstCancel(T.events)), field: 'cutTripId', value: T.id })),
        stateT: Number.isFinite(decided) ? Math.floor(decided / M) * 60 : bin * 1800,
      })
    }
  }
  for (const [hash, u] of usage) {
    const r = remarkInfo.get(hash)
    if (!/pendelverkehr/i.test(`${r?.summary ?? ''} ${r?.text ?? ''}`)) continue
    for (const lineId of u.lines) if (lineById.has(lineId)) actions.push({
      id: `pendel:${lineId}:${hash}`, type: 'pendel', subtype: 'remark', tripId: null, line: lineId, dirTo: null, station: [...u.stations][0] ?? null,
      plannedS: sec(at(r.validFrom) ?? u.first), decidedS: sec(u.first), leadS: at(r.validFrom) ? sec(at(r.validFrom) - u.first) : null,
      censored: u.first - segmentStart(u.first) <= M, feasible: null, confidence: 0.7,
      evidence: [{ src: 'remark', obsS: sec(u.first), field: 'remark', value: hash }], stateT: Math.floor(u.first / M) * 60,
    })
  }

  const sev = []
  for (const lineId of lineById.keys()) {
    let episode = null
    sevSnaps.forEach(([ms, counts], i) => {
      const n = counts[lineId] ?? 0
      if (!n) return
      if (episode && ms - episode.to <= 5 * M) return Object.assign(episode, { to: ms, toIndex: i, snaps: episode.snaps + 1, max: Math.max(episode.max, n) })
      if (episode?.snaps >= 3) sev.push(episode)
      episode = { line: lineId, from: ms, to: ms, fromIndex: i, toIndex: i, snaps: 1, max: n }
    })
    if (episode?.snaps >= 3) sev.push(episode)
  }
  for (const s of sev) {
    s.startObserved = s.fromIndex > 0 && s.from - sevSnaps[s.fromIndex - 1][0] <= 90000
    s.endObserved = s.toIndex < sevSnaps.length - 1 && sevSnaps[s.toIndex + 1][0] - s.to <= 90000
    for (const [type, ms, ok, value] of [['sev_start', s.from, s.startObserved, s.max], ['sev_end', s.to, s.endObserved, 0]]) if (ok) actions.push({
      id: `${type}:${s.line}:${sec(ms)}`, type, subtype: null, tripId: null, line: s.line, dirTo: null, station: null,
      plannedS: sec(ms), decidedS: sec(ms), leadS: 0, censored: false, feasible: true, confidence: 0.9,
      evidence: [{ src: 'radar', obsS: sec(ms), field: 'sevVehicles', value }], stateT: Math.floor(ms / M) * 60,
    })
  }
  const recurring = new Map()
  for (const a of actions) recurring.set(`${a.type}|${a.subtype}|${a.line}|${a.station}`, (recurring.get(`${a.type}|${a.subtype}|${a.line}|${a.station}`) ?? 0) + 1)
  const lineDelays = new Map(), lineHeadways = new Map()
  for (const T of real) for (const e of T.running) {
    if (e.dupOf) continue
    if (e.rtArr) push(lineDelays, T.line, [e.arrS, e.arrDelay, T.dirTo])
    if (e.hRt) push(lineHeadways, T.line, [e.depS, e.h / 1000, T.dirTo])
  }
  for (const a of actions) {
    a.recurring = recurring.get(`${a.type}|${a.subtype}|${a.line}|${a.station}`)
    const t = a.plannedS * 1000
    const pick = (list, lo, hi) => (list ?? []).filter(([time, , dir]) => time >= lo && time < hi && (!a.dirTo || dir === a.dirTo)).map(x => x[1])
    const before = mean(pick(lineDelays.get(a.line), t - 30 * M, t)), after = mean(pick(lineDelays.get(a.line), t, t + 30 * M))
    a.outcome = {
      delay30BeforeS: before == null ? null : Math.round(before), delay30AfterS: after == null ? null : Math.round(after),
      cvBefore: cv(pick(lineHeadways.get(a.line), t - 30 * M, t)), cvAfter: cv(pick(lineHeadways.get(a.line), t, t + 30 * M)),
    }
  }
  actions.sort((a, b) => (a.plannedS ?? 0) - (b.plannedS ?? 0))

  const incidents = []
  for (const run of real.flatMap(T => T.runs)) if (run.actual != null && run.planned != null && run.actual > run.planned + 180000) incidents.push({
    type: 'stall', line: run.T.line, segment: `${run.a.station ?? run.a.stop}-${run.b.station ?? run.b.stop}`, station: null,
    fromS: sec(run.a.depS), toS: sec(run.b.arrS), confidence: 0.7, tripId: run.T.id,
  })
  const stationPoints = network.stations.map(s => [s.lon, s.lat])
  for (const T of real) {
    const pos = T.t.pos.sort((a, b) => a[0] - b[0])
    for (let i = 0, j = 0; i < pos.length; i = Math.max(j, i + 1)) {
      j = i
      while (j + 1 < pos.length && dist(pos[i].slice(1), pos[j + 1].slice(1)) < 30 && pos[j + 1][0] - pos[j][0] <= 90000) j++
      if (pos[j][0] - pos[i][0] >= 180000 && !stationPoints.some(p => dist(p, pos[i].slice(1)) < 250))
        incidents.push({ type: 'stall', line: T.line, segment: null, station: null, lat: pos[i][2], lon: pos[i][1], fromS: sec(pos[i][0]), toS: sec(pos[j][0]), confidence: 0.5, tripId: T.id })
    }
    for (const e of T.running) if (e.occupancy === 'high' && e.gap && !e.dupOf)
      incidents.push({ type: 'crowd_gap', line: T.line, segment: null, station: e.station, fromS: sec(e.depS - e.h), toS: sec(e.depS), confidence: 0.6, tripId: T.id })
  }
  const bunches = new Map()
  for (const T of real) for (const e of T.running) if (e.bunch) push(bunches, `${T.line}|${T.dirTo}`, e)
  for (const list of bunches.values()) {
    let episode = null
    for (const e of list.sort((a, b) => a.depS - b.depS)) {
      if (episode && e.depS - episode.to <= 15 * M) { Object.assign(episode, { to: e.depS, n: episode.n + 1 }); continue }
      if (episode) incidents.push({ type: 'bunching', line: e.T.line, segment: null, station: episode.station, fromS: sec(episode.from), toS: sec(episode.to), confidence: 0.6, n: episode.n })
      episode = { station: e.station, from: e.depS, to: e.depS, n: 1 }
    }
    if (episode) incidents.push({ type: 'bunching', line: list[0].T.line, segment: null, station: episode.station, fromS: sec(episode.from), toS: sec(episode.to), confidence: 0.6, n: episode.n })
  }
  incidents.sort((a, b) => a.fromS - b.fromS)

  const snapshots = [], lineAcc = new Map()
  for (const T of real) {
    const run = T.running
    if (!T.observed || run.length < 2) continue
    const times = []
    for (const e of run) {
      const a = Math.max(e.arrS ?? e.pa ?? e.depS ?? e.pd, times.at(-1)?.[1] ?? -Infinity)
      times.push([a, Math.max(e.depS ?? e.pd ?? a, a)])
    }
    const obs = T.t.obs.sort((a, b) => a[0] - b[0]), pos = T.t.pos, seenAt = T.t.seenAt.sort((a, b) => a - b)
    let k = 0, o = -1, p = -1, s = 0
    for (let m = Math.ceil(times[0][1] / M) * M; m <= times.at(-1)[0]; m += M) {
      while (k < run.length - 1 && times[k][1] < m && times[k + 1][0] <= m) k++
      while (o + 1 < obs.length && obs[o + 1][0] <= m) o++
      while (p + 1 < pos.length && pos[p + 1][0] <= m) p++
      while (s < seenAt.length && seenAt[s] <= m - M) s++
      if (!covered(m)) continue
      const e = run[k], next = run[k + 1]
      const atStation = m <= times[k][1] || !next
      const target = atStation ? e : next
      if (target.dupOf) continue
      const frac = atStation ? 0 : Math.min(1, (m - times[k][1]) / Math.max(1, times[k + 1][0] - times[k][1]))
      const g = !atStation && geom.get(`${e.station}|${next.station}`)
      let where = atStation ? coords(e.station, e.stop) : null
      if (g) {
        const d = frac * g.cum.at(-1)
        let i = 1
        while (i < g.cum.length - 1 && g.cum[i] < d) i++
        const f = (d - g.cum[i - 1]) / Math.max(1e-9, g.cum[i] - g.cum[i - 1])
        where = [g.coords[i - 1][0] + (g.coords[i][0] - g.coords[i - 1][0]) * f, g.coords[i - 1][1] + (g.coords[i][1] - g.coords[i - 1][1]) * f]
      } else if (!atStation) {
        const c1 = coords(e.station, e.stop), c2 = coords(next.station, next.stop)
        where = c1 && c2 ? [c1[0] + (c2[0] - c1[0]) * frac, c1[1] + (c2[1] - c1[1]) * frac] : c1
      }
      const d1 = e.depDelay ?? e.arrDelay, d2 = next?.arrDelay
      const delay = atStation ? d1 ?? null : d1 != null && d2 != null ? Math.round(d1 + (d2 - d1) * frac) : d1 ?? d2 ?? null
      let stopped = null
      if (p >= 0 && m - pos[p][0] <= 90000) {
        let q = p
        while (q > 0 && dist(pos[q - 1].slice(1), pos[p].slice(1)) < 30) q--
        stopped = sec(pos[p][0] - pos[q][0])
      }
      const observed = s < seenAt.length && seenAt[s] <= m
      const known = o >= 0 ? obs[o][1] : null
      snapshots.push([
        sec(m), T.id, T.line, T.dirTo,
        where ? Math.round(where[1] * 1e5) / 1e5 : null, where ? Math.round(where[0] * 1e5) / 1e5 : null,
        e.station ?? e.stop, next ? next.station ?? next.stop : null, Math.round(frac * 100) / 100, atStation ? e.station ?? e.stop : null,
        delay, known, sec(target.h), sec(target.follower?.h), e.occupancy ?? T.t.occupancy ?? null, stopped, observed,
      ])
      const key = `${sec(m)}|${T.line}|${T.dirTo}`
      const acc = lineAcc.get(key) ?? lineAcc.set(key, { t: sec(m), line: T.line, dirTo: T.dirTo, active: 0, observed: 0, delays: [], known: [], gaps: [], bunching: 0, gapCount: 0 }).get(key)
      acc.active++
      if (observed) acc.observed++
      if (delay != null) acc.delays.push(delay)
      if (known != null) acc.known.push(known)
      if (target.hRt) acc.gaps.push(target.h / 1000)
      if (target.bunch) acc.bunching++
      if (target.gap) acc.gapCount++
    }
  }
  snapshots.sort((a, b) => a[0] - b[0] || String(a[2]).localeCompare(String(b[2])))

  const cancelledTimes = new Map()
  for (const T of real) for (const e of T.events) if (e.cancelled && !e.dupOf) push(cancelledTimes, `${T.line}|${T.dirTo}`, [e.pa ?? e.pd, e.cancelSeen ?? Infinity])
  const lineState = [...lineAcc.values()].sort((a, b) => a.t - b.t || String(a.line).localeCompare(String(b.line))).map(a => {
    const t = a.t * 1000
    const next30 = (cancelledTimes.get(`${a.line}|${a.dirTo}`) ?? []).filter(([x]) => x >= t && x < t + 30 * M)
    const sevActive = sev.some(s => s.line === a.line && s.from <= t && t <= s.to)
    return [
      a.t, a.line, a.dirTo, a.active, a.observed,
      a.delays.length ? Math.round(mean(a.delays)) : null, a.delays.length ? Math.max(...a.delays) : null,
      a.known.length ? Math.round(mean(a.known)) : null, a.known.length ? Math.max(...a.known) : null,
      cv(a.gaps), a.bunching, a.gapCount, next30.length, next30.filter(([, seen]) => seen <= t).length, sevActive,
    ]
  })

  const kpiAcc = new Map()
  const kpi = (ms, T) => {
    const bin = Math.floor(ms / (5 * M)) * 300
    const key = `${bin}|${T.line}|${T.dirTo}`
    const fresh = { t: bin, line: T.line, dirTo: T.dirTo, arrivals: 0, delays: [], cancelledTrips: 0, cancelledStops: 0, h: [], hp: [], bunching: 0, gaps: 0, stalls: 0, crowdGap: 0, pax: 0 }
    return kpiAcc.get(key) ?? kpiAcc.set(key, fresh).get(key)
  }
  for (const T of real) {
    if (T.status === 'cancelled' && !T.twin && covered(T.plannedStart)) kpi(T.plannedStart, T).cancelledTrips++
    for (const e of T.events) {
      const time = e.pa ?? e.pd
      if (e.dupOf || !covered(time)) continue
      const acc = kpi(time, T)
      if (e.cancelled) { acc.cancelledStops++; continue }
      if (e.pa != null && !e.arrCancelled) acc.arrivals++
      if (e.pa != null && e.rtArr) {
        acc.delays.push(e.arrDelay)
        acc.pax += Math.max(0, e.arrDelay) * (weights[e.occupancy] ?? 1)
      }
      if (e.hRt && e.hPlan) {
        acc.h.push(e.h / 1000)
        acc.hp.push(e.hPlan / 1000)
        if (e.bunch) acc.bunching++
        if (e.gap) acc.gaps++
      }
    }
  }
  for (const i of incidents) {
    const T = byId.get(i.tripId)
    if (!T || !covered(i.fromS * 1000)) continue
    if (i.type === 'stall') kpi(i.fromS * 1000, T).stalls++
    if (i.type === 'crowd_gap') kpi(i.fromS * 1000, T).crowdGap++
  }
  const share = (list, limit) => (list.length ? Math.round(list.filter(d => d < limit).length / list.length * 1000) / 1000 : null)
  const ewt = (h) => (h.length ? h.reduce((n, x) => n + x * x, 0) / (2 * h.reduce((n, x) => n + x, 0)) : null)
  const kpis = [...kpiAcc.values()].sort((a, b) => a.t - b.t || String(a.line).localeCompare(String(b.line))).map(a => [
    a.t, a.line, a.dirTo, [0, 1, 2, 3, 4].filter(i => covered(a.t * 1000 + i * M)).length / 5, a.arrivals,
    share(a.delays, 60), share(a.delays, 240), share(a.delays, 360), a.cancelledTrips, a.cancelledStops,
    a.h.length ? Math.round(ewt(a.h) - ewt(a.hp)) : null, cv(a.h), a.bunching, a.gaps, a.stalls, a.crowdGap, Math.round(a.pax),
  ])

  const disruptions = [...usage].filter(([h]) => remarkInfo.has(h)).map(([hash, u]) => {
    const r = remarkInfo.get(hash)
    const category = r.type === 'hint' ? 'hint' : categories.find(([, re]) => re.test(`${r.summary ?? ''} ${r.text ?? ''}`))?.[0] ?? 'other'
    return {
      hash, type: r.type, code: r.code, category, disruption: !notDisruption.has(category),
      summary: r.summary, text: r.text, validFromS: sec(at(r.validFrom)), validUntilS: sec(at(r.validUntil)), firstSeenS: sec(u.first), lastSeenS: sec(u.last),
      lines: [...u.lines].sort(), stations: [...u.stations].sort(), nTrips: u.trips.size,
    }
  }).sort((a, b) => a.firstSeenS - b.firstSeenS)

  const forecastRows = forecasts.filter(([obs]) => inDay(obs)).map(([obs, src, t, e, kind, delay]) => {
    const own = kind === 'arr' ? e.rtArr && e.actual.arr : e.rtDep && e.actual.dep
    const primary = e.dupOf && (kind === 'arr' ? e.dupOf.rtArr && e.dupOf.actual.arr : e.dupOf.rtDep && e.dupOf.actual.dep)
    const final = e.T ? (own || primary)?.[1] ?? null : null
    const planned = kind === 'arr' ? e.pa : e.pd
    return [sec(obs), src, t.id, e.station ?? e.stop, kind, sec(planned), delay, planned != null ? sec(planned + delay * 1000 - obs) : null, final, final != null ? delay - final : null]
  }).sort((a, b) => a[0] - b[0])

  const string = (list) => list.map(n => String(Math.min(9, n))).join('')
  const knownGaps = gaps.map(g => [Math.min(g.fromS, g.toS) * 1000, Math.max(g.fromS, g.toS) * 1000])
  for (let i = 0; i < minutes; i++) {
    if (cover.radar[i]) continue
    let j = i
    while (j < minutes && !cover.radar[j]) j++
    const a = startMs + i * M, b = startMs + j * M
    if (j - i >= 3 && !knownGaps.some(([x, y]) => x <= a + M && y >= b - M)) gaps.push({ fromS: sec(a), toS: sec(b), reason: 'nodata' })
    i = j
  }
  gaps.sort((a, b) => a.fromS - b.fromS)
  const rtShare = {}, rtN = {}
  for (const line of lineById.keys()) {
    const list = real.filter(T => T.line === line && T.plannedEnd + 10 * M <= lastLive).flatMap(T => T.running).filter(e => !e.dupOf && covered(e.pa ?? e.pd))
    rtShare[line] = list.length ? Math.round(list.filter(e => e.rt).length / list.length * 1000) / 1000 : null
    rtN[line] = list.length
  }
  const dateCheck = (list) => (list ?? []).find(h => h.startDate <= day && day <= h.endDate)?.name?.find(n => n.language === 'DE')?.text ?? null

  const tables = {
    stopEvents: [['tripId', 'seq', 'station', 'stop', 'plannedArrS', 'arrS', 'arrDelayS', 'plannedDepS', 'depS', 'depDelayS', 'dwellPlanS', 'dwellS', 'plannedPlatform', 'platform', 'cancelled', 'arrCancelled', 'depCancelled', 'rt', 'occupancy', 'src', 'cancelSeenS', 'dupOf'], stopEvents],
    runs: [['tripId', 'line', 'dirTo', 'from', 'to', 'plannedS', 'actualS', 'gainS', 'corridor'], runs],
    headways: [['station', 'line', 'dirTo', 'tripId', 'plannedDepS', 'depS', 'hPlanS', 'hS', 'ratio', 'bunch', 'gap', 'rt'], headways],
    turnbacks: [['station', 'line', 'inTripId', 'outTripId', 'arrS', 'depS', 'plannedTurnS', 'turnS', 'arrDelayS', 'depDelayS', 'carryS', 'platform'], turnbacks.map(x => [
      x.station, x.line, x.inT.id, x.outT.id, sec(x.a.arrS ?? x.a.pa), sec(x.o.depS ?? x.o.pd),
      x.o.pd != null && x.a.pa != null ? sec(x.o.pd - x.a.pa) : null,
      x.a.arrS != null && x.o.depS != null ? sec(x.o.depS - x.a.arrS) : null,
      x.a.arrDelay, x.o.depDelay, x.a.arrDelay != null && x.o.depDelay != null ? x.o.depDelay - x.a.arrDelay : null, x.a.platformFinal,
    ])],
    forecasts: [['obsS', 'src', 'tripId', 'station', 'kind', 'plannedS', 'predDelayS', 'horizonS', 'finalDelayS', 'errS'], forecastRows],
  }
  const later = {
    snapshots: [['t', 'tripId', 'line', 'dirTo', 'lat', 'lon', 'fromStation', 'toStation', 'frac', 'atStation', 'delayS', 'knownDelayS', 'leaderGapS', 'followerGapS', 'occupancy', 'stoppedS', 'observed'], snapshots],
    lineState: [['t', 'line', 'dirTo', 'active', 'observed', 'meanDelayS', 'maxDelayS', 'knownMeanDelayS', 'knownMaxDelayS', 'headwayCv', 'bunching', 'gaps', 'cancelledNext30', 'knownCancelledNext30', 'sevActive'], lineState],
    kpis: [['t', 'line', 'dirTo', 'coverage', 'arrivals', 'punct1', 'punct4', 'punct6', 'cancelledTrips', 'cancelledStops', 'ewtS', 'headwayCv', 'bunching', 'gaps', 'stalls', 'crowdGap', 'paxDelayS'], kpis],
    ...(withPositions ? { positions: [['tS', 'src', 'tripId', 'line', 'lat', 'lon'], positions] } : {}),
  }
  const tripRows = all.map(T => ({
    tripId: T.id, serviceDay: day, trainId: rootOf(T).id, line: T.line, lineKnown: T.lineKnown, lineVariant: T.lineVariant, product: T.product, operator: T.operator, fahrtNr: T.fahrtNr,
    direction: T.direction, dirTo: T.dirTo, originStation: T.events[0].station ?? T.events[0].stop, destStation: T.events.at(-1).station ?? T.events.at(-1).stop,
    plannedStartS: sec(T.plannedStart), startS: sec(T.start), plannedEndS: sec(T.plannedEnd), endS: sec(T.end), status: T.status, rt: T.events.some(e => e.rt),
    nStops: T.events.length, nCancelled: T.events.length - T.running.length, nDup: T.events.filter(e => e.dupOf).length, maxDelayS: T.maxDelay, endDelayS: T.endDelay,
    firstSeenS: sec(T.firstSeen), observed: T.observed, sources: Object.keys(T.t.seen).sort(), lost: lost.get(T.id) ?? null,
  }))
  const meta = {
    schema: 'sbahn-ubahn-ops/2', serviceDay: day, tz: 'Europe/Berlin', startS: sec(startMs), endS: sec(endMs), hours: (endMs - startMs) / H, dstChange: endMs - startMs !== 24 * H, networkSha,
    geometry: tracks3d.length ? 'tracks3d' : 'network',
    counts: {
      trips: tripRows.length, ...Object.fromEntries(Object.entries({ ...tables, ...later }).map(([k, [, rows]]) => [k, rows.length])),
      actions: actions.length, incidents: incidents.length, disruptions: disruptions.length, sev: sev.length,
    },
    gaps, coverage: { stepS: 60, radar: string(cover.radar), running: string(cover.running), board: string(cover.board), trip: string(cover.trip) }, rtShare, rtN,
    generatedAt: new Date().toISOString(),
  }
  const context = {
    calendar: { weekday: new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' }), publicHoliday: dateCheck(calendar?.public), schoolHoliday: dateCheck(calendar?.school), dstChange: meta.dstChange },
    weather: { columns: ['tS', 'point', ...weatherFields], rows: weather },
    forecast15: { columns: ['tS', 'point', 'validS', ...forecastFields], rows: forecast15 },
    alerts: [...alerts.values()],
    events: events.filter(x => {
      const a = x.startS ?? sec(at(x.start)), b = x.endS ?? sec(at(x.end)) ?? a
      return a == null || (a < sec(endMs) && b >= sec(startMs))
    }),
  }
  const networkOut = { lines: network.lines, stations: network.stations, segments, corridors, singleTrack, termini, turnStations, minHeadways }

  const file = path.join(outDir, `${day}.json${gzipOut ? '.gz' : ''}`)
  const sink = fs.createWriteStream(`${file}.tmp`)
  const out = gzipOut ? zlib.createGzip() : sink
  if (gzipOut) out.pipe(sink)
  let chunk = ''
  const put = async (s) => {
    chunk += s
    if (chunk.length < 1 << 20) return
    const ok = out.write(chunk)
    chunk = ''
    if (!ok) await once(out, 'drain')
  }
  const rowsOut = async (rows) => { for (let i = 0; i < rows.length; i++) await put((i ? ',\n' : '\n') + JSON.stringify(rows[i])) }
  await put(`{"meta":${JSON.stringify(meta)},\n"network":${JSON.stringify(networkOut)},\n"context":${JSON.stringify(context)},\n"trips":[`)
  await rowsOut(tripRows)
  await put(']')
  for (const [name, [columns, rows]] of Object.entries(tables)) {
    await put(`,\n${JSON.stringify(name)}:{"columns":${JSON.stringify(columns)},"rows":[`)
    await rowsOut(rows)
    await put(']}')
  }
  const sevRows = sev.map(s => ({ line: s.line, fromS: sec(s.from), toS: sec(s.to), maxVehicles: s.max, startObserved: s.startObserved, endObserved: s.endObserved }))
  for (const [name, rows] of [['disruptions', disruptions], ['sev', sevRows], ['actions', actions], ['incidents', incidents]]) {
    await put(`,\n${JSON.stringify(name)}:[`)
    await rowsOut(rows)
    await put(']')
  }
  for (const [name, [columns, rows]] of Object.entries(later)) {
    await put(`,\n${JSON.stringify(name)}:{"columns":${JSON.stringify(columns)},"rows":[`)
    await rowsOut(rows)
    await put(']}')
  }
  await put('}\n')
  out.end(chunk)
  await once(sink, 'finish')
  fs.renameSync(`${file}.tmp`, file)
  console.log(`${day}: ${tripRows.length} trips, ${stopEvents.length} stop events, ${forecastRows.length} forecasts, ${actions.length} actions, ${snapshots.length} snapshots -> ${file} (${(fs.statSync(file).size / 1e6).toFixed(1)} MB, ${((Date.now() - started) / 1000).toFixed(1)} s)`)
}
