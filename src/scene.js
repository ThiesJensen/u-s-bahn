import { MapboxOverlay } from '@deck.gl/mapbox'
import { LayerExtension, MapView, WebMercatorViewport } from '@deck.gl/core'
import { ArcLayer, IconLayer, LineLayer, PathLayer, PolygonLayer, ScatterplotLayer, SolidPolygonLayer, TextLayer } from '@deck.gl/layers'
import { PathStyleExtension } from '@deck.gl/extensions'
import { TripsLayer } from '@deck.gl/geo-layers'

class Fog extends LayerExtension {
  static extensionName = 'Fog'

  getShaders(extension) {
    return {
      inject: {
        'vs:#decl': 'out float vFog;',
        'vs:DECKGL_FILTER_GL_POSITION': 'vFog = smoothstep(2.2, 5.0, position.w / project.focalDistance);',
        ...(extension.opts?.thin && { 'vs:DECKGL_FILTER_SIZE': 'size *= clamp(project.focalDistance / project_common_position_to_clipspace(geometry.position).w, 0.35, 1.0);' }),
        'fs:#decl': 'in float vFog;',
        'fs:DECKGL_FILTER_COLOR': 'color.a *= 1.0 - vFog;'
      }
    }
  }
}

const MOBILE = matchMedia('(max-width: 699px) and (orientation: portrait)').matches
const TOUCH = matchMedia('(pointer: coarse)').matches
const FONT = 'IBM Plex Sans Variable'
const WIDTHS = [[9, 1.3], [11, 2], [13, 3.2], [15, 5.4], [17, 8.5]]
const STATION_SIZE = [[9, 2.6], [12, 4.4], [15, 7], [18, 10]]
const TRAIN_SIZE = [[9, 3.4], [11, 4.4], [13, 5.6], [14, 8.6], [17, 12]]
const GLOW_SIZE = [[9, 7.5], [11, 9.5], [13, 12], [14, 17], [17, 23]]
const LABEL_SIZE = [[11, 11], [16, 15]]
const TRAIN_LABEL_SIZE = [[14, 9], [17, 12]]
const METER = [1 / 67770, 1 / 111320]
const KM = METER.map(degrees => degrees * 1000)
const HALF = { subway: 55, suburban: 75 }
const WIDE = { subway: 8, suburban: 11 }
const ROOF = -4.5
const GLOW_RATIO = MOBILE ? 3 : 4
const THEMES = {
  dark: { bg: [10, 13, 19], text: [201, 210, 224], muted: [120, 131, 150], ring: [20, 28, 43], subway: [76, 155, 255], suburban: [61, 214, 140] },
  light: { bg: [242, 241, 236], text: [27, 36, 51], muted: [104, 113, 128], ring: [20, 28, 43], subway: [27, 98, 168], suburban: [11, 138, 79] }
}
const BASEMAP = [
  [['background'], '#0A0D13', '#F2F1EC'],
  [['landuse_residential'], '#0D1118', '#ECEBE5'],
  [['landuse_park', 'landcover_wood'], '#0C1512', '#E1E8D9'],
  [['landcover', 'landuse'], 'bg', 'bg'],
  [['water_name'], '#2E4A6B', '#6F8FAA'],
  [['waterway'], '#10233A', '#B5CADB'],
  [['water'], '#0A1624', '#C8D7E3'],
  [['building'], '#11161E', '#E4E1DA'],
  [['highway_name', 'road_oneway', 'boundary', 'place_city_large', 'place_state'], null, null],
  [['highway_major_casing', 'highway_motorway_casing'], '#0A0D13', '#DEDBD3'],
  [['highway_path', 'highway_minor', 'road_'], '#121822', '#FFFFFF'],
  [['highway_major'], '#19202B', '#FFFFFF'],
  [['highway_motorway'], '#222A37', '#FFF8EC'],
  [['railway_transit_dashline', 'railway_minor_dashline', 'railway_dashline'], 'bg', 'bg'],
  [['railway', 'aeroway'], '#1A2029', '#D6D3CC'],
  [['place'], '#5C6880', '#7C8592']
]
const FADE = { background: [1, 0.5], landuse_residential: [0.4, 0.2], landuse_park: [1, 0.5], building: [1, 0.25] }
const VEIL = [[[11, 50.9], [15.4, 50.9], [15.4, 54.1], [11, 54.1]]]
const FARES = { dark: ['#FFC94D', '#A7B5FF', '#6FDCCB'], light: ['#B07A00', '#4B5BD0', '#0E8C7C'] }
const LETTERS = [['A', 13.404, 52.4775], ['B', 13.282, 52.556], ['B', 13.232, 52.472], ['B', 13.575, 52.448], ['B', 13.505, 52.592], ['C', 13.1, 52.64], ['C', 13.62, 52.68], ['C', 13.7, 52.33], ['C', 13.02, 52.38]]
const BERLIN = ['all', ['==', ['get', 'kind'], 'border'], ['==', ['get', 'id'], 'berlin']]
const BRANDENBURG = ['all', ['==', ['get', 'kind'], 'border'], ['==', ['get', 'id'], 'brandenburg']]
const BAND = ['==', ['get', 'band'], ['min', ['floor', ['zoom']], 16]]
const EMPTY = { type: 'FeatureCollection', features: [] }
const FOG = [new Fog()]
const THIN = [new Fog({ thin: true })]
const OFFSET = [new PathStyleExtension({ offset: true }), ...THIN]
const DASHED = [new PathStyleExtension({ offset: true, dashMode: 'path' }), ...THIN]
const GLASS = { depthWriteEnabled: false }
const ADD = { depthWriteEnabled: false, blend: true, blendColorSrcFactor: 'src-alpha', blendColorDstFactor: 'one', blendAlphaSrcFactor: 'zero', blendAlphaDstFactor: 'one' }
const TOP = { depthCompare: 'always', depthWriteEnabled: false }
const PIN = { depthCompare: 'always', depthWriteEnabled: true }
const ADD_TOP = { ...ADD, depthCompare: 'always' }
const ROUND = { capRounded: true, jointRounded: true, widthUnits: 'pixels', getWidth: 1 }
const LINE = { ...ROUND, billboard: true }
const SDF = { sdf: true, buffer: 10, radius: 20 }
const SPOT = { spot: { x: 0, y: 0, width: 64, height: 64, mask: true } }
const ARROW = { arrow: { x: 0, y: 0, width: 64, height: 64, mask: false } }
const SIDES = [[1, 0], [-1, 0], [0, -1], [0, 1]]
const CORNERS = [...SIDES, [1, -1], [-1, -1], [1, 1], [-1, 1]]

const spot = document.createElement('canvas')
spot.width = spot.height = 64
const brush = spot.getContext('2d')
const falloff = brush.createRadialGradient(32, 32, 0, 32, 32, 32)
falloff.addColorStop(0, 'rgb(255 255 255 / 1)')
falloff.addColorStop(0.3, 'rgb(255 255 255 / 0.55)')
falloff.addColorStop(1, 'rgb(255 255 255 / 0)')
brush.fillStyle = falloff
brush.fillRect(0, 0, 64, 64)

const arrow = document.createElement('canvas')
arrow.width = arrow.height = 64
const pen = arrow.getContext('2d')
pen.fillStyle = '#fff'
pen.strokeStyle = 'rgb(10 13 19 / 0.7)'
pen.lineJoin = 'round'
pen.lineWidth = 3
pen.beginPath()
pen.moveTo(40, 19)
pen.lineTo(61, 32)
pen.lineTo(40, 45)
pen.closePath()
pen.fill()
pen.stroke()

