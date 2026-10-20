import { Map as MapLibre, AttributionControl, GeolocateControl, LngLatBounds } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import '@fontsource-variable/ibm-plex-sans/wdth.css'
import './style.css'
import { createScene } from './scene.js'
import { createCamera } from './camera.js'

const API = 'https://v6.bvg.transport.rest'
const MODES = 'subway=true&suburban=true&tram=false&bus=false&ferry=false&express=false&regional=false&language=de'
const FALLBACK = { suburban: ['#008D4F', '#FFFFFF'], subway: ['#1B62A8', '#FFFFFF'] }
const AREA = [12.95, 52.2, 14.05, 52.85]
const MOBILE = matchMedia('(max-width: 699px)')
const TOUCH = matchMedia('(pointer: coarse)').matches
const DARK = matchMedia('(prefers-color-scheme: dark)')
const PITCH = MOBILE.matches ? 48 : 56
const BEARING = -18
const FLAT = [13.405, 52.515]
const TILTED = MOBILE.matches ? [13.395, 52.545] : [13.44, 52.55]
const EASE = t => t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2

const [networkRequest, tracksRequest, bordersRequest, zonesRequest] = ['network', 'tracks3d', 'boundaries', 'zones'].map(name => fetch(`${import.meta.env.BASE_URL}data/${name}.json`).then(response => response.json()).catch(() => null))

const [panel, head, chips, age, refresh, body, close, legend, legendToggle, trainNote, search, results, themeButton, tip, toast, modeGroup, sepInput, depthGroup, xrayInput, exagInput, exagValue, cameraControl] = [
  'panel', 'panel-head', 'chips', 'age', 'refresh', 'panel-body', 'close', 'legend', 'legend-toggle', 'train-note', 'search', 'results', 'theme', 'tip', 'toast', 'mode', 'sep', 'depth', 'xray', 'exag', 'exag-value', 'camera'
].map(id => document.getElementById(id))

const h = (tag, props = {}, ...children) => {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (key.startsWith('on')) node.addEventListener(key.slice(2), value)
    else if (value != null) node.setAttribute(key, value)
  }
  node.append(...children.flat().filter(child => child != null && child !== false))
  return node
}

const read = (key, store = 'localStorage') => {
  try { return window[store].getItem(key) } catch { return null }
}

const write = (key, value, store = 'localStorage') => {
  try { window[store].setItem(key, value) } catch {}
}

let calmUntil = 0

const api = async (path, signal) => {
  for (let attempt = 0; ; attempt++) {
    await new Promise(resolve => setTimeout(resolve, Math.max(0, calmUntil - Date.now())))
    signal.throwIfAborted()
    const response = await fetch(API + path, { signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) }).catch(error => {
      if (signal.aborted) throw error
    })
    if (response?.ok) return response.json()
    const status = response?.status ?? 0
    if (!status || status === 429 || status >= 500) calmUntil = Math.max(calmUntil, Date.now() + (status === 429 ? (Number(response.headers.get('retry-after')) || 30) * 1000 : 5000))
    if (attempt === 3 || (status && status !== 429 && status < 500)) throw Object.assign(new Error(status ? `HTTP ${status}` : 'Keine Verbindung'), { status })
    await new Promise(resolve => setTimeout(resolve, 1000 * 2 ** attempt + Math.random() * 500))
  }
}

let stored = read('theme')
const [savedSep, savedXray, savedExag] = ['sep', 'xray', 'exag'].map(key => Number.parseFloat(read(key)))
let sep = Number.isFinite(savedSep) ? Math.min(1, Math.max(0, savedSep)) : MOBILE.matches ? 0.4 : 0.5
const startMode = read('mode') === '2d' ? '2d' : '3d'
const startReal = read('depth') !== 'schema'
let intro = startMode === '3d' && !location.hash && !matchMedia('(prefers-reduced-motion: reduce)').matches && !read('intro', 'sessionStorage') ? Infinity : 0
const tilted = startMode === '3d' && !intro
const state = {
  theme: stored ?? (DARK.matches ? 'dark' : 'light'),
  mode: startMode,
  real: startReal,
  xray: Number.isFinite(savedXray) ? Math.min(1, Math.max(0, savedXray)) : 0.5,
  exag: Number.isFinite(savedExag) ? Math.min(3, Math.max(1, savedExag)) : 1,
  s: tilted && !startReal ? sep : 0,
  show: { city: true, subway: true, suburban: true, trains: true, borders: true, zones: false },
  view: null,
  trains: new Map(),
  route: null,
  tick: 0,
  fonts: false
}
document.documentElement.dataset.theme = state.theme
document.querySelector('meta[name="theme-color"]').content = state.theme === 'dark' ? '#0a0d13' : '#f2f1ec'
if (MOBILE.matches) search.placeholder = 'Bahnhof oder Linie'

const map = new MapLibre({
  container: 'map',
  style: 'https://tiles.openfreemap.org/styles/dark',
  center: tilted ? TILTED : FLAT,
  zoom: MOBILE.matches ? 10.2 : 11,
  pitch: tilted ? PITCH : 0,
  bearing: tilted ? BEARING : 0,
  minZoom: MOBILE.matches ? 8 : 8.5,
  maxZoom: 19,
  maxPitch: 85,
  maxBounds: [[11, 50.9], [15.4, 54.1]],
  centerClampedToGround: false,
  pixelRatio: Math.min(devicePixelRatio, 2),
  attributionControl: false,
  locale: {
    'AttributionControl.ToggleAttribution': 'Quellen anzeigen',
    'GeolocateControl.FindMyLocation': 'Mein Standort',
    'GeolocateControl.LocationNotAvailable': 'Standort nicht verfügbar',
    'Map.Title': 'Karte'
  }
})
map.addControl(new AttributionControl({ compact: true, customAttribution: 'Echtzeitdaten: <a href="https://v6.bvg.transport.rest" target="_blank" rel="noopener">BVG via transport.rest</a>' }), 'bottom-right')
map.addControl({ onAdd: () => cameraControl, onRemove: () => cameraControl.remove() }, 'bottom-right')
map.addControl(new GeolocateControl({ positionOptions: { enableHighAccuracy: true } }), 'bottom-right')
let styleLoaded = false
map.once('style.load', () => { styleLoaded = true })

