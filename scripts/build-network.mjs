import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'

const API = 'https://v6.bvg.transport.rest'
const CACHE = new URL('.cache/', import.meta.url)
const OUTPUT = new URL('../public/data/', import.meta.url)
const PRODUCTS = 'subway=true&suburban=true&tram=false&bus=false&ferry=false&express=false&regional=false'
const TODAY = new Date(new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Berlin' }))
const TIMES = [[2, '11:00'], [2, '16:00'], [2, '20:00'], [6, '11:00']].map(([weekday, time]) => {
  const day = new Date(TODAY.getTime() + ((weekday - TODAY.getUTCDay() + 6) % 7 + 1) * 86400000)
  const offset = new Intl.DateTimeFormat('en', { timeZone: 'Europe/Berlin', timeZoneName: 'longOffset' }).formatToParts(day).find(part => part.type === 'timeZoneName').value.slice(3)
  return `${day.toISOString().slice(0, 10)}T${time}:00${offset}`
})

const SEEDS = [
  'S+U Alexanderplatz', 'S+U Friedrichstraße', 'S+U Zoologischer Garten', 'S+U Berlin Hauptbahnhof', 'S Ostkreuz',
  'S Südkreuz', 'S+U Gesundbrunnen', 'S Westkreuz', 'U Nollendorfplatz', 'U Wittenbergplatz', 'U Hermannplatz',
  'S+U Neukölln', 'S Schöneberg', 'S+U Westhafen', 'S Spandau', 'S Wannsee', 'S+U Lichtenberg', 'S Schöneweide',
  'S+U Pankow', 'U Mehringdamm', 'U Fehrbelliner Platz', 'S+U Innsbrucker Platz', 'S+U Bundesplatz',
  'S+U Frankfurter Allee', 'S Treptower Park', 'S+U Warschauer Straße', 'U Kottbusser Tor', 'U Leopoldplatz',
  'S+U Rathaus Steglitz', 'U Osloer Straße', 'S+U Wittenau', 'U Kurfürstendamm'
]

const COLORS = {
  S1: ['#DA6BA2'], S15: ['#DA6BA2'], S2: ['#007734'], S25: ['#007734'], S26: ['#007734'], S3: ['#0066AD'],
  S41: ['#AD5937'], S42: ['#CB6418'], S45: ['#CD9C53'], S46: ['#CD9C53'], S47: ['#CD9C53'], S5: ['#EB7405'],
  S7: ['#816DA6'], S75: ['#816DA6'], S8: ['#66AA22'], S85: ['#66AA22'], S9: ['#992746'],
  U1: ['#7DAD4C'], U12: ['#7DAD4C'], U2: ['#DA421E'], U3: ['#16683D'], U4: ['#F0D722', '#000000'], U5: ['#7E5330'],
  U6: ['#8C6DAB'], U7: ['#528DBA'], U8: ['#224F86'], U9: ['#F3791D']
}

let lastRequest = 0
const failed = []
const used = new Set()

const get = async path => {
  const name = `${path.split(/[/?]/)[1]}-${createHash('sha1').update(path).digest('hex').slice(0, 20)}.json`
  used.add(name)
  const cached = await readFile(new URL(name, CACHE), 'utf8').then(JSON.parse).catch(() => null)
  if (cached) return cached
  for (let attempt = 1; attempt <= 6; attempt++) {
    await new Promise(resolve => setTimeout(resolve, Math.max(0, lastRequest + 1200 - Date.now())))
    lastRequest = Date.now()
    try {
      const response = await fetch(API + path, { signal: AbortSignal.timeout(30000) })
      if (response.ok) {
        const text = await response.text()
        const data = JSON.parse(text)
        await writeFile(new URL(name, CACHE), text)
        return data
      }
      console.warn(`${response.status} ${path}`)
      if (response.status !== 429 && response.status < 500) break
    } catch (error) {
      console.warn(`${error.name} ${path}`)
    }
    await new Promise(resolve => setTimeout(resolve, 1000 * 2 ** attempt))
  }
  failed.push(path)
  return null
}

const clean = name => name
  .replace(/^(S\+U|S|U) /, '')
  .replace(/ \(Berlin\)$/, '')
  .replace(/ Bhf$/, '')
  .replace(/ \((b Berlin|bei Berlin|TF)\)$/, '')
  .replace(/^Berlin /, '')
  .replace(/str\.(?=[ )]|$)/g, 'straße')
  .replace(/Str\.(?=[ )]|$)/g, 'Straße')

await mkdir(CACHE, { recursive: true })
await mkdir(OUTPUT, { recursive: true })