const ruler = document.createElement('canvas').getContext('2d')
const widths = new Map()

const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16))

const interp = (stops, zoom, base = 1) => {
  const i = stops.findIndex(([stop]) => stop > zoom)
  if (i === 0) return stops[0][1]
  if (i < 0) return stops.at(-1)[1]
  const [[z0, v0], [z1, v1]] = [stops[i - 1], stops[i]]
  const t = base === 1 ? (zoom - z0) / (z1 - z0) : (base ** (zoom - z0) - 1) / (base ** (z1 - z0) - 1)
  return v0 + (v1 - v0) * t
}

export const createScene = (map, { lines, stations, tracks, lineById, stationById, borders, zones }, state) => {
  let ready = false
  let fadeTimer = 0
  let ceiling = false
  const overlay = new MapboxOverlay({ interleaved: true, views: new MapView({ id: 'mapbox', farZMultiplier: 2 }), onLoad: () => { ready = true }, getCursor: () => map.getCanvas().style.cursor, layers: [] })
  map.addControl(overlay)
  const colors = new Map(lines.map(line => [line.id, rgb(line.color)]))
  const inks = new Map(lines.map(line => [line.id, rgb(line.textColor)]))
  const cache = new Map()
  const memo = (name, key, build) => {
    const hit = cache.get(name)
    if (hit && hit.key.every((part, i) => part === key[i])) return hit.value
    const value = build()
    cache.set(name, { key, value })
    return value
  }

  const platforms = Object.entries(tracks.platforms).flatMap(([id, byLine]) => {
    const station = stationById.get(id)
    const groups = new Map()
    for (const [line, position] of Object.entries(byLine)) {
      if (station && lineById.has(line)) groups.set(position.join(), [...(groups.get(position.join()) ?? []), line])
    }
    return [...groups.values()].map(ids => {
      const [lon, lat, z] = byLine[ids[0]]
      const product = lineById.get(ids[0]).product
      const segment = tracks.segments.find(other => (other.from === id || other.to === id) && other.lines.some(line => ids.includes(line)))
      const coords = segment ? (segment.from === id ? segment.coords : [...segment.coords].reverse()) : []
      const [x, y] = coords.find(([x, y]) => Math.hypot((x - lon) / METER[0], (y - lat) / METER[1]) > HALF[product]) ?? coords.at(-1) ?? [lon + METER[0], lat]
      const length = Math.hypot((x - lon) / METER[0], (y - lat) / METER[1]) || 1
      const [ux, uy] = [(x - lon) / METER[0] / length, (y - lat) / METER[1] / length]
      const corner = (a, b) => [lon + (ux * a - uy * b) * METER[0], lat + (uy * a + ux * b) * METER[1]]
      const [h, w] = [HALF[product], WIDE[product]]
      return { id, name: station.name, lines: ids, product, lon, lat, z, color: colors.get(ids[0]), side: corner(h * 0.3, w + 2), outline: [corner(-h, -w), corner(h, -w), corner(h, w), corner(-h, w), corner(-h, -w)] }
    })
  })
  const risers = [
    ...platforms.filter(platform => Math.abs(platform.z) > 1.5).map(platform => ({ from: platform, to: { ...platform, z: 0 }, link: false })),
    ...platforms.flatMap(platform => {
      const next = platforms.filter(other => other.id === platform.id && other.z < platform.z - 1.5 && Math.sign(other.z) === Math.sign(platform.z)).sort((a, b) => b.z - a.z)[0]
      return next && Math.hypot((next.side[0] - platform.side[0]) / METER[0], (next.side[1] - platform.side[1]) / METER[1]) < 30 ? [{ from: platform, to: next, link: true }] : []
    })
  ]
  const spots = stations.map(station => [station.lon / METER[0], station.lat / METER[1], station.lines.length > 1 ? 10 : 13])
  const along = { type: 'FeatureCollection', features: (borders?.features ?? []).filter(feature => feature.properties.kind === 'border').flatMap(feature => {
    const corners = feature.geometry.coordinates.flat().filter((_, k) => k % 8 === 0)
    const near = spots.filter(([x, y]) => corners.some(([lon, lat]) => Math.hypot(lon / METER[0] - x, lat / METER[1] - y) < 5000))
    return [8, 9, 10, 11, 12, 13, 14, 15, 16].flatMap(band => feature.geometry.coordinates.flatMap(ring => {
      const mpp = 47652 / 2 ** band
      const points = ring.map(([lon, lat]) => [lon / METER[0], lat / METER[1]])
      const out = []
      let [i, travelled, free] = [0, 0, 0]
      while (i < points.length - 1) {
        let j = i + 1
        const fits = k => {
          const [[ax, ay], [bx, by]] = [points[i], points[k]]
          const span = Math.hypot(bx - ax, by - ay)
          return points.slice(i + 1, k).every(([x, y]) => Math.abs((x - ax) * (by - ay) - (y - ay) * (bx - ax)) <= 10 * mpp * span)
        }
        while (j + 1 < points.length && fits(j + 1)) j++
        const [[ax, ay], [bx, by]] = [points[i], points[j]]
        const length = Math.hypot(bx - ax, by - ay)
        const clear = () => near.every(([x, y, from]) => {
          if (band < from) return true
          const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / (length * length || 1)))
          return Math.hypot(ax + (bx - ax) * t - x, ay + (by - ay) * t - y) > 70 * mpp
        })
        if (length > (feature.properties.id === 'berlin' ? 68 : 100) * mpp && travelled >= free && clear()) {
          out.push({ type: 'Feature', properties: { id: feature.properties.id, band, long: length > 88 * mpp }, geometry: { type: 'LineString', coordinates: [ring[i], ring[j]] } })
          free = travelled + 320 * mpp
        }
        travelled += length
        i = j
      }
      return out
    }))
  }) }

  const paint = () => {
    const dark = state.theme === 'dark'
    const bg = dark ? '#0A0D13' : '#F2F1EC'
    const city = state.show.city
    const real = state.mode === '3d' && state.real
    const visible = city && state.mode === '3d'
    const exag = real ? state.exag : 1
    ceiling = real && map.getPitch() > 90
    const solid = ceiling ? 0.12 : real ? 0.9 - 0.65 * state.xray : 0.85
    const minzoom = MOBILE ? 14 : 13
    const opacity = ['interpolate', ['linear'], ['zoom'], minzoom, 0, minzoom + 1, solid]
    const layers = map.getStyle().layers
    for (const layer of layers) {
      if (layer.type === 'fill-extrusion' || layer.type === 'custom') continue
      const rule = BASEMAP.find(([prefixes]) => prefixes.some(prefix => layer.id.startsWith(prefix)))
      const fade = FADE[layer.id]
      if (fade) map.setPaintProperty(layer.id, `${layer.type}-opacity`, fade[city ? 0 : 1])
      if (!rule) continue
      if (!rule[1]) {
        map.setLayoutProperty(layer.id, 'visibility', 'none')
        continue
      }
      const color = rule[dark ? 1 : 2] === 'bg' ? bg : rule[dark ? 1 : 2]
      if (layer.type === 'symbol') {
        if (layer.layout?.['icon-image']) map.setLayoutProperty(layer.id, 'icon-image', null)
        map.setPaintProperty(layer.id, 'text-color', color)
        map.setPaintProperty(layer.id, 'text-halo-color', bg)
      } else {
        map.setPaintProperty(layer.id, `${layer.type}-color`, color)
      }
      if (layer.type === 'fill') map.setPaintProperty(layer.id, 'fill-pattern', null)
      if (layer.id === 'building') map.setPaintProperty(layer.id, 'fill-outline-color', dark ? '#171E29' : '#D8D4CB')
    }
    if (!map.getLayer('building-3d')) {
      map.addLayer({
        id: 'building-3d',
        type: 'fill-extrusion',
        source: 'openmaptiles',
        'source-layer': 'building',
        minzoom,
        layout: { visibility: visible ? 'visible' : 'none' },
        paint: {
          'fill-extrusion-opacity': opacity,
          'fill-extrusion-opacity-transition': { duration: 300, delay: 0 },
          'fill-extrusion-vertical-gradient': true
        }
      }, layers.find(layer => layer.id.startsWith('place_'))?.id)
    }
    map.setPaintProperty('building-3d', 'fill-extrusion-height', ['*', exag, ['coalesce', ['get', 'render_height'], 0]])
    map.setPaintProperty('building-3d', 'fill-extrusion-base', ['*', exag, ['coalesce', ['get', 'render_min_height'], 0]])
    map.setPaintProperty('building-3d', 'fill-extrusion-color', ['interpolate', ['linear'], ['coalesce', ['get', 'render_height'], 0], 0, dark ? '#1A2231' : '#ECE9E2', 80, dark ? '#253047' : '#E2DED6', 200, dark ? '#344462' : '#D6D1C8'])
    clearTimeout(fadeTimer)
    if (visible) map.setLayoutProperty('building-3d', 'visibility', 'visible')
    else fadeTimer = setTimeout(() => map.setLayoutProperty('building-3d', 'visibility', 'none'), 300)
    map.setPaintProperty('building-3d', 'fill-extrusion-opacity', visible ? opacity : 0)
    for (const id of ['place_other', 'place_suburb']) if (map.getLayer(id)) map.setLayerZoomRange(id, 0, MOBILE ? 12.5 : 12)
    if (!map.getSource('zones')) {
      map.addSource('borders', { type: 'geojson', data: borders ?? EMPTY })
      map.addSource('border-labels', { type: 'geojson', data: along })
      map.addSource('zones', { type: 'geojson', data: zones ?? EMPTY })
      map.addSource('zone-letters', { type: 'geojson', data: { type: 'FeatureCollection', features: LETTERS.map(([zone, ...coordinates]) => ({ type: 'Feature', properties: { zone }, geometry: { type: 'Point', coordinates } })) } })
      const names = ['literal', [...new Set(stations.map(station => station.name))]]
      for (const layer of layers) if (layer.type === 'symbol' && layer.id.startsWith('place_')) map.setFilter(layer.id, ['all', layer.filter ?? true, ['!', ['in', ['get', 'name'], names]]])
    }
    const [a, b, c] = FARES[state.theme]
    const fare = ['match', ['get', 'zone'], 'A', a, 'B', b, c]
    const ink = dark ? '#E9EDF5' : '#283040'
    const label = { 'symbol-placement': 'line', 'symbol-spacing': 560, 'text-font': ['Noto Sans Bold'], 'text-letter-spacing': 0.3, 'text-max-angle': 25, 'text-pitch-alignment': 'viewport', 'text-padding': 4 }
    for (const layer of [
      { id: 'zone-fill', type: 'fill', source: 'zones', paint: { 'fill-color': dark ? ['match', ['get', 'zone'], 'A', '#FFE9B8', 'B', b, c] : fare, 'fill-opacity': ['interpolate', ['linear'], ['zoom'], 9, ['match', ['get', 'zone'], 'A', dark ? 0.11 : 0.09, 'B', dark ? 0.09 : 0.07, dark ? 0.06 : 0.05], 12, ['match', ['get', 'zone'], 'A', dark ? 0.09 : 0.08, 'B', dark ? 0.075 : 0.06, dark ? 0.05 : 0.045], 15, ['match', ['get', 'zone'], 'A', dark ? 0.03 : 0.06, 'B', dark ? 0.025 : 0.035, dark ? 0.02 : 0.03]], 'fill-antialias': false } },
      { id: 'zone-letter', type: 'symbol', source: 'zone-letters', layout: { 'text-field': ['get', 'zone'], 'text-font': ['Noto Sans Regular'], 'text-size': ['interpolate', ['exponential', 2], ['zoom'], 8, 14, 12, 224], 'text-rotation-alignment': 'map', 'text-pitch-alignment': 'map', 'text-allow-overlap': true, 'text-ignore-placement': true }, paint: { 'text-color': fare, 'text-halo-color': bg, 'text-halo-width': 2, 'text-opacity': ['interpolate', ['linear'], ['zoom'], 12, dark ? 0.7 : 0.6, 13.2, 0] } },
      { id: 'zone-line', type: 'line', source: 'zones', layout: { 'line-join': 'round' }, paint: { 'line-color': fare, 'line-opacity': dark ? 0.7 : 0.8, 'line-width': ['interpolate', ['linear'], ['zoom'], 9, 1.4, 14, 3], 'line-offset': ['interpolate', ['linear'], ['zoom'], 9, 2, 14, 3] } },
      { id: 'border-halo', type: 'line', source: 'borders', filter: BERLIN, layout: { 'line-join': 'round' }, paint: { 'line-color': dark ? ink : '#FFFFFF', 'line-opacity': dark ? 0.1 : 0.85, 'line-width': ['interpolate', ['linear'], ['zoom'], 8, dark ? 5 : 4, 12, dark ? 12 : 7, 16, dark ? 22 : 11], 'line-blur': ['interpolate', ['linear'], ['zoom'], 8, dark ? 2 : 1, 16, dark ? 9 : 4] } },
      { id: 'border-brandenburg', type: 'line', source: 'borders', filter: BRANDENBURG, layout: { 'line-join': 'round' }, paint: { 'line-color': ink, 'line-opacity': 0.5, 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 1, 14, 1.8], 'line-dasharray': [3, 2.5] } },
      { id: 'border-berlin', type: 'line', source: 'borders', filter: BERLIN, layout: { 'line-join': 'round' }, paint: { 'line-color': ink, 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 1.5, 12, 2.4, 16, 3.4], 'line-dasharray': [5, 2, 1, 2] } },
      { id: 'border-label-brandenburg', type: 'symbol', source: 'border-labels', filter: ['all', ['==', ['get', 'id'], 'brandenburg'], ['get', 'long'], BAND], layout: { ...label, 'text-field': 'BRANDENBURG', 'text-size': 10, 'text-letter-spacing': 0.22, 'text-offset': [0, -1.3] }, paint: { 'text-color': dark ? '#788396' : '#687180', 'text-halo-color': bg, 'text-halo-width': 1.6 } },
      { id: 'border-label-outside', type: 'symbol', source: 'border-labels', filter: ['all', ['==', ['get', 'id'], 'berlin'], ['get', 'long'], BAND], layout: { ...label, 'text-field': 'BRANDENBURG', 'text-size': 9.5, 'text-letter-spacing': 0.14, 'text-offset': [0, 1.45] }, paint: { 'text-color': dark ? '#8B95A7' : '#5E6878', 'text-halo-color': bg, 'text-halo-width': 1.6 } },
      { id: 'border-label-inside', type: 'symbol', source: 'border-labels', filter: ['all', ['==', ['get', 'id'], 'berlin'], BAND], layout: { ...label, 'text-field': 'BERLIN', 'text-size': 11.5, 'text-offset': [0, -1.3] }, paint: { 'text-color': ink, 'text-halo-color': bg, 'text-halo-width': 1.6 } }
    ]) {
      if (!map.getLayer(layer.id)) map.addLayer(layer, 'building-3d')
      else for (const [key, value] of Object.entries(layer.paint)) map.setPaintProperty(layer.id, key, value)
      map.setLayoutProperty(layer.id, 'visibility', state.show[layer.id.startsWith('zone') ? 'zones' : 'borders'] ? 'visible' : 'none')
    }
    map.setLight({ anchor: 'map', position: [1.5, 210, 35], color: dark ? '#B8C8FF' : '#FFFFFF', intensity: 0.35 })
    map.setSky({
      'sky-color': ceiling ? bg : dark ? '#05070C' : '#EEF1F5',
      'horizon-color': ceiling ? bg : dark ? '#1A2440' : '#F6EFE4',
      'fog-color': bg,
      'sky-horizon-blend': 0.6,
      'horizon-fog-blend': 0.8,
      'fog-ground-blend': 0.35,
      'atmosphere-blend': 0
    })
  }

  const render = (now = performance.now()) => {
    const { show, view, route } = state
    const theme = THEMES[state.theme]
    const dark = state.theme === 'dark'
    const glow = dark ? ADD : GLASS
    const glowTop = dark ? ADD_TOP : TOP
    const zoom = Math.round(map.getZoom() * 20) / 20
    const mpp = 47652 / 2 ** zoom
    const gap = state.s < 0.03 ? 0 : state.s * Math.max(180 * mpp, 120)
    const flat = gap === 0
    const real = state.mode === '3d' && state.real
    const exag = real ? state.exag : 0
    const beneath = real && map.getPitch() > 90
    if (beneath !== ceiling && map.getLayer('building-3d')) paint()
    const z = { city: 0, subway: gap, suburban: 2 * gap }
    const lift = ([x, y, h = 0], product) => [x, y, h * exag + z[product]]
    const rise = d => real ? (beneath ? d.low : d.top) * exag : z[d.product]
    const above = real && map.getLayer('building-3d') ? 'building-3d' : undefined
    const below = real && map.getLayer('zone-fill') ? 'zone-fill' : undefined
    const deep = real ? Math.min(1, Math.max(0, (zoom - 13.2) / 1.3)) : 0
    const near = Math.min(1, Math.max(0, (zoom - 12.5) / 3))
    const veil = below ? 0.75 * (1 - state.xray) * (0.35 + 0.65 * near) : 0
    const nudge = mpp / 135540
    const w = interp(WIDTHS, zoom, 1.4)
    const stationSize = interp(STATION_SIZE, zoom)
    const shown = ['city', 'subway', 'suburban', 'trains'].map(key => Number(show[key])).join('')
    const line = view?.kind === 'line' ? view.id : null
    const trip = view?.kind === 'trip' ? view.trip : null
    const level = lineById.get(line ?? trip?.line?.name)?.product
    const selected = view?.kind === 'station' ? view.station.id : null
    const look = [view, trip, state.theme]
    const lineAlpha = d => line ? (d.line === line ? 1 : 0.12) : trip ? 0.28 : 1
    const stationAlpha = d => line ? (d.lines.includes(line) ? 1 : 0.22) : trip ? 0.45 : 1
    const trainAlpha = d => line ? (d.line === line ? 1 : 0.2) : trip ? (d.id === view.id ? 1 : 0.25) : 1
    const levelAlpha = product => level && product !== level ? (line ? 0.35 : 0.4) : 1
    const flatten = d => d.coords.map(([x, y]) => [x, y, z[d.product]])
    const split = (coords, product, values) => {
      const runs = []
      let run = null
      coords.forEach(([x, y, h], i) => {
        if (run && run.under !== h < ROOF) {
          const [px, py, ph] = coords[i - 1]
          const t = (ph - ROOF) / (ph - h)
          const cross = lift([px + (x - px) * t, py + (y - py) * t, ROOF], product)
          const value = values[i - 1] + (values[i] - values[i - 1]) * t
          run.path.push(cross)
          run.values.push(value)
          runs.push(run)
          run = { under: h < ROOF, path: [cross], values: [value] }
        }
        run ??= { under: h < ROOF, path: [], values: [] }
        run.path.push(lift([x, y, h], product))
        run.values.push(values[i])
      })
      return [...runs, run].filter(piece => piece.path.length > 1)
    }

    const focused = memo('focused', [view, trip], () => new Set(line
      ? stations.filter(station => station.lines.includes(line)).map(station => station.id)
      : trip ? (trip.stopovers ?? []).map(stop => stationById.get(stop.stop.id)?.id) : [selected]))
    const paths = memo('paths', [shown], () => tracks.segments.flatMap(segment => {
      const ids = segment.lines.filter(id => show[lineById.get(id)?.product])
      return ids.map((id, index) => ({ line: id, product: lineById.get(id).product, color: colors.get(id), k: segment.coords.map((_, i) => index - (ids.length - 1) / 2 + (segment.shift?.[i] ?? 0)), coords: segment.coords }))
    }))
    const pieces = memo('pieces', [paths, gap, exag, real], () => paths.flatMap(d => real
      ? split(d.coords, d.product, d.k).map(run => ({ ...d, under: run.under, path: run.path, k: run.values }))
      : [{ ...d, under: false, path: d.coords.map(point => lift(point, d.product)) }]))
    const parts = memo('parts', [pieces], () => [pieces.filter(piece => !piece.under), pieces.filter(piece => piece.under)])
    const prints = memo('prints', [pieces, real], () => pieces
      .filter(piece => !real || (!piece.under && piece.path.some(point => point[2] > 1.5 * exag)))
      .map(piece => ({ ...piece, path: piece.path.map(([x, y]) => [x, y, 0]) })))
    const boxes = memo('boxes', [shown, exag, real, gap], () => real ? platforms.filter(platform => platform.lines.some(id => show[lineById.get(id).product])).map(platform => ({
      ...platform,
      under: platform.z < ROOF,
      polygon: platform.outline.map(([x, y]) => [x, y, (platform.z - 1) * exag + z[platform.product]])
    })) : [])
    const shafts = memo('shafts', [shown, exag, real, gap], () => real ? risers.filter(riser => riser.from.lines.some(id => show[lineById.get(id).product]) && riser.to.lines.some(id => show[lineById.get(id).product])).map(riser => ({
      ...riser,
      under: riser.from.z < ROOF,
      id: riser.from.id,
      lines: riser.from.lines,
      color: riser.from.color,
      source: lift([...riser.from.side, riser.from.z], riser.from.product),
      target: lift([...riser.to.side, riser.to.z], riser.to.product)
    })) : [])
    const drops = memo('drops', [shown, exag, real, gap], () => real ? tracks.segments.flatMap(segment => {
      const id = segment.lines.find(other => show[lineById.get(other)?.product])
      if (!id) return []
      const product = lineById.get(id).product
      const out = []
      let [run, next] = [0, 18]
      for (let i = 1; i < segment.coords.length; i++) {
        const [[ax, ay, ah], [bx, by, bh]] = [segment.coords[i - 1], segment.coords[i]]
        const length = Math.hypot((bx - ax) / METER[0], (by - ay) / METER[1])
        for (; next <= run + length; next += 36) {
          const t = (next - run) / length
          const [x, y, h] = [ax + (bx - ax) * t, ay + (by - ay) * t, ah + (bh - ah) * t]
          if (h > 2.5) out.push({ line: id, source: lift([x, y, h], product), target: lift([x, y, 0], product) })
        }
        run += length
      }
      return out
    }) : [])
    const dots = memo('dots', [shown], () => stations.flatMap(station => {
      const ids = station.lines.filter(id => show[lineById.get(id)?.product])
      const heights = ids.map(id => tracks.platforms[station.id]?.[id]?.[2] ?? 0)
      return ids.length ? [{
        id: station.id,
        name: station.name,
        lon: station.lon,
        lat: station.lat,
        lines: station.lines,
        big: ids.length > 1,
        both: station.products.length > 1,
        product: ids.some(id => lineById.get(id).product === 'suburban') ? 'suburban' : 'subway',
        color: colors.get(ids[0]),
        top: Math.max(0, ...heights),
        low: Math.min(0, ...heights)
      }] : []
    }))
    const verticals = memo('verticals', [shown], () => dots.flatMap(dot => dot.both
      ? [{ dot, from: 'city', to: 'subway', both: true }, ...(show.suburban ? [{ dot, from: 'subway', to: 'suburban', both: true }] : [])]
      : [{ dot, from: 'city', to: dot.product, both: false }]))
    const beams = memo('beams', [verticals], () => verticals.filter(vertical => vertical.both))
    const planes = memo('planes', [shown], () => ['subway', 'suburban'].filter(product => show[product]).map(product => {
      const members = stations.filter(station => station.products.includes(product))
      const [west, south, east, north] = [
        Math.min(...members.map(station => station.lon)) - 1.5 * KM[0],
        Math.min(...members.map(station => station.lat)) - 1.5 * KM[1],
        Math.max(...members.map(station => station.lon)) + 1.5 * KM[0],
        Math.max(...members.map(station => station.lat)) + 1.5 * KM[1]
      ]
      return { product, west, north, coords: [[west, south], [east, south], [east, north], [west, north], [west, south]], box: [west, south, east, north] }
    }))
    const grid = memo('grid', [planes], () => planes.flatMap(({ product, box: [west, south, east, north] }) => [
      ...Array.from({ length: Math.floor((east - west) / KM[0]) }, (_, i) => ({ product, from: [west + (i + 1) * KM[0], south], to: [west + (i + 1) * KM[0], north] })),
      ...Array.from({ length: Math.floor((north - south) / KM[1]) }, (_, i) => ({ product, from: [west, south + (i + 1) * KM[1]], to: [east, south + (i + 1) * KM[1]] }))
    ]))
    const tags = memo('tags', [planes, show.city], () => [
      ...planes.map(plane => ({ product: plane.product, text: plane.product === 'suburban' ? 'EBENE 2 · S-BAHN' : 'EBENE 1 · U-BAHN', position: [plane.west, plane.north] })),
      ...(show.city && planes.length ? [{ product: 'city', text: 'EBENE 0 · STADT', position: [planes.at(-1).west, planes.at(-1).north] }] : [])
    ])
    const minor = MOBILE ? 13.5 : 13
    const labels = memo('labels', [dots, focused, zoom >= 10, zoom >= minor], () => dots.filter(dot => focused.has(dot.id) || zoom >= (dot.big ? 10 : minor)))
    const labelZ = d => level && !real && focused.has(d.id) && d.lines.some(id => lineById.get(id).product === level) ? z[level] : rise(d)
    const labelSize = interp(LABEL_SIZE, zoom)
    const { clientWidth: width, clientHeight: height } = map.getCanvas()
    const center = map.getCenter()
    const covers = [...document.querySelectorAll('.panel.open, .legend.open, .topbar > *, #camera')].map(node => node.getBoundingClientRect()).map(({ left, top, right, bottom }) => [left, top, right, bottom])
    const camera = [center.lng.toFixed(5), center.lat.toFixed(5), map.getZoom().toFixed(2), map.getBearing().toFixed(1), map.getPitch().toFixed(1), width, height, gap.toFixed(0), exag, ...covers.flat().map(Math.round)].join()
    const [placed, grows] = memo('placed', [labels, camera, level, state.fonts, dots, real], () => {
      if (!state.fonts) return [[], new Map()]
      const viewport = new WebMercatorViewport({ width, height, longitude: center.lng, latitude: center.lat, zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing(), padding: map.getPadding() })
      const matrix = viewport.viewProjectionMatrix
      const depth = position => {
        const [x, y, h] = viewport.projectPosition(position)
        return matrix[3] * x + matrix[7] * y + matrix[11] * h + matrix[15]
      }
      const focal = depth([center.lng, center.lat, 0])
      const scale = new Map()
      const taken = [...covers, ...dots.flatMap(d => {
        const position = [d.lon, d.lat, rise(d)]
        const k = focal / depth(position)
        const grow = Math.min(1.9, Math.max(1, 0.85 / k))
        scale.set(d.id, grow)
        const [x, y] = viewport.project(position)
        const r = (stationSize * (d.big ? 1 : 0.6) + 1.5) * k * grow
        return k > 0 ? [[x - r, y - r, x + r, y + r, (line || trip) && !focused.has(d.id)]] : []
      })]
      ruler.font = `500 100px "${FONT}"`
      return [labels
        .map(d => ({ ...d, focus: focused.has(d.id), grow: scale.get(d.id) }))
        .sort((a, b) => b.focus - a.focus || b.lines.length - a.lines.length || b.big - a.big)
        .flatMap(d => {
          const position = [d.lon, d.lat, labelZ(d)]
          const k = focal / depth(position)
          const [x, y] = viewport.project(position)
          if (!(k > 0.2 && x > -400 && y > -60 && x < width + 400 && y < height + 60)) return []
          const size = labelSize * k * d.grow * (d.big || d.focus ? 1 : 0.9)
          const ring = (stationSize * (d.big ? 1 : 0.6) + 2) * k * d.grow
          if (!widths.has(d.name)) widths.set(d.name, ruler.measureText(d.name).width / 100)
          const span = widths.get(d.name) * size + 4
          for (const [h, v] of d.focus ? CORNERS : SIDES) {
            const left = h > 0 ? x + ring : h < 0 ? x - ring - 3 - span : x - span / 2
            const top = v < 0 ? y - ring - size * 1.2 : v > 0 ? y + ring : y - size * 0.6
            const box = [left, top, left + span + (h ? 3 : 0), top + size * 1.2]
            if (box[0] < 0 || box[2] > width || taken.some(([x0, y0, x1, y1, dim]) => !(d.focus && dim) && box[0] < x1 && box[2] > x0 && box[1] < y1 && box[3] > y0)) continue
            taken.push(box)
            return [{ ...d, h, v }]
          }
          return []
        }), scale]
    })
    const [trains, dwelling] = memo('trains', [state.trains, shown, state.tick, gap, exag, zoom, beneath, dots], () => {
      const reach = Math.max(40, stationSize * 1.5 * mpp)
      const rings = new Map()
      const all = [...state.trains.values()].filter(train => show[train.product]).map(train => {
        const stop = dots.find(dot => dot.lines.includes(train.line) && (flat || dot.product === train.product) && Math.hypot((dot.lon - train.pos[0]) / METER[0], (dot.lat - train.pos[1]) / METER[1]) < reach)
        const ring = stop ? rings.get(stop.id) ?? 0 : 0
        if (stop) rings.set(stop.id, ring + 1)
        return { ...train, stop, ring: Math.min(ring, 2), position: stop ? [stop.lon, stop.lat, rise(stop)] : lift(train.pos, train.product) }
      })
      return [all.filter(train => !train.stop), all.filter(train => train.stop)]
    })
    const fleets = memo('fleets', [trains, real], () => real ? [trains.filter(train => train.pos[2] >= ROOF), trains.filter(train => train.pos[2] < ROOF)] : [trains, []])
    const routeColor = route ? rgb(route.color) : [255, 255, 255]
    const routeRuns = memo('routeRuns', [route, gap, exag, real], () => route ? route.paths.flatMap(path => {
      const steps = path.map((point, i) => i ? Math.hypot((point[0] - path[i - 1][0]) * 0.61, point[1] - path[i - 1][1]) : 0)
      const total = steps.reduce((sum, step) => sum + step, 0) || 1
      let run = 0
      const times = steps.map(step => (run += step) / total)
      return real ? split(path, route.product, times) : [{ under: false, path: path.map(point => lift(point, route.product)), values: times }]
    }) : [])
    const marks = memo('marks', [route, gap, exag], () => route ? [
      ...route.stops.map(position => ({ position: lift(position, route.product), under: real && position[2] < ROOF, now: false })),
      ...(route.now ? [{ position: lift(route.now, route.product), under: real && route.now[2] < ROOF, now: true }] : [])
    ] : [])
    const chosen = selected && dots.find(dot => dot.id === selected)
    const phase = (now % 1200) / 1200
    const ground = Math.max(40 / mpp, 7)
    const rings = [
      ...(chosen ? [{ position: [chosen.lon, chosen.lat, rise(chosen)], radius: (stationSize * (chosen.big ? 1 : 0.6) + 4) * (grows.get(chosen.id) ?? 1), color: [...theme.text, 200], width: 1.5 }] : []),
      ...(route?.now ? [{ position: marks.at(-1).position, radius: 10 + 8 * phase, color: [...routeColor, 200 * (1 - phase)], width: 2 }] : [])
    ]
    const grounds = flat || real ? [] : [
      ...(chosen ? [{ position: [chosen.lon, chosen.lat, 0], radius: ground, color: [...theme.text, 150], width: 1.5 }] : []),
      ...(route?.now ? [{ position: [route.now[0], route.now[1], 0], radius: ground, color: [...routeColor, 170], width: 1.5 }] : [])
    ]
    const verticalAlpha = (d, peak) => d.dot.id === selected ? Math.min(255, peak * 2) : peak * stationAlpha(d.dot)
    const shaftAlpha = d => (d.id === selected ? 1 : 0.75 * stationAlpha(d)) * deep
    const trainGlow = {
      iconAtlas: spot,
      iconMapping: SPOT,
      getIcon: () => 'spot',
      getPosition: d => d.position,
      sizeScale: interp(GLOW_SIZE, zoom) * 2.4,
      getSize: 1,
      getColor: d => [...colors.get(d.line), 90 * trainAlpha(d)],
      parameters: glowTop,
      extensions: FOG,
      updateTriggers: { getColor: look }
    }
    const trainDot = {
      getPosition: d => d.position,
      billboard: true,
      radiusUnits: 'pixels',
      radiusScale: interp(TRAIN_SIZE, zoom),
      getRadius: 1,
      stroked: true,
      lineWidthUnits: 'pixels',
      getLineWidth: 1.5,
      getFillColor: d => [...colors.get(d.line), 255 * trainAlpha(d)],
      getLineColor: d => [255, 255, 255, 255 * trainAlpha(d)],
      pickable: true,
      parameters: real && !beneath ? PIN : TOP,
      extensions: FOG,
      updateTriggers: { getFillColor: look, getLineColor: look }
    }
    const trainArrow = {
      iconAtlas: arrow,
      iconMapping: ARROW,
      getIcon: () => 'arrow',
      getPosition: d => d.position,
      getAngle: d => {
        const radians = d.angle * Math.PI / 180
        const [a, b] = [map.project([d.pos[0], d.pos[1]]), map.project([d.pos[0] + Math.cos(radians) * 30 * METER[0], d.pos[1] + Math.sin(radians) * 30 * METER[1]])]
        return Math.atan2(a.y - b.y, b.x - a.x) * 180 / Math.PI
      },
      sizeScale: interp(TRAIN_SIZE, zoom) * 4.8,
      getSize: d => d.way ? 1 : 0,
      getColor: d => [255, 255, 255, 255 * trainAlpha(d)],
      parameters: real && !beneath ? PIN : TOP,
      extensions: FOG,
      updateTriggers: { getAngle: camera, getColor: look }
    }
    const trainLabel = {
      fontFamily: FONT,
      fontWeight: 600,
      characterSet: 'auto',
      fontSettings: SDF,
      getText: d => d.line,
      getPosition: d => d.position,
      getColor: d => [...inks.get(d.line), 255 * trainAlpha(d)],
      sizeScale: interp(TRAIN_LABEL_SIZE, zoom),
      getSize: 1,
      getTextAnchor: 'middle',
      getAlignmentBaseline: 'center',
      parameters: real && !beneath ? PIN : TOP,
      extensions: FOG,
      updateTriggers: { getColor: look }
    }
    const sides = memo('sides', [boxes, shafts], () => [[boxes.filter(box => !box.under), shafts.filter(shaft => !shaft.under)], [boxes.filter(box => box.under), shafts.filter(shaft => shaft.under)], shafts.filter(shaft => !shaft.link)])
    const legs = memo('legs', [routeRuns, marks], () => [[routeRuns.filter(run => !run.under), marks.filter(mark => !mark.under)], [routeRuns.filter(run => run.under), marks.filter(mark => mark.under)]])
    const groups = [[parts[0], ...sides[0], fleets[0], drops, above, ''], [parts[1], ...sides[1], fleets[1], [], below, '-under']]
      .filter(([, , , , , beforeId, tag]) => !tag || beforeId)
    const routeGroups = real
      ? [[...legs[0], above, ''], [...legs[1], below, '-under']].filter(([, , beforeId, tag]) => !tag || beforeId)
      : [[routeRuns, marks, undefined, '']]

    overlay.setProps({
      layers: [
        !flat && !real && new SolidPolygonLayer({
          id: 'level-planes',
          data: planes,
          getPolygon: flatten,
          getFillColor: d => [...theme[d.product], 22 * levelAlpha(d.product)],
          parameters: GLASS,
          updateTriggers: { getPolygon: gap, getFillColor: look }
        }),
        !flat && !real && new LineLayer({
          id: 'level-grid',
          data: grid,
          getSourcePosition: d => [...d.from, z[d.product]],
          getTargetPosition: d => [...d.to, z[d.product]],
          getColor: d => [...theme[d.product], (dark ? 22 : 14) * levelAlpha(d.product)],
          widthUnits: 'pixels',
          getWidth: 1,
          parameters: GLASS,
          extensions: FOG,
          updateTriggers: { getSourcePosition: gap, getTargetPosition: gap, getColor: look }
        }),
        !flat && !real && new PathLayer({
          id: 'level-edges',
          data: planes,
          getPath: flatten,
          getColor: d => [...theme[d.product], (line && d.product === level ? 230 : 170) * levelAlpha(d.product)],
          widthUnits: 'pixels',
          getWidth: 1.2,
          parameters: GLASS,
          updateTriggers: { getPath: gap, getColor: look }
        }),
        (real || (!flat && show.city)) && new PathLayer({
          id: 'footprints',
          data: prints,
          getPath: d => d.path,
          getColor: d => [...d.color, (real ? 60 * near : 36) * lineAlpha(d)],
          widthScale: w * (real ? 0.35 : 0.6),
          getOffset: d => d.k.map(k => k / (real ? 0.35 : 0.6)),
          extensions: OFFSET,
          parameters: GLASS,
          beforeId: above,
          ...ROUND,
          updateTriggers: { getColor: [...look, near] }
        }),
        !flat && !real && new ArcLayer({
          id: 'verticals-glow',
          data: beams,
          getSourcePosition: d => [d.dot.lon, d.dot.lat, z[d.from]],
          getTargetPosition: d => [d.dot.lon + nudge, d.dot.lat, z[d.to]],
          getSourceColor: d => [...theme.subway, d.from === 'city' ? 0 : verticalAlpha(d, 70)],
          getTargetColor: d => [...theme[d.to], verticalAlpha(d, 70)],
          getHeight: 0,
          numSegments: 2,
          widthUnits: 'pixels',
          getWidth: 10,
          parameters: glow,
          extensions: FOG,
          updateTriggers: { getSourcePosition: gap, getTargetPosition: [gap, nudge], getSourceColor: look, getTargetColor: look }
        }),
        !flat && !real && new ArcLayer({
          id: 'verticals',
          data: verticals,
          getSourcePosition: d => [d.dot.lon, d.dot.lat, z[d.from]],
          getTargetPosition: d => [d.dot.lon + nudge, d.dot.lat, z[d.to]],
          getSourceColor: d => [...theme[d.both ? 'subway' : d.to], d.from === 'city' ? 0 : verticalAlpha(d, 235)],
          getTargetColor: d => [...theme[d.to], verticalAlpha(d, d.both ? 235 : 70)],
          getHeight: 0,
          numSegments: 2,
          widthUnits: 'pixels',
          getWidth: d => d.both ? 2 : d.dot.id === selected ? 1.5 : 1,
          parameters: GLASS,
          extensions: FOG,
          updateTriggers: { getSourcePosition: gap, getTargetPosition: [gap, nudge], getSourceColor: look, getTargetColor: look, getWidth: look }
        }),
        above && new SolidPolygonLayer({
          id: 'ceiling',
          data: VEIL,
          getPolygon: d => d,
          getFillColor: dark ? [14, 18, 27, 150] : [228, 226, 219, 175],
          parameters: { cullMode: 'front', depthWriteEnabled: false },
          extensions: FOG,
          beforeId: below
        }),
        deep > 0 && new ScatterplotLayer({
          id: 'portals',
          data: sides[2],
          getPosition: d => d.target,
          radiusUnits: 'meters',
          getRadius: 2.6,
          radiusMinPixels: 2,
          stroked: true,
          lineWidthUnits: 'pixels',
          getLineWidth: 1.5,
          getFillColor: [...theme.bg, 230 * deep],
          getLineColor: d => [...d.color, 255 * shaftAlpha(d)],
          parameters: GLASS,
          extensions: FOG,
          beforeId: above,
          updateTriggers: { getLineColor: [...look, deep] }
        }),
        ...groups.flatMap(([data, platformData, shaftData, fleet, dropData, beforeId, tag]) => [
          deep > 0 && dropData.length > 0 && new LineLayer({
            id: `drops${tag}`,
            data: dropData,
            getSourcePosition: d => d.source,
            getTargetPosition: d => d.target,
            getColor: d => [...theme.muted, 80 * lineAlpha(d) * deep],
            widthUnits: 'pixels',
            getWidth: 1,
            extensions: FOG,
            beforeId,
            updateTriggers: { getColor: [...look, deep] }
          }),
          deep > 0 && dark && shaftData.length > 0 && new ArcLayer({
            id: `shafts-glow${tag}`,
            data: shaftData,
            getSourcePosition: d => d.source,
            getTargetPosition: d => d.link ? d.target : [d.target[0] + nudge, d.target[1], d.target[2]],
            getSourceColor: d => [...d.color, 90 * shaftAlpha(d)],
            getTargetColor: d => [...d.color, (d.link ? 90 : 10) * shaftAlpha(d)],
            getHeight: 0,
            numSegments: 2,
            widthUnits: 'pixels',
            getWidth: 12,
            parameters: ADD,
            extensions: FOG,
            beforeId,
            updateTriggers: { getTargetPosition: nudge, getSourceColor: [...look, deep], getTargetColor: [...look, deep] }
          }),
          deep > 0 && shaftData.length > 0 && new ArcLayer({
            id: `shafts${tag}`,
            data: shaftData,
            getSourcePosition: d => d.source,
            getTargetPosition: d => d.link ? d.target : [d.target[0] + nudge, d.target[1], d.target[2]],
            getSourceColor: d => [...d.color, 255 * shaftAlpha(d)],
            getTargetColor: d => [...d.color, (d.link ? 255 : 40) * shaftAlpha(d)],
            getHeight: 0,
            numSegments: 2,
            widthUnits: 'pixels',
            getWidth: d => d.link ? 3 : 2.5,
            extensions: FOG,
            beforeId,
            updateTriggers: { getTargetPosition: nudge, getSourceColor: [...look, deep], getTargetColor: [...look, deep] }
          }),
          dark && new PathLayer({
            id: `network-glow${tag}`,
            data,
            getPath: d => d.path,
            getColor: d => [...d.color, line ? (d.line === line ? 110 : 52 * 0.12) : 52 * lineAlpha(d)],
            widthScale: w * GLOW_RATIO,
            getOffset: d => d.k.map(k => k / GLOW_RATIO),
            extensions: OFFSET,
            parameters: ADD,
            beforeId,
            ...LINE,
            updateTriggers: { getColor: look }
          }),
          new PathLayer({
            id: `network-casing${tag}`,
            data,
            getPath: d => d.path,
            getColor: d => tag ? [...d.color, 120 * lineAlpha(d)] : [...theme.bg, 255 * lineAlpha(d)],
            widthScale: w * 1.7,
            getOffset: d => d.k.map(k => k / 1.7),
            extensions: tag ? DASHED : OFFSET,
            getDashArray: [2.4, 1.4],
            dashJustified: true,
            parameters: GLASS,
            beforeId,
            ...LINE,
            capRounded: !real,
            updateTriggers: { getColor: look }
          }),
          new PathLayer({
            id: `network${tag}`,
            data,
            getPath: d => d.path,
            getColor: d => [...d.color, (tag ? 215 : 255) * lineAlpha(d)],
            widthScale: w,
            getOffset: d => d.k,
            extensions: OFFSET,
            pickable: true,
            beforeId,
            ...LINE,
            updateTriggers: { getColor: look }
          }),
          deep > 0 && new PolygonLayer({
            id: `platforms${tag}`,
            data: platformData,
            getPolygon: d => d.polygon,
            extruded: true,
            wireframe: true,
            elevationScale: exag,
            getElevation: 5,
            getFillColor: d => [...(d.lines.length === 1 ? d.color : theme[d.product]), (d.id === selected ? 150 : 90) * stationAlpha(d) * deep],
            getLineColor: d => [...theme.text, (d.id === selected ? 255 : 190) * stationAlpha(d) * deep],
            material: { ambient: 0.6, diffuse: 0.5, shininess: 16 },
            pickable: true,
            extensions: FOG,
            beforeId,
            updateTriggers: { getFillColor: [...look, deep], getLineColor: [...look, deep] }
          }),
          real && show.trains && new IconLayer({ ...trainGlow, id: `trains-glow${tag}`, data: fleet, beforeId }),
          real && show.trains && new IconLayer({ ...trainArrow, id: `trains-arrow${tag}`, data: fleet, beforeId }),
          real && show.trains && new ScatterplotLayer({ ...trainDot, id: `trains${tag}`, data: fleet, beforeId }),
          real && state.fonts && show.trains && zoom >= 13.6 && fleet.length > 0 && new TextLayer({ ...trainLabel, id: `train-labels${tag}`, data: fleet, beforeId })
        ]),
        ...(route ? routeGroups : []).flatMap(([runs, , beforeId, tag]) => [
          new PathLayer({
            id: `trip-glow${tag}`,
            data: runs,
            getPath: d => d.path,
            getColor: dark ? [...routeColor, 70] : [255, 255, 255, 255],
            widthScale: Math.max(w, 2.4) * (dark ? 6 : 2.6),
            parameters: glowTop,
            extensions: THIN,
            beforeId,
            ...LINE
          }),
          new PathLayer({
            id: `trip-line${tag}`,
            data: runs,
            getPath: d => d.path,
            getColor: routeColor,
            widthScale: Math.max(w, 2.4) * 2,
            extensions: THIN,
            beforeId,
            ...LINE,
            parameters: real ? PIN : TOP
          }),
          route.kind === 'trip' && new TripsLayer({
            id: `trip-trail${tag}`,
            data: runs,
            getPath: d => d.path,
            getTimestamps: d => d.values,
            getColor: [255, 255, 255, 230],
            widthScale: Math.max(w, 2.4) * 1.2,
            currentTime: (now / 4000 % 1) * 1.3,
            trailLength: 0.3,
            fadeTrail: true,
            parameters: glowTop,
            extensions: THIN,
            beforeId,
            ...LINE
          })
        ]),
        below && new SolidPolygonLayer({
          id: 'veil',
          data: VEIL,
          getPolygon: d => d,
          getFillColor: [...theme.bg, 255 * veil],
          parameters: GLASS,
          beforeId: below
        }),
        show.trains && dwelling.length > 0 && new ScatterplotLayer({
          id: 'dwell',
          data: dwelling,
          getPosition: d => d.position,
          billboard: true,
          radiusUnits: 'pixels',
          getRadius: d => stationSize * (d.stop.big ? 1 : 0.6) * (grows.get(d.stop.id) ?? 1) + 3.5 + d.ring * 3,
          filled: false,
          stroked: true,
          lineWidthUnits: 'pixels',
          getLineWidth: 2,
          getLineColor: d => [...colors.get(d.line), 255 * trainAlpha(d)],
          pickable: true,
          parameters: TOP,
          extensions: FOG,
          updateTriggers: { getRadius: [stationSize, grows], getLineColor: look }
        }),
        new ScatterplotLayer({
          id: 'stations',
          data: dots,
          getPosition: d => [d.lon, d.lat, rise(d)],
          billboard: true,
          radiusUnits: 'pixels',
          radiusScale: stationSize,
          getRadius: d => (d.big ? 1 : 0.6) * (grows.get(d.id) ?? 1),
          stroked: true,
          lineWidthUnits: 'pixels',
          getLineWidth: 1.6,
          getFillColor: d => [...(d.big ? [255, 255, 255] : d.color), 255 * stationAlpha(d)],
          getLineColor: d => [...(d.big ? theme.ring : theme.bg), 255 * stationAlpha(d)],
          pickable: true,
          parameters: TOP,
          extensions: FOG,
          updateTriggers: { getPosition: [gap, exag, beneath], getRadius: grows, getFillColor: look, getLineColor: look }
        }),
        ...(route ? routeGroups : []).map(([, stops, beforeId, tag]) => new ScatterplotLayer({
          id: `trip-stops${tag}`,
          data: stops,
          getPosition: d => d.position,
          billboard: true,
          radiusUnits: 'pixels',
          getRadius: d => d.now ? w * 1.3 + 5 : w * 0.9 + 1.6,
          stroked: true,
          lineWidthUnits: 'pixels',
          getLineWidth: d => d.now ? 2.5 : w * 0.5 + 0.6,
          getFillColor: d => d.now ? routeColor : [255, 255, 255],
          getLineColor: d => d.now ? [255, 255, 255] : routeColor,
          parameters: real ? PIN : TOP,
          extensions: FOG,
          beforeId,
          updateTriggers: { getRadius: w, getLineWidth: w, getFillColor: route, getLineColor: route }
        })),
        grounds.length > 0 && new ScatterplotLayer({
          id: 'ground-rings',
          data: grounds,
          getPosition: d => d.position,
          radiusUnits: 'pixels',
          getRadius: d => d.radius,
          filled: false,
          stroked: true,
          lineWidthUnits: 'pixels',
          getLineWidth: d => d.width,
          getLineColor: d => d.color,
          parameters: TOP
        }),
        rings.length > 0 && new ScatterplotLayer({
          id: 'rings',
          data: rings,
          getPosition: d => d.position,
          billboard: true,
          radiusUnits: 'pixels',
          getRadius: d => d.radius,
          filled: false,
          stroked: true,
          lineWidthUnits: 'pixels',
          getLineWidth: d => d.width,
          getLineColor: d => d.color,
          parameters: TOP
        }),
        !real && show.trains && new IconLayer({ ...trainGlow, id: 'trains-glow', data: trains }),
        !real && show.trains && new IconLayer({ ...trainArrow, id: 'trains-arrow', data: trains }),
        !real && show.trains && new ScatterplotLayer({ ...trainDot, id: 'trains', data: trains }),
        state.fonts && new TextLayer({
          id: 'labels',
          data: placed,
          fontFamily: FONT,
          fontWeight: 500,
          characterSet: 'auto',
          fontSettings: SDF,
          outlineWidth: 8,
          outlineColor: [...theme.bg, 255],
          getText: d => d.name,
          getPosition: d => [d.lon, d.lat, labelZ(d)],
          getColor: d => [...theme.text, 255 * (d.focus ? 1 : stationAlpha(d))],
          getSize: d => (d.big || d.focus ? 1 : 0.9) * d.grow,
          sizeScale: labelSize,
          getTextAnchor: d => ['end', 'middle', 'start'][d.h + 1],
          getAlignmentBaseline: d => ['bottom', 'center', 'top'][d.v + 1],
          getPixelOffset: d => {
            const r = stationSize * (d.big ? 1 : 0.6)
            return (d.h && d.v ? [d.h * (r + 3), d.v * (r + 2)] : [d.h * (r + 5), d.v * (r + 3)]).map(offset => offset * d.grow)
          },
          parameters: TOP,
          extensions: FOG,
          updateTriggers: { getColor: look, getPixelOffset: stationSize }
        }),
        !real && state.fonts && show.trains && zoom >= 13.6 && trains.length > 0 && new TextLayer({ ...trainLabel, id: 'train-labels', data: trains }),
        state.fonts && !flat && !real && new TextLayer({
          id: 'level-tags',
          data: tags,
          fontFamily: FONT,
          fontWeight: 600,
          characterSet: 'auto',
          fontSettings: SDF,
          outlineWidth: 7,
          outlineColor: [...theme.bg, 255],
          getText: d => d.text,
          getPosition: d => [...d.position, z[d.product]],
          getColor: d => [...(d.product === 'city' ? theme.muted : theme[d.product]), 235 * levelAlpha(d.product)],
          getSize: 11,
          getTextAnchor: 'start',
          getAlignmentBaseline: 'bottom',
          getPixelOffset: [8, -6],
          parameters: TOP,
          updateTriggers: { getPosition: gap, getColor: look }
        })
      ]
    })
  }

  const pick = point => {
    if (!ready) return []
    const kinds = { stations: 'stations', platforms: 'stations', 'platforms-under': 'stations', trains: 'trains', 'trains-under': 'trains', dwell: 'trains', network: 'network', 'network-under': 'network' }
    const hits = overlay.pickMultipleObjects({ x: point.x, y: point.y, radius: TOUCH ? 12 : 6, depth: 4, layerIds: Object.keys(kinds) })
    return ['stations', 'trains', 'network'].flatMap(id => hits.filter(hit => kinds[hit.layer?.id] === id).map(hit => ({ layer: { id }, properties: hit.object })))
  }

  return { paint, render, pick }
}