const [network, tracksData, borders, zones] = await Promise.all([networkRequest, tracksRequest, bordersRequest, zonesRequest])
const { lines = [], stations = [], segments = [] } = network ?? {}
const tracks = tracksData ?? { segments: segments.map(segment => ({ ...segment, coords: segment.coords.map(([x, y]) => [x, y, 0]) })), platforms: {} }
const lineById = new Map(lines.map(line => [line.id, line]))
const stationById = new Map(stations.flatMap(station => [station.id, ...(station.ids ?? [])].map(id => [id, station])))
const hops = new Map(tracks.segments.flatMap(segment => [...segment.lines, ''].flatMap(id => [[`${segment.from} ${segment.to} ${id}`.trim(), segment.coords], [`${segment.to} ${segment.from} ${id}`.trim(), [...segment.coords].reverse()]])))
const chains = new Map(lines.map(line => {
  const ids = line.from === line.to ? [...line.stations, line.stations[0]] : line.stations
  const runs = []
  let run = null
  for (let i = 1; i < ids.length; i++) {
    const coords = hops.get(`${ids[i - 1]} ${ids[i]} ${line.id}`)
    if (!coords) {
      run = null
      continue
    }
    if (!run) runs.push(run = { points: [coords[0]], at: [0] })
    for (const point of coords.slice(1)) {
      const last = run.points.at(-1)
      run.at.push(run.at.at(-1) + Math.hypot((point[0] - last[0]) * 67770, (point[1] - last[1]) * 111320))
      run.points.push(point)
    }
  }
  return [line.id, runs]
}))
const snap = (id, [lon, lat]) => {
  let best = { gap: 400, run: null, at: 0, angle: 0, pos: [lon, lat, 0] }
  for (const run of chains.get(id) ?? []) {
    for (let i = 1; i < run.points.length; i++) {
      const [[ax, ay, az], [bx, by, bz]] = [run.points[i - 1], run.points[i]]
      const [dx, dy, px, py] = [(bx - ax) * 67770, (by - ay) * 111320, (lon - ax) * 67770, (lat - ay) * 111320]
      const t = Math.min(1, Math.max(0, (px * dx + py * dy) / (dx * dx + dy * dy || 1)))
      const gap = Math.hypot(px - t * dx, py - t * dy)
      if (gap < best.gap) best = { gap, run, at: run.at[i - 1] + t * (run.at[i] - run.at[i - 1]), angle: Math.atan2(dy, dx) * 180 / Math.PI, pos: [ax + (bx - ax) * t, ay + (by - ay) * t, az + (bz - az) * t] }
    }
  }
  return best
}
const platformOf = (station, line) => tracks.platforms[station?.id]?.[line]
  ?? Object.entries(tracks.platforms[station?.id] ?? {}).find(([id]) => lineById.get(id)?.product === lineById.get(line)?.product)?.[1]
  ?? (station ? [station.lon, station.lat, 0] : null)
const timeFormat = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' })
const scene = createScene(map, { lines, stations, tracks, lineById, stationById, borders, zones }, state)
map.on('style.load', () => {
  scene.paint()
  redraw()
})
if (styleLoaded) scene.paint()
const camera = createCamera(map, state, {
  home: () => state.mode === '3d' ? { center: TILTED, zoom: MOBILE.matches ? 10.2 : 11, pitch: PITCH, bearing: BEARING } : { center: FLAT, zoom: MOBILE.matches ? 10.2 : 11, pitch: 0, bearing: 0 },
  top: () => ({ pitch: 0, bearing: 0 }),
  tilt: () => ({ pitch: 62, bearing: Math.abs(map.getBearing()) < 1 ? BEARING : map.getBearing() }),
  under: () => {
    finishIntro()
    if (!state.real) setDepth(true)
    const center = map.getCenter()
    const deep = Object.entries(tracks.platforms).flatMap(([id, byLine]) => Object.entries(byLine).filter(([line, [, , z]]) => z < -4.5 && lineById.has(line)).map(([line, [lon, lat]]) => ({ id, line, lon, lat })))
    const pool = [deep.filter(spot => spot.id === view?.station?.id), deep.filter(spot => spot.line === (view?.kind === 'line' ? view.id : view?.trip?.line?.name)), deep].find(spots => spots.length)
    const score = spot => Math.hypot((spot.lon - center.lng) * 0.61, spot.lat - center.lat) / deep.filter(other => other.id === spot.id).length
    const target = pool?.reduce((best, spot) => score(spot) < score(best) ? spot : best)
    const padding = pad()
    return {
      ...(target && { center: [target.lon, target.lat] }),
      ...(view && { offset: [(padding.left - padding.right) / 2, (padding.top - padding.bottom) / 2] }),
      pitch: 104,
      zoom: Math.max(map.getZoom(), 16.4),
      bearing: Math.abs(map.getBearing()) < 1 ? BEARING : map.getBearing()
    }
  }
})

let view = null
let controller = null
let pollTimer = 0
let loadedAt = 0
let countdowns = []
let trains = new Map()
let radarController = null
let radarTimer = 0
let radarAt = 0
let radarBox = null
let moveTimer = 0
let hits = []
let active = 0
let raf = 0
let dirty = true
let tween = null
let moving = false
let trainStart = 0
let lastFrame = 0
let zoomStep = 0
let movedAt = 0
let hoverAt = null

const request = () => {
  raf ||= requestAnimationFrame(frame)
}

const redraw = () => {
  dirty = true
  request()
}

const frame = now => {
  raf = 0
  if (document.hidden) return
  if (tween) {
    const t = Math.min(1, (now - tween.start) / tween.duration)
    state.s = tween.from + (tween.to - tween.from) * EASE(t)
    if (t === 1) tween = null
    dirty = true
  }
  if (moving) {
    const progress = Math.min(1, (now - trainStart) / 1600)
    const eased = 1 - (1 - progress) ** 3
    for (const train of trains.values()) {
      const { from, to } = train
      if (from.run && from.run === to.run && Math.abs(to.at - from.at) < 3000) {
        const at = from.at + (to.at - from.at) * eased
        const { points, at: marks } = from.run
        let [low, high] = [1, marks.length - 1]
        while (low < high) {
          const mid = (low + high) >> 1
          if (marks[mid] < at) low = mid + 1
          else high = mid
        }
        const t = (at - marks[low - 1]) / (marks[low] - marks[low - 1] || 1)
        train.pos = points[low - 1].map((start, i) => start + (points[low][i] - start) * t)
        train.angle = Math.atan2((points[low][1] - points[low - 1][1]) * 111320, (points[low][0] - points[low - 1][0]) * 67770) * 180 / Math.PI + (train.way < 0 ? 180 : 0)
      } else {
        train.pos = from.pos.map((start, i) => start + (to.pos[i] - start) * eased)
      }
    }
    moving = progress < 1
    state.tick++
    dirty = true
  }
  const trip = view?.kind === 'trip' && state.route
  if (dirty || (trip && (!MOBILE.matches || now - lastFrame > 30))) {
    scene.render(now)
    dirty = false
    lastFrame = now
  }
  if (tween || moving || trip) request()
}