const queue = []
for (const query of SEEDS) {
  const results = await get(`/locations?query=${encodeURIComponent(query)}&results=5&poi=false&addresses=false`)
  const stop = results?.find(result => result.products?.subway || result.products?.suburban)
  if (stop && !queue.includes(stop.id)) queue.push(stop.id)
}

const trips = []
const seen = new Set()
const runs = new Set()
for (let i = 0; i < queue.length; i++) {
  for (const [window, when] of TIMES.entries()) {
    const data = await get(`/stops/${queue[i]}/departures?when=${encodeURIComponent(when)}&duration=120&results=1000&${PRODUCTS}`)
    for (const departure of data?.departures ?? []) {
      const line = departure.line ?? {}
      if (!['subway', 'suburban'].includes(line.product) || !/^[SU]\d+$/.test(line.name) || departure.cancelled) continue
      runs.add(`${line.name} ${departure.stop.id} ${departure.destination?.id} ${window} ${departure.tripId}`)
      if (seen.has(departure.tripId)) continue
      seen.add(departure.tripId)
      if (trips.some(trip => trip.line === line.name && trip.ids.at(-1) === departure.destination?.id && trip.ids.includes(departure.stop.id))) continue
      const trip = (await get(`/trips/${encodeURIComponent(departure.tripId)}?stopovers=true&polyline=true`))?.trip
      if (!trip?.stopovers?.length) continue
      const ids = trip.stopovers.map(stopover => stopover.stop.id)
      trips.push({ line: line.name, product: line.product, ids, stopovers: trip.stopovers, features: trip.polyline?.features ?? [] })
      for (const id of [ids[0], ids.at(-1)]) if (!queue.includes(id)) queue.push(id)
    }
  }
  console.log(`${i + 1}/${queue.length} stops queried, ${trips.length} trips`)
}

const stops = new Map(trips.flatMap(trip => trip.stopovers.map(stopover => [stopover.stop.id, stopover.stop])))
const point = id => [stops.get(id).location.longitude, stops.get(id).location.latitude]
const meters = (p, q) => Math.hypot((p[0] - q[0]) * 67800, (p[1] - q[1]) * 111200)
const ranked = [...stops.values()].sort((a, b) => (b.products.suburban + b.products.subway) - (a.products.suburban + a.products.subway) || b.name.startsWith('S+U') - a.name.startsWith('S+U') || a.id.localeCompare(b.id))
const primary = new Map()
for (const stop of ranked) {
  const match = ranked.find(other => primary.get(other.id) === other.id && meters(point(other.id), point(stop.id)) < (clean(other.name) === clean(stop.name) ? 300 : [other, stop].some(entry => entry.name.startsWith('S+U')) ? 250 : 0))
  primary.set(stop.id, match?.id ?? stop.id)
}
for (const trip of trips) trip.stations = trip.ids.map(id => primary.get(id))
const members = id => [...primary].filter(([, target]) => target === id).map(([raw]) => raw)
const center = id => {
  const points = members(id).map(point)
  return [0, 1].map(axis => points.reduce((sum, p) => sum + p[axis], 0) / points.length)
}

const passes = new Map()
for (const run of runs) {
  const [line, stop, destination, window] = run.split(' ')
  const key = `${line} ${primary.get(stop)} ${primary.get(destination)} ${window}`
  passes.set(key, (passes.get(key) ?? 0) + 1)
}

const loops = new Map()
for (const trip of trips) {
  const end = trip.stations.findIndex((station, k) => trip.stations.indexOf(station) < k)
  if (end > 0) loops.set(trip.line, new Set(trip.stations.slice(trip.stations.indexOf(trip.stations[end]), end)))
}
const regular = trips.filter(trip => !loops.has(trip.line) || trip.stations.every(station => loops.get(trip.line).has(station)))

const lineIds = [...new Set(regular.map(trip => trip.line))].sort()
const lines = lineIds.map(id => {
  const lineTrips = regular.filter(trip => trip.line === id)
  const variants = [...new Map(lineTrips.map(trip => [trip.stations.join(), trip.stations])).values()].sort((a, b) => b.length - a.length)
  const starts = new Map()
  for (const variant of variants) {
    const through = variants.filter(other => starts.has(other) && other.at(-1) === variant.at(-1) && other.indexOf(variant[0]) > 0)
    starts.set(variant, TIMES.map((_, window) => Math.max(0, (passes.get(`${id} ${variant[0]} ${variant.at(-1)} ${window}`) ?? 0) - through.reduce((sum, other) => sum + starts.get(other)[window], 0))))
  }
  const total = variant => starts.get(variant).reduce((sum, count) => sum + count, 0)
  const core = variants.reduce((best, variant) => total(variant) > total(best) ? variant : best)
  const route = loops.has(id) ? [...loops.get(id)] : variants.find(variant => core.every(station => variant.includes(station)) && starts.get(variant).filter(Boolean).length > 1) ?? core
  const start = loops.has(id) ? Math.max(0, route.findIndex(station => clean(stops.get(station).name) === 'Gesundbrunnen')) : 0
  const kept = loops.has(id) ? variants : variants.filter(variant => starts.get(variant).filter(Boolean).length > 1 || variant.every(station => route.includes(station)))
  return { id, product: lineTrips[0].product, ring: loops.has(id), variants: kept, main: [...route.slice(start), ...route.slice(0, start)] }
})
const served = regular.filter(trip => lines.find(line => line.id === trip.line).variants.some(variant => variant.join() === trip.stations.join()))