const clean = name => name
  .replace(/^(S\+U|S|U)\s+/, '')
  .replace(/\s*\((Berlin|Bln)\)$/, '')
  .replace(/\s+Bhf\.?$/, '')
  .replace(/\s*\((b Berlin|bei Berlin|TF)\)$/, '')
  .replace(/^Berlin\s+/, '')
  .replace(/([sS])tr\./g, '$1traße')

const notes = remarks => [...new Set((remarks ?? [])
  .filter(remark => remark.type === 'warning' || (remark.type === 'status' && !remark.code?.includes('cancelled')))
  .map(remark => new DOMParser().parseFromString(remark.text || remark.summary || '', 'text/html').body.textContent.trim())
  .filter(Boolean))]

const stationName = stop => stationById.get(stop?.id)?.name ?? clean(stop?.name ?? '')

const clock = time => timeFormat.format(new Date(time))

const countdown = time => {
  const minutes = Math.floor((Date.parse(time) - Date.now()) / 60000)
  if (minutes <= 0) return 'jetzt'
  return minutes < 60 ? `in ${minutes} min` : `in ${Math.floor(minutes / 60)} h ${minutes % 60} min`
}

const timing = (time, delay) => {
  const minutes = delay == null ? null : Math.round(delay / 60)
  const tone = minutes == null ? '' : minutes >= 5 ? 'late very' : minutes > 0 ? 'late' : 'ontime'
  return h('span', { class: `timing ${tone}` },
    h('time', { datetime: time }, clock(time)),
    minutes != null && minutes !== 0 && h('em', {}, minutes > 0 ? `+${minutes}` : `−${-minutes}`)
  )
}

const badge = id => {
  const line = lineById.get(id)
  const product = line?.product ?? (id.startsWith('U') ? 'subway' : 'suburban')
  const [color, text] = line ? [line.color, line.textColor] : FALLBACK[product]
  return h('span', { class: `badge ${product}`, style: `--c:${color};--t:${text}` }, id)
}

const fare = station => {
  const zone = zones?.stations?.[station.id]
  return zone && h('span', { class: `zone z${zone.toLowerCase()}`, title: `Tarifzone ${zone}`, 'aria-label': `Tarifzone ${zone}` }, zone)
}

const strip = colors => panel.style.setProperty('--strip', colors.length
  ? `linear-gradient(90deg, ${colors.map((color, i) => `${color} ${i * 100 / colors.length}% ${(i + 1) * 100 / colors.length}%`).join(', ')})`
  : 'none')

const skeleton = () => h('div', { class: 'skeleton-list', 'aria-label': 'Lädt' }, Array.from({ length: 6 }, () => h('div', { class: 'skeleton' })))

const failure = text => h('div', { class: 'state' }, h('p', {}, text), h('button', { class: 'retry', type: 'button', onclick: () => load() }, 'Erneut versuchen'))

const pad = () => MOBILE.matches
  ? { top: 90, bottom: Math.round(innerHeight * 0.52) + 48, left: 40, right: 40 }
  : { top: 100, bottom: 60, left: 450, right: legend.classList.contains('open') ? 380 : 150 }

const spread = () => state.mode === '3d' && !state.real ? sep : 0

const ahead = ([lon, lat, height = 0], product, zoom) => {
  const lift = spread() >= 0.03 ? (product === 'suburban' ? 2 : 1) * sep * Math.max(180 * 47652 / 2 ** zoom, 120) : state.mode === '3d' ? height * state.exag : 0
  const reach = lift * Math.tan(Math.min(map.getPitch(), 80) * Math.PI / 180)
  const bearing = map.getBearing() * Math.PI / 180
  return [lon + reach * Math.sin(bearing) / (111320 * Math.cos(lat * Math.PI / 180)), lat + reach * Math.cos(bearing) / 111320]
}

const fit = (coords, product) => {
  if (!coords.length) return
  const pitch = Math.min(map.getPitch(), 80)
  const camera = map.cameraForBounds(coords.reduce((bounds, [lon, lat]) => bounds.extend([lon, lat]), new LngLatBounds(coords[0].slice(0, 2), coords[0].slice(0, 2))), { padding: pad(), bearing: map.getBearing(), pitch, maxZoom: 14.5 })
  if (!camera) return
  const distance = 1.5 * map.getContainer().clientHeight
  const rise = spread() >= 0.03 ? (product === 'suburban' ? 2 : 1) * sep * 180 / Math.cos(pitch * Math.PI / 180) : 0
  const zoom = camera.zoom - Math.log2(distance / Math.max(distance - rise, distance / 4))
  const height = state.real ? coords.reduce((sum, coord) => sum + (coord[2] ?? 0), 0) / coords.length : 0
  map.easeTo({ center: ahead([...camera.center.toArray(), height], product, zoom), zoom, bearing: camera.bearing, pitch, duration: 900 })
}

const trainCount = () => {
  const count = [...trains.values()].filter(train => state.show[train.product]).length
  return `${count} ${count === 1 ? 'Zug' : 'Züge'} im Ausschnitt unterwegs`
}

const finishIntro = () => {
  if (performance.now() > intro) return
  intro = 0
  write('intro', '1', 'sessionStorage')
  map.stop()
  map.jumpTo({ pitch: PITCH, bearing: BEARING })
  tween = null
  state.s = spread()
  redraw()
}

const loadTrains = async () => {
  clearTimeout(radarTimer)
  clearTimeout(moveTimer)
  radarController?.abort()
  radarBox = null
  if (document.hidden) return
  const bounds = map.getBounds()
  const [dx, dy] = [(bounds.getEast() - bounds.getWest()) * 0.15, (bounds.getNorth() - bounds.getSouth()) * 0.15]
  const box = [Math.max(bounds.getWest() - dx, AREA[0]), Math.max(bounds.getSouth() - dy, AREA[1]), Math.min(bounds.getEast() + dx, AREA[2]), Math.min(bounds.getNorth() + dy, AREA[3])].map((value, i) => Number.isFinite(value) ? value : AREA[i])
  if (!state.show.trains || box[0] >= box[2] || box[1] >= box[3]) {
    trains = state.trains = new Map()
    trainNote.textContent = state.show.trains ? trainCount() : ''
    redraw()
    return
  }
  radarController = new AbortController()
  radarAt = Date.now()
  radarBox = box
  const { signal } = radarController
  try {
    const { movements = [] } = await api(`/radar?west=${box[0].toFixed(4)}&south=${box[1].toFixed(4)}&east=${box[2].toFixed(4)}&north=${box[3].toFixed(4)}&results=3000&duration=30&frames=1&polylines=false&${MODES}`, signal)
    trains = state.trains = new Map(movements.filter(movement => movement.location && ['subway', 'suburban'].includes(movement.line?.product) && lineById.has(movement.line.name)).map(movement => {
      const line = lineById.get(movement.line.name)
      const to = snap(line.id, [movement.location.longitude, movement.location.latitude])
      const before = trains.get(movement.tripId)
      const from = before ? snap(line.id, before.pos) : to
      let way = 0
      for (const stopover of movement.nextStopovers ?? []) {
        const station = stationById.get(stopover.stop?.id)
        if (!to.run || !station || Date.parse(stopover.departure ?? stopover.arrival ?? stopover.plannedDeparture ?? stopover.plannedArrival) < Date.now()) continue
        const spot = snap(line.id, platformOf(station, line.id))
        const gap = spot.at - to.at
        if (spot.run !== to.run || Math.abs(gap) < 50) continue
        way = Math.sign(line.from === line.to && Math.abs(gap) > to.run.at.at(-1) / 2 ? -gap : gap)
        break
      }
      way ||= (from.run === to.run && Math.abs(to.at - from.at) > 20 ? Math.sign(to.at - from.at) : before?.way) ?? 0
      return [movement.tripId, { id: movement.tripId, line: line.id, product: line.product, direction: clean(movement.direction ?? ''), next: movement.nextStopovers ?? [], from, to, pos: from.pos, way, angle: to.angle + (way < 0 ? 180 : 0) }]
    }))
    trainNote.textContent = trainCount()
    moving = [...trains.values()].some(train => train.from.pos.some((value, i) => value !== train.to.pos[i]))
    trainStart = performance.now()
    redraw()
  } catch {
    if (signal.aborted) return
    radarBox = null
    trainNote.textContent = 'Live-Positionen gerade nicht verfügbar'
  }
  radarTimer = setTimeout(loadTrains, 20000)
}

const toggleLegend = open => {
  legendToggle.setAttribute('aria-expanded', legend.classList.toggle('open', open))
  redraw()
}

const keepFocus = render => {
  const key = panel.contains(document.activeElement) ? document.activeElement.dataset.key : null
  render()
  if (key) panel.querySelector(`[data-key="${CSS.escape(key)}"]`)?.focus({ preventScroll: true })
}

const setView = next => {
  controller?.abort()
  clearTimeout(pollTimer)
  if (next) finishIntro()
  if (next && MOBILE.matches) toggleLegend(false)
  view = state.view = next
  state.route = null
  countdowns = []
  loadedAt = 0
  panel.classList.remove('busy', 'stale', 'expanded')
  panel.classList.toggle('open', Boolean(next))
  panel.dataset.kind = next?.kind ?? ''
  strip([])
  body.scrollTop = 0
  chips.replaceChildren()
  age.textContent = ''
  for (const button of legend.querySelectorAll('[data-line]')) button.setAttribute('aria-pressed', next?.kind === 'line' && next.id === button.dataset.line)
  redraw()
}

const tick = () => {
  if (!view || view.kind === 'line') return
  const seconds = Math.round((Date.now() - loadedAt) / 1000)
  panel.classList.toggle('stale', Boolean(view.error))
  if (view.error) age.textContent = loadedAt ? 'Aktualisierung fehlgeschlagen' : 'BVG-Daten gerade nicht erreichbar'
  else if (!loadedAt) age.textContent = 'Lade Echtzeitdaten …'
  else if (seconds < 5) age.textContent = 'gerade aktualisiert'
  else age.textContent = seconds < 60 ? `aktualisiert vor ${seconds} s` : `aktualisiert vor ${Math.floor(seconds / 60)} min`
}

const renderStation = () => {
  const { station, departures, error, filter, open } = view
  const ids = [...new Set([...station.lines, ...(departures ?? []).map(departure => departure.line.name)])].sort()
  chips.replaceChildren(...(ids.length > 1 ? ['', ...ids] : []).map(id => h('button', {
    class: 'chip',
    type: 'button',
    'data-key': `chip ${id}`,
    'aria-pressed': (filter ?? '') === id,
    'aria-label': id ? `Nur ${id}` : 'Alle Linien',
    onclick: () => {
      view.filter = id || null
      keepFocus(renderStation)
    }
  }, id ? badge(id) : 'Alle')))
  countdowns = []
  if (!departures) {
    body.replaceChildren(error ? failure('Die Abfahrten konnten nicht geladen werden.') : skeleton())
    return
  }
  const focus = filter ?? (ids.length === 1 ? ids[0] : null)
  const link = lineById.has(focus) && h('button', { class: 'line-link', type: 'button', 'data-key': 'line', onclick: () => go(`#l=${focus}`) }, badge(focus), 'Linienverlauf anzeigen')
  const rows = departures.filter(departure => !filter || departure.line.name === filter).map(departure => [departure, notes(departure.remarks)])
  if (!rows.length) {
    body.replaceChildren(...[link, h('p', { class: 'empty' }, filter ? `Die ${filter} fährt hier in den nächsten 60 Minuten nicht ab.` : 'In den nächsten 60 Minuten fährt hier keine S- oder U-Bahn ab.')].filter(Boolean))
    return
  }
  const tally = new Map()
  for (const [departure, texts] of rows) for (const text of texts) tally.set(text, [...(tally.get(text) ?? []), departure.line.name])
  body.replaceChildren(...[
    link,
    ...[...tally].filter(([, names]) => names.length > 2).map(([text, names]) => h('button', {
      class: `notice${open.has(text) ? '' : ' clamp'}`,
      type: 'button',
      'data-key': `notice ${text}`,
      'aria-expanded': open.has(text),
      onclick: event => {
        if (open.has(text)) open.delete(text)
        else open.add(text)
        event.currentTarget.classList.toggle('clamp', !open.has(text))
        event.currentTarget.setAttribute('aria-expanded', open.has(text))
      }
    }, h('span', { class: 'notice-lines' }, ids.filter(id => names.includes(id)).map(id => badge(id))), h('span', { class: 'notice-text' }, text))),
    h('ol', { class: 'departures' }, rows.map(([departure, texts]) => {
      const time = departure.when ?? departure.plannedWhen
      const platform = departure.platform ?? departure.plannedPlatform
      const warnings = texts.filter(text => tally.get(text).length <= 2)
      const count = h('span', { class: 'count' }, departure.cancelled ? 'fällt aus' : countdown(time))
      if (!departure.cancelled) countdowns.push([count, time])
      return h('li', {}, h('button', {
        class: `dep${departure.cancelled ? ' cancelled' : ''}`,
        type: 'button',
        'data-key': departure.tripId,
        onclick: () => go(`#t=${encodeURIComponent(departure.tripId)}`)
      },
        badge(departure.line.name),
        h('span', { class: 'dir' },
          h('strong', {}, clean(departure.direction ?? departure.line.name)),
          platform && h('small', { class: departure.platform && departure.plannedPlatform && departure.platform !== departure.plannedPlatform ? 'changed' : null }, `Gl. ${platform.replace(/\s*\(.*\)$/, '')}`),
          warnings.length > 0 && h('small', { class: 'warn', title: warnings.join('\n') }, warnings.join(' – '))
        ),
        h('span', { class: 'when' }, count, time && timing(time, departure.cancelled ? null : departure.delay))
      ))
    }))
  ].filter(Boolean))
}