const keyOf = (product, a, b) => a < b ? `${product}|${a}|${b}` : `${product}|${b}|${a}`
const pieces = new Map()
for (const trip of served) {
  const markers = trip.features.flatMap((feature, index) => feature.properties?.type === 'stop' ? [[feature.properties.id, index]] : [])
  const { main, ring } = lines.find(line => line.id === trip.line)
  for (let k = 1; k < trip.stations.length; k++) {
    const [a, b] = [trip.stations[k - 1], trip.stations[k]]
    const gap = main.includes(a) && main.includes(b) ? Math.abs(main.indexOf(a) - main.indexOf(b)) : 1
    if (a === b || (gap !== 1 && !(ring && gap === main.length - 1))) continue
    const m = markers.findIndex(([id], j) => id === trip.ids[k - 1] && markers[j + 1]?.[0] === trip.ids[k])
    const [start, end] = m < 0 ? [] : [markers[m][1], markers[m + 1][1]].map(index => trip.features[index].geometry.coordinates)
    const inner = m < 0 ? [] : trip.features.slice(markers[m][1] + 1, markers[m + 1][1]).map(feature => feature.geometry.coordinates)
      .filter(p => meters(p, start) >= meters(start, center(a)) && meters(p, end) >= meters(end, center(b)))
    const key = keyOf(trip.product, a, b)
    const piece = pieces.get(key) ?? { lines: new Set(), inner: [], matched: false }
    piece.lines.add(trip.line)
    if (m >= 0 && (!piece.matched || inner.length > piece.inner.length)) Object.assign(piece, { inner: a < b ? inner : inner.reverse(), matched: true })
    pieces.set(key, piece)
  }
}

const linePairs = new Map(lines.map(line => {
  const pairs = new Set()
  for (const variant of [line.main, ...line.variants]) {
    const backward = variant.filter((station, k) => pairs.has(`${station}>${variant[k - 1]}`)).length
    const forward = variant.filter((station, k) => pairs.has(`${variant[k - 1]}>${station}`)).length
    const oriented = backward > forward ? [...variant].reverse() : variant
    for (let k = 1; k < oriented.length; k++) if (!pairs.has(`${oriented[k]}>${oriented[k - 1]}`)) pairs.add(`${oriented[k - 1]}>${oriented[k]}`)
  }
  return [line.id, pairs]
}))

const flipped = {}
const runsForward = (key, a, b) => {
  const owner = lineIds.find(id => pieces.get(key).lines.has(id))
  return linePairs.get(owner).has(`${a}>${b}`) !== Boolean(flipped[owner])
}
const swaps = () => lines.reduce((sum, { id, product, main }) => sum + main.slice(2).reduce((count, station, k) => {
  const [before, after] = [keyOf(product, main[k], main[k + 1]), keyOf(product, main[k + 1], station)]
  if (runsForward(before, main[k], main[k + 1]) === runsForward(after, main[k + 1], station)) return count
  return count + [...pieces.get(before).lines].filter(other => other !== id && pieces.get(after).lines.has(other)).length
}, 0), 0)
for (let best = swaps(), improved = true; improved;) {
  improved = false
  for (const line of lines.filter(line => !line.ring)) {
    flipped[line.id] = !flipped[line.id]
    const count = swaps()
    if (count < best) {
      best = count
      improved = true
    } else {
      flipped[line.id] = !flipped[line.id]
    }
  }
}
for (const line of lines) if (flipped[line.id]) line.main.reverse()