const renderTrip = () => {
  const { trip, error, gone, from } = view
  const back = from && h('button', {
    class: 'back',
    type: 'button',
    'data-key': 'back',
    onclick: () => history.state?.back === `#s=${from.id}` ? history.back() : go(`#s=${from.id}`)
  }, from.name)
  if (!trip) {
    head.replaceChildren(...[back, error ? h('h2', { class: 'title' }, gone ? 'Fahrt nicht mehr verfügbar' : 'Fahrt') : h('div', { class: 'skeleton title-skeleton' })].filter(Boolean))
    body.replaceChildren(gone
      ? h('p', { class: 'empty' }, 'Links zu einzelnen Fahrten gelten nur für kurze Zeit. Wähle einen Bahnhof oder einen Zug auf der Karte.')
      : error ? failure('Diese Fahrt konnte nicht geladen werden.') : skeleton())
    return
  }
  const line = lineById.get(trip.line?.name)
  const product = line?.product ?? (trip.line?.product === 'subway' ? 'subway' : 'suburban')
  const color = line?.color ?? FALLBACK[product][0]
  const stops = trip.stopovers ?? []
  const now = Date.now()
  const next = stops.findIndex(stop => Date.parse(stop.departure ?? stop.arrival ?? stop.plannedDeparture ?? stop.plannedArrival) > now)
  strip([color])
  head.replaceChildren(...[
    back,
    h('div', { class: 'heading' }, badge(trip.line?.name ?? ''), h('h2', { class: 'title' }, clean(trip.direction ?? ''))),
    h('p', { class: 'sub' }, trip.cancelled ? 'Diese Fahrt fällt aus.' : `von ${stationName(trip.origin)}`)
  ].filter(Boolean))
  body.replaceChildren(
    ...notes(trip.remarks).map(text => h('p', { class: 'notice' }, text)),
    h('ol', { class: 'stops', style: `--c:${color}` }, stops.map((stop, index) => {
      const station = stationById.get(stop.stop.id)
      const time = stop.departure ?? stop.arrival ?? stop.plannedDeparture ?? stop.plannedArrival
      return h('li', { class: next < 0 || index < next ? 'past' : index === next ? 'next' : null },
        h('button', { class: stop.cancelled ? 'cancelled' : null, type: 'button', 'data-key': `stop ${index}`, disabled: station ? null : '', onclick: () => go(`#s=${station.id}`) },
          time ? timing(time, stop.cancelled ? null : stop.departure ? stop.departureDelay : stop.arrivalDelay) : h('span'),
          h('span', { class: `node${station?.lines.length > 1 ? ' big' : ''}` }),
          h('span', { class: 'name' }, h('span', {}, station?.name ?? clean(stop.stop.name)), stop.cancelled && h('small', {}, 'Halt entfällt'))
        )
      )
    }))
  )
  const anchors = stops.flatMap(stop => {
    const station = stationById.get(stop.stop.id)
    const point = platformOf(station, line?.id) ?? (stop.stop.location && [stop.stop.location.longitude, stop.stop.location.latitude, 0])
    return point ? [{ id: station?.id, point }] : []
  })
  const polyline = trip.polyline?.features?.map(feature => feature.geometry.coordinates) ?? []
  let cursor = 0
  const closest = ([lon, lat]) => polyline.reduce((best, [x, y], i) => i > cursor && Math.hypot((x - lon) * 0.61, y - lat) < Math.hypot((polyline[best][0] - lon) * 0.61, polyline[best][1] - lat) ? i : best, cursor)
  const coords = anchors.length > 1 ? anchors.slice(1).flatMap(({ id, point }, index) => {
    const from = anchors[index]
    const hop = hops.get(`${from.id} ${id} ${line?.id}`) ?? hops.get(`${from.id} ${id}`)
    const [start, end] = hop || !polyline.length ? [0, 0] : [closest(from.point), closest(point)]
    cursor = Math.max(cursor, end)
    const leg = hop ?? [from.point, ...polyline.slice(start + 1, end).map(([x, y], i, inner) => [x, y, from.point[2] + (point[2] - from.point[2]) * (i + 1) / (inner.length + 1)]), point]
    return index ? leg.slice(1) : leg
  }) : polyline
  state.route = { kind: 'trip', color, product, paths: [coords], stops: anchors.map(anchor => anchor.point), now: trip.currentLocation ? snap(line?.id, [trip.currentLocation.longitude, trip.currentLocation.latitude]).pos : null }
  redraw()
  if (!view.fitted) {
    fit(coords, product)
    body.querySelector('li.next')?.scrollIntoView({ block: 'center' })
  }
  view.fitted = true
}

const load = async () => {
  const current = view
  if (!current || current.kind === 'line') return
  controller?.abort()
  clearTimeout(pollTimer)
  controller = new AbortController()
  const { signal } = controller
  panel.classList.add('busy')
  tick()
  try {
    if (current.kind === 'station') {
      const responses = await Promise.all(current.station.ids.map(id => api(`/stops/${encodeURIComponent(id)}/departures?duration=60&results=250&${MODES}`, signal)))
      current.departures = [...new Map(responses.flatMap(response => response.departures ?? []).map(departure => [departure.tripId, departure])).values()]
        .sort((a, b) => Date.parse(a.when ?? a.plannedWhen) - Date.parse(b.when ?? b.plannedWhen))
    } else {
      current.trip = (await api(`/trips/${encodeURIComponent(current.id)}?stopovers=true&polyline=true&language=de`, signal)).trip
    }
    current.error = null
    current.gone = false
    loadedAt = Date.now()
  } catch (error) {
    if (signal.aborted) return
    current.error = error
    current.gone = current.kind === 'trip' && !current.trip && error.status >= 400 && error.status < 500 && error.status !== 429
  }
  panel.classList.remove('busy')
  panel.dataset.kind = current.gone ? 'gone' : current.kind
  keepFocus(current.kind === 'station' ? renderStation : renderTrip)
  tick()
  if (!document.hidden && !current.gone) pollTimer = setTimeout(load, 30000)
}

const route = () => {
  if ((view?.hash ?? '') === location.hash) return
  const [key, id] = [...new URLSearchParams(location.hash.slice(1))][0] ?? []
  const station = key === 's' && stationById.get(id)
  const line = key === 'l' && lineById.get(id)
  if (station) {
    setView({ kind: 'station', id: station.id, hash: location.hash, station: { ...station, ids: station.ids ?? [station.id] }, departures: null, error: null, filter: null, open: new Set() })
    strip(station.lines.map(other => lineById.get(other)?.color).filter(Boolean))
    const zone = fare(station)
    head.replaceChildren(
      h('h2', { class: 'title' }, station.name),
      h('p', { class: 'sub' },
        h('span', {}, station.products.length > 1 ? 'S- und U-Bahnhof' : station.products[0] === 'subway' ? 'U-Bahnhof' : station.products[0] === 'suburban' ? 'S-Bahnhof' : 'Bahnhof'),
        zone && h('span', { class: 'fare' }, 'Tarifzone', zone)
      )
    )
    renderStation()
    const padding = pad()
    const zoom = Math.max(map.getZoom(), state.mode === '3d' && state.real ? 15 : 14)
    const heights = Object.values(tracks.platforms[station.id] ?? {}).map(position => position[2])
    const height = heights.length ? heights.reduce((sum, value) => sum + value, 0) / heights.length : 0
    map.flyTo({ center: ahead([station.lon, station.lat, height], station.products.includes('suburban') && state.show.suburban ? 'suburban' : 'subway', zoom), zoom, offset: [(padding.left - padding.right) / 2, (padding.top - padding.bottom) / 2], duration: 900 })
    load()
  } else if (line) {
    setView({ kind: 'line', id: line.id, hash: location.hash })
    strip([line.color])
    const ring = line.from === line.to
    const members = line.stations.map(other => stationById.get(other)).filter(Boolean)
    head.replaceChildren(
      h('div', { class: 'heading' }, badge(line.id), h('h2', { class: 'title' }, ring ? 'Ringbahn' : `${line.from} – ${line.to}`)),
      h('p', { class: 'sub' }, `${line.product === 'subway' ? 'U-Bahn' : 'S-Bahn'} mit ${members.length} Bahnhöfen${ring ? `, Start ${line.from}` : ''}`)
    )
    body.replaceChildren(h('ol', { class: 'stops line-stops', style: `--c:${line.color}` }, members.map(member => h('li', {},
      h('button', { type: 'button', onclick: () => go(`#s=${member.id}`) },
        h('span', { class: `node${member.lines.length > 1 ? ' big' : ''}` }),
        h('span', { class: 'name' }, member.name),
        h('span', { class: 'transfers' }, member.lines.filter(other => other !== line.id).map(other => badge(other)))
      )
    ))))
    state.route = {
      kind: 'line',
      color: line.color,
      product: line.product,
      paths: tracks.segments.filter(segment => segment.lines.includes(line.id)).map(segment => segment.coords),
      stops: members.map(member => platformOf(member, line.id)),
      now: null
    }
    redraw()
    fit(state.route.stops, line.product)
  } else if (key === 't' && id) {
    setView({ kind: 'trip', id, hash: location.hash, from: view?.kind === 'station' ? view.station : view?.from ?? null, trip: null, error: null, gone: false })
    renderTrip()
    load()
  } else {
    setView(null)
  }
}

const go = hash => {
  if (hash !== location.hash) history.pushState({ back: location.hash }, '', hash || location.pathname + location.search)
  route()
}

if (!TOUCH) map.on('mousemove', event => {
  if (!hoverAt) requestAnimationFrame(() => {
    const point = hoverAt
    hoverAt = null
    if (!point) return
    const features = scene.pick(point)
    const top = features[0]
    map.getCanvas().style.cursor = top ? 'pointer' : ''
    tip.hidden = !top
    if (!top) return
    const props = top.properties
    let content = []
    if (top.layer.id === 'trains') {
      const train = trains.get(props.id)
      const next = train?.next.find(stop => Date.parse(stop.arrival ?? stop.departure ?? stop.plannedArrival ?? 0) > Date.now())
      content = [
        h('div', { class: 'tip-row' }, badge(props.line), h('strong', {}, train?.direction ?? '')),
        next && h('small', {}, `Nächster Halt ${stationName(next.stop)}, ${clock(next.arrival ?? next.departure ?? next.plannedArrival)}`)
      ]
    } else if (top.layer.id === 'stations') {
      const station = stationById.get(props.id)
      content = [h('strong', {}, station.name), h('div', { class: 'tip-row' }, station.lines.map(id => badge(id)))]
    } else {
      const ids = [...new Set(features.filter(feature => feature.layer.id === 'network').map(feature => feature.properties.line))].sort()
      const line = lineById.get(ids[0])
      content = [h('div', { class: 'tip-row' }, ids.map(id => badge(id))), ids.length === 1 && line && h('small', {}, line.from === line.to ? 'Ringbahn' : `${line.from} – ${line.to}`)]
    }
    tip.replaceChildren(...content.filter(Boolean))
    const flip = point.x > innerWidth - 300
    tip.style.transform = `translate(${point.x + (flip ? -16 : 16)}px, ${point.y + 16}px)${flip ? ' translateX(-100%)' : ''}`
  })
  hoverAt = event.point
})