const segments = [...pieces].map(([key, piece]) => {
  const [, a, b] = key.split('|')
  const segmentLines = lineIds.filter(id => piece.lines.has(id))
  const path = [center(a), ...piece.inner, center(b)]
  for (let i = 1; i < path.length - 1;) {
    const [[x0, y0], [x1, y1], [x2, y2]] = path.slice(i - 1, i + 2)
    const [ax, ay, bx, by] = [(x1 - x0) * 0.61, y1 - y0, (x2 - x1) * 0.61, y2 - y1]
    const turn = (ax * bx + ay * by) / Math.hypot(ax, ay) / Math.hypot(bx, by)
    const station = i === 1 ? path[0] : i === path.length - 2 ? path.at(-1) : null
    if (turn > -0.2 && !(station && turn < 0.5 && meters(path[i], station) < 100)) {
      i++
    } else {
      path.splice(i, 1)
      i = Math.max(1, i - 1)
    }
  }
  const coords = path
    .map(([lon, lat]) => [Math.round(lon * 1e5) / 1e5, Math.round(lat * 1e5) / 1e5])
    .filter((p, i, all) => i === 0 || p[0] !== all[i - 1][0] || p[1] !== all[i - 1][1])
  return runsForward(key, a, b)
    ? { from: a, to: b, lines: segmentLines, coords, matched: piece.matched }
    : { from: b, to: a, lines: segmentLines, coords: coords.reverse(), matched: piece.matched }
})

const stationLines = new Map()
for (const trip of served) for (const station of trip.stations) stationLines.set(station, (stationLines.get(station) ?? new Set()).add(trip.line))
const stations = [...stationLines].map(([id, served]) => {
  const ids = members(id)
  const names = [...new Set(ids.map(raw => stops.get(raw).name))].sort((a, b) => clean(a).length - clean(b).length)
  const [lon, lat] = center(id).map(value => Math.round(value * 1e5) / 1e5)
  const stationLineIds = lineIds.filter(line => served.has(line))
  return {
    id,
    ids,
    name: [...new Set(names.map(clean))].join(' / '),
    fullName: names.join(' / '),
    lon,
    lat,
    lines: stationLineIds,
    products: [...new Set(stationLineIds.map(line => lines.find(entry => entry.id === line).product))].sort()
  }
}).sort((a, b) => a.name.localeCompare(b.name, 'de'))

const network = {
  generatedAt: new Date().toISOString(),
  lines: lines.map(line => {
    const [color, textColor = '#FFFFFF'] = COLORS[line.id] ?? [line.product === 'subway' ? '#115D91' : '#008D4F']
    if (!COLORS[line.id]) console.warn(`No color for ${line.id}`)
    const name = station => {
      const trip = served.find(trip => trip.line === line.id && trip.stations.includes(station))
      return clean(stops.get(trip.ids[trip.stations.indexOf(station)]).name)
    }
    return {
      id: line.id,
      product: line.product,
      color,
      textColor,
      from: name(line.main[0]),
      to: name(line.ring ? line.main[0] : line.main.at(-1)),
      stations: line.main
    }
  }),
  stations,
  segments: segments.map(({ from, to, lines, coords }) => ({ from, to, lines, coords }))
}

for (const line of network.lines) {
  const lineSegments = segments.filter(segment => segment.lines.includes(line.id))
  const reached = new Set([line.stations[0]])
  for (let size = 0; size !== reached.size;) {
    size = reached.size
    for (const { from, to } of lineSegments) if (reached.has(from) || reached.has(to)) reached.add(from).add(to)
  }
  const gaps = new Set(lineSegments.flatMap(({ from, to }) => [from, to])).size - reached.size
  console.log(`${line.id.padEnd(4)} ${String(line.stations.length).padStart(3)} stations  ${line.from} -> ${line.to}${gaps ? `  ${gaps} stations disconnected` : ''}`)
}
console.log(`${stations.length} stations, ${segments.length} segments, ${segments.filter(segment => !segment.matched).length} straight fallbacks, ${trips.length - regular.length} off-ring and ${regular.length - served.length} occasional trips dropped, ${failed.length} failed requests`)
for (const path of failed) console.log(`failed: ${path}`)

const previous = await readFile(new URL('network.json', OUTPUT), 'utf8').then(JSON.parse).catch(() => null)
const missing = (previous?.lines ?? []).map(line => line.id).filter(id => !lineIds.includes(id))
if ((failed.length || missing.length) && !process.env.FORCE) {
  console.error(`network.json not written: ${failed.length} failed requests${missing.length ? `, lines missing compared to the current file: ${missing.join(' ')}` : ''}. Run with FORCE=1 to write it anyway.`)
  process.exit(1)
}

await writeFile(new URL('network.json', OUTPUT), JSON.stringify(network))
for (const name of await readdir(CACHE)) if (!used.has(name)) await rm(new URL(name, CACHE))
console.log(`network.json written for ${TIMES.join(', ')}`)