map.on('mouseout', () => {
  hoverAt = null
  tip.hidden = true
})

map.on('movestart', () => { tip.hidden = true })

map.on('click', event => {
  if (MOBILE.matches) toggleLegend(false)
  const top = scene.pick(event.point)[0]
  if (!top) return
  tip.hidden = true
  if (top.layer.id === 'trains') go(`#t=${encodeURIComponent(top.properties.id)}`)
  else if (top.layer.id === 'stations') go(`#s=${top.properties.id}`)
  else go(`#l=${top.properties.line}`)
})

map.on('move', () => {
  const step = Math.round(map.getZoom() * 20)
  if (step === zoomStep && performance.now() - movedAt < 120) return
  zoomStep = step
  movedAt = performance.now()
  redraw()
})

map.on('moveend', () => {
  redraw()
  const bounds = map.getBounds()
  if (radarBox && Math.max(bounds.getWest(), AREA[0]) >= radarBox[0] && Math.max(bounds.getSouth(), AREA[1]) >= radarBox[1] && Math.min(bounds.getEast(), AREA[2]) <= radarBox[2] && Math.min(bounds.getNorth(), AREA[3]) <= radarBox[3]) return
  clearTimeout(moveTimer)
  moveTimer = setTimeout(loadTrains, Math.max(500, radarAt + 6000 - Date.now()))
})

for (const group of legend.querySelectorAll('[data-product]')) {
  group.querySelector('.lines').append(...lines.filter(line => line.product === group.dataset.product).map(line => h('button', {
    class: 'badge-link',
    type: 'button',
    'data-line': line.id,
    'aria-pressed': 'false',
    title: line.from === line.to ? `${line.id} Ringbahn` : `${line.id} ${line.from} – ${line.to}`,
    onclick: () => go(view?.kind === 'line' && view.id === line.id ? '' : `#l=${line.id}`)
  }, badge(line.id))))
}

for (const toggle of legend.querySelectorAll('[data-show]')) {
  toggle.addEventListener('click', () => {
    const key = toggle.dataset.show
    state.show[key] = !state.show[key]
    toggle.setAttribute('aria-checked', state.show[key])
    toggle.closest('.group').classList.toggle('off', !state.show[key])
    legend.querySelector(`.plate[data-level="${key}"]`)?.classList.toggle('off', !state.show[key])
    if (key === 'trains') loadTrains()
    else if (trains.size) trainNote.textContent = trainCount()
    if (['city', 'borders', 'zones'].includes(key) && styleLoaded) scene.paint()
    redraw()
  })
}

for (const plate of legend.querySelectorAll('.plate')) {
  plate.addEventListener('click', () => legend.querySelector(`[data-show="${plate.dataset.level}"]`).click())
}

const setSep = value => {
  sep = Math.round(Math.min(1, Math.max(0, value)) * 100) / 100
  sepInput.value = sep
  legend.style.setProperty('--s', sep)
  write('sep', sep)
  if (!spread()) return
  tween = null
  state.s = sep
  redraw()
}

sepInput.value = sep
legend.style.setProperty('--s', sep)
sepInput.addEventListener('input', () => setSep(Number(sepInput.value)))

const setDepth = real => {
  state.real = real
  write('depth', real ? 'real' : 'schema')
  document.documentElement.classList.toggle('depth-schema', !real)
  for (const button of depthGroup.querySelectorAll('[data-depth]')) button.setAttribute('aria-pressed', (button.dataset.depth === 'real') === real)
  camera.sync()
  if (state.mode !== '3d' || performance.now() < intro) return
  tween = { from: state.s, to: spread(), start: performance.now(), duration: 700 }
  if (!real && map.getPitch() > 85) map.easeTo({ pitch: PITCH, duration: 700 })
  else if (!real) map.setMaxPitch(85)
  if (styleLoaded) scene.paint()
  request()
}

for (const button of depthGroup.querySelectorAll('[data-depth]')) {
  button.addEventListener('click', () => {
    finishIntro()
    if ((button.dataset.depth === 'real') !== state.real) setDepth(button.dataset.depth === 'real')
  })
}

xrayInput.value = state.xray
xrayInput.addEventListener('input', () => {
  state.xray = Number(xrayInput.value)
  write('xray', state.xray)
  if (styleLoaded) scene.paint()
  redraw()
})

exagInput.value = state.exag
exagValue.textContent = `${state.exag.toLocaleString('de-DE')}×`
exagInput.addEventListener('input', () => {
  state.exag = Number(exagInput.value)
  exagValue.textContent = `${state.exag.toLocaleString('de-DE')}×`
  write('exag', state.exag)
  if (styleLoaded) scene.paint()
  redraw()
})

const setMode = next => {
  const three = next === '3d'
  intro = 0
  state.mode = next
  write('mode', next)
  for (const button of modeGroup.querySelectorAll('[data-mode]')) button.setAttribute('aria-pressed', button.dataset.mode === next)
  document.documentElement.classList.toggle('mode-2d', !three)
  for (const input of [sepInput, xrayInput, exagInput]) input.disabled = !three
  for (const handler of [map.dragRotate, map.touchPitch]) {
    if (three) handler.enable()
    else handler.disable()
  }
  if (three) map.touchZoomRotate.enableRotation()
  else map.touchZoomRotate.disableRotation()
  map.easeTo({ pitch: three ? PITCH : 0, bearing: three ? BEARING : 0, duration: 700 })
  tween = { from: state.s, to: spread(), start: performance.now(), duration: 700 }
  if (styleLoaded) scene.paint()
  if (three) camera.intro()
  request()
}

for (const button of modeGroup.querySelectorAll('[data-mode]')) {
  button.addEventListener('click', () => {
    if (button.dataset.mode !== state.mode) setMode(button.dataset.mode)
  })
}
if (state.mode === '2d') setMode('2d')
setDepth(state.real)

if (intro) {
  for (const type of ['wheel', 'mousedown', 'touchstart']) map.getCanvasContainer().addEventListener(type, finishIntro, { passive: true, once: true })
  map.once('idle', () => {
    if (!intro) return
    intro = performance.now() + 2400
    write('intro', '1', 'sessionStorage')
    map.easeTo({ center: TILTED, pitch: PITCH, bearing: BEARING, duration: 2400, easing: EASE })
    tween = { from: 0, to: spread(), start: performance.now(), duration: 2400 }
    request()
    setTimeout(camera.intro, 2600)
  })
} else if (state.mode === '3d') {
  map.once('idle', () => setTimeout(camera.intro, 1200))
}

toggleLegend(!MOBILE.matches)
legendToggle.addEventListener('click', () => toggleLegend())

const setTheme = next => {
  state.theme = next
  document.documentElement.dataset.theme = next
  document.querySelector('meta[name="theme-color"]').content = next === 'dark' ? '#0a0d13' : '#f2f1ec'
  if (styleLoaded) scene.paint()
  redraw()
}

themeButton.addEventListener('click', () => {
  stored = state.theme === 'dark' ? 'light' : 'dark'
  write('theme', stored)
  setTheme(stored)
})

DARK.addEventListener('change', event => {
  if (!stored) setTheme(event.matches ? 'dark' : 'light')
})

document.fonts.load(`500 12px "IBM Plex Sans Variable"`).catch(() => {}).finally(() => {
  state.fonts = true
  redraw()
})

const forms = text => {
  const lower = text.toLowerCase().replace(/ß/g, 'ss')
  return [lower.replace(/[äöü]/g, char => ({ ä: 'ae', ö: 'oe', ü: 'ue' })[char]), lower.normalize('NFD').replace(/\p{M}/gu, '')]
    .map(form => form.replace(/[^a-z0-9]+/g, ' ').trim())
}

const index = stations.map(station => ({ station, keys: forms(station.name) }))

const renderResults = () => {
  results.hidden = !search.value.trim() || document.activeElement !== search
  search.setAttribute('aria-expanded', !results.hidden)
  if (hits.length) search.setAttribute('aria-activedescendant', `hit-${active}`)
  else search.removeAttribute('aria-activedescendant')
  if (!hits.length) results.replaceChildren(h('li', { class: 'none', role: 'option', 'aria-disabled': 'true' }, 'Keine Treffer'))
  else results.replaceChildren(...hits.map((hit, i) => h('li', {
    id: `hit-${i}`,
    role: 'option',
    'aria-selected': i === active,
    onpointerdown: event => event.preventDefault(),
    onclick: () => choose(hit)
  }, hit.line
    ? [h('span', { class: 'hit-name' }, badge(hit.line.id), hit.line.from === hit.line.to ? 'Ringbahn' : `${hit.line.from} – ${hit.line.to}`)]
    : [h('span', { class: 'hit-name' }, hit.station.name, fare(hit.station)), h('span', { class: 'hit-badges' }, hit.station.lines.map(id => badge(id)))]
  )))
}

const choose = hit => {
  search.value = ''
  hits = []
  search.blur()
  renderResults()
  go(hit.line ? `#l=${hit.line.id}` : `#s=${hit.station.id}`)
}

search.addEventListener('input', () => {
  const queries = [...new Set(forms(search.value))].filter(Boolean)
  const upper = search.value.trim().toUpperCase()
  const score = keys => Math.min(...keys.flatMap(key => queries.map(query =>
    key.startsWith(query) ? 0 : key.includes(` ${query}`) ? 1 : key.includes(query) ? 2 : key.replaceAll(' ', '').includes(query.replaceAll(' ', '')) ? 3 : 9
  )))
  active = 0
  hits = queries.length ? [
    ...(upper.length > 1 ? lines.filter(line => line.id.startsWith(upper)).map(line => ({ line })) : []),
    ...index.map(entry => ({ station: entry.station, score: score(entry.keys) }))
      .filter(hit => hit.score < 9)
      .sort((a, b) => a.score - b.score || b.station.lines.length - a.station.lines.length || a.station.name.localeCompare(b.station.name, 'de'))
  ].slice(0, 8) : []
  renderResults()
})

search.addEventListener('keydown', event => {
  if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && hits.length) {
    event.preventDefault()
    active = (active + (event.key === 'ArrowDown' ? 1 : -1) + hits.length) % hits.length
    renderResults()
  } else if (event.key === 'Enter' && hits.length) {
    event.preventDefault()
    choose(hits[active])
  } else if (event.key === 'Escape') {
    search.value = ''
    hits = []
    search.blur()
    renderResults()
  }
})

search.addEventListener('focus', renderResults)
search.addEventListener('blur', () => { results.hidden = true })

addEventListener('keydown', event => {
  if (event.target.closest?.('input, textarea')) return
  if (event.key === '/') {
    event.preventDefault()
    search.focus()
  } else if (event.key === 'Escape') {
    if (MOBILE.matches && legend.classList.contains('open')) toggleLegend(false)
    else if (view) go('')
  } else if ((event.key === '[' || event.key === ']') && spread()) {
    setSep(sep + (event.key === ']' ? 0.1 : -0.1))
  }
})

let dragY = null
panel.addEventListener('pointerdown', event => {
  if (MOBILE.matches && event.target.closest('.grip, .panel-head')) dragY = event.clientY
})
addEventListener('pointercancel', () => { dragY = null })
addEventListener('pointerup', event => {
  if (dragY == null) return
  const delta = event.clientY - dragY
  dragY = null
  if (delta < -40) panel.classList.add('expanded')
  else if (delta > 40 && panel.classList.contains('expanded')) panel.classList.remove('expanded')
  else if (delta > 40) go('')
})
panel.querySelector('.grip').addEventListener('click', () => panel.classList.toggle('expanded'))

close.addEventListener('click', () => go(''))
refresh.addEventListener('click', () => load())
addEventListener('hashchange', route)

document.addEventListener('visibilitychange', () => {
  clearTimeout(pollTimer)
  clearTimeout(radarTimer)
  if (document.hidden) return
  if (view && view.kind !== 'line' && !view.gone && !panel.classList.contains('busy')) pollTimer = setTimeout(load, Math.max(0, 30000 - (Date.now() - loadedAt)))
  radarTimer = setTimeout(loadTrains, Math.max(0, radarAt + 20000 - Date.now()))
  redraw()
})

setInterval(tick, 1000)
setInterval(() => {
  for (const [node, time] of countdowns) node.textContent = countdown(time)
}, 10000)

if (!network) {
  toast.replaceChildren(h('span', {}, 'Das Liniennetz konnte nicht geladen werden.'), h('button', { type: 'button', onclick: () => location.reload() }, 'Neu laden'))
  toast.hidden = false
}

route()
loadTrains()
redraw()
