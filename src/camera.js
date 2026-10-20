const TOUCH = matchMedia('(pointer: coarse)').matches
const STEPS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }
const DETENT = 85
const DEEP = 150

export const createCamera = (map, state, views) => {
  const [tilt, compass, help, gestures, hint, legend, legendToggle] = ['tilt', 'compass', 'help', 'gestures', 'hint', 'legend', 'legend-toggle'].map(id => document.getElementById(id))
  const container = map.getContainer()
  const three = () => state.mode === '3d'
  const pitch = value => Math.min(map.getMaxPitch(), Math.max(0, value))
  const free = () => state.real && map.getMaxPitch() < DEEP && map.setMaxPitch(DEEP)
  let kind = null
  let wheelAt = 0
  let pinchAt = 0
  let gesture = null
  let drag = null
  let dragged = false
  let centered = false
  let push = 0
  let touchY = null
  const overshoot = delta => {
    push = map.getPitch() >= DETENT - 0.5 ? Math.max(0, push + delta) : 0
    if (push > 90) free()
  }

  const deepen = () => Object.defineProperty(map.transform, 'minElevationForCurrentTile', { configurable: true, get: () => -60 })
  deepen()
  map.on('style.load', deepen)
  map.keyboard.disable()
  map._elevateCameraIfInsideTerrain = () => ({})
  for (const type of ['mousedown', 'touchstart']) container.addEventListener(type, () => map.getPitch() >= DETENT - 1 && free(), { capture: true, passive: true })
  map.on('moveend', () => map.getPitch() < DETENT - 5 && map.getMaxPitch() > DETENT && map.setMaxPitch(DETENT))

  container.addEventListener('mousemove', event => {
    if (event.buttons & 2 || (event.buttons & 1 && event.ctrlKey)) overshoot(-event.movementY)
  }, { passive: true })
  container.addEventListener('touchmove', event => {
    const y = event.touches.length === 2 ? (event.touches[0].clientY + event.touches[1].clientY) / 2 : null
    if (y != null && touchY != null) overshoot(touchY - y)
    touchY = y
  }, { passive: true })

  container.addEventListener('wheel', event => {
    if (event.target.closest('.maplibregl-control-container')) return
    const now = performance.now()
    if (event.ctrlKey) {
      pinchAt = now
      return
    }
    if (now - wheelAt > 250) kind = event.deltaMode !== 0 || (event.deltaY !== 0 && event.deltaY % 4.000244140625 === 0) || (event.deltaX === 0 && Number.isInteger(event.deltaY) && Math.abs(event.deltaY) >= 50) ? 'zoom' : 'pan'
    wheelAt = now
    if ((kind === 'zoom' && !event.shiftKey) || (event.shiftKey && !three())) return
    event.preventDefault()
    event.stopImmediatePropagation()
    if (!event.shiftKey && map.getPitch() < 75) map.panBy([event.deltaX, event.deltaY], { duration: 0 })
    else if (!event.shiftKey) {
      const { lng, lat } = map.getCenter()
      const [bearing, meters] = [map.getBearing() * Math.PI / 180, 40075016 * Math.cos(lat * Math.PI / 180) / (512 * 2 ** map.getZoom())]
      const [east, north] = [(event.deltaX * Math.cos(bearing) - event.deltaY * Math.sin(bearing)) * meters, (-event.deltaX * Math.sin(bearing) - event.deltaY * Math.cos(bearing)) * meters]
      map.jumpTo({ center: [lng + east / (111320 * Math.cos(lat * Math.PI / 180)), lat + north / 110574] })
    } else if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) map.jumpTo({ bearing: map.getBearing() - event.deltaX * 0.3 })
    else {
      const step = Math.max(-6, Math.min(6, event.deltaY * 0.25))
      overshoot(step * 4)
      map.jumpTo({ pitch: pitch(map.getPitch() + step) })
    }
  }, { capture: true, passive: false })

  if (!TOUCH) {
    container.addEventListener('gesturestart', event => {
      event.preventDefault()
      gesture = { bearing: map.getBearing(), zoom: map.getZoom(), at: performance.now() }
    })
    container.addEventListener('gesturechange', event => {
      event.preventDefault()
      if (!gesture) return
      map.jumpTo({ ...(three() && { bearing: gesture.bearing - event.rotation }), ...(pinchAt < gesture.at && { zoom: gesture.zoom + Math.log2(event.scale) }) })
    })
    container.addEventListener('gestureend', () => { gesture = null })
  }

  addEventListener('keydown', event => {
    if (event.key === 'Escape' && !gestures.hidden) {
      gestures.hidden = true
      help.setAttribute('aria-expanded', 'false')
      event.stopImmediatePropagation()
      return
    }
    if (!(event.target === document.body || container.contains(event.target)) || event.target.matches('input') || event.altKey || event.ctrlKey || event.metaKey) return
    const step = STEPS[event.key]
    if (step?.[1] < 0 && event.shiftKey && map.getPitch() >= DETENT - 1) free()
    if (step && event.shiftKey && three()) map.easeTo({ bearing: map.getBearing() + step[0] * 15, pitch: pitch(map.getPitch() - step[1] * 10), duration: 300 })
    else if (step && !event.shiftKey) map.panBy([step[0] * 120, step[1] * 120], { duration: 300 })
    else if (event.key === '+' || event.key === '=') map.zoomIn()
    else if (event.key === '-' || event.key === '_') map.zoomOut()
    else return
    event.preventDefault()
  })

  compass.addEventListener('pointerdown', event => {
    drag = { x: event.clientX, y: event.clientY }
    dragged = false
    compass.setPointerCapture(event.pointerId)
  })
  compass.addEventListener('pointermove', event => {
    if (!drag) return
    dragged ||= Math.hypot(event.clientX - drag.x, event.clientY - drag.y) > 3
    if (!dragged) return
    overshoot(-event.movementY)
    map.jumpTo({ bearing: map.getBearing() - event.movementX * 0.8, pitch: pitch(map.getPitch() - event.movementY * 0.6) })
  })
  for (const type of ['pointerup', 'pointercancel']) compass.addEventListener(type, () => { drag = null })
  compass.addEventListener('click', () => {
    if (!dragged) map.easeTo({ bearing: 0, duration: 500 })
    dragged = false
  })

  tilt.addEventListener('input', () => {
    if (Number(tilt.value) > map.getMaxPitch()) free()
    map.jumpTo({ pitch: Number(tilt.value) })
  })

  for (const button of document.querySelectorAll('[data-zoom]')) {
    button.addEventListener('click', () => (button.dataset.zoom === '1' ? map.zoomIn() : map.zoomOut()))
  }
  for (const button of document.querySelectorAll('[data-view]')) {
    button.addEventListener('click', () => {
      const view = views[button.dataset.view]()
      if (view.pitch > map.getMaxPitch()) free()
      map.easeTo({ ...view, duration: button.dataset.view === 'under' ? 1600 : 900 })
    })
  }

  help.addEventListener('click', () => {
    gestures.hidden = !gestures.hidden
    help.setAttribute('aria-expanded', !gestures.hidden)
    hint.hidden = true
    if (!gestures.hidden && legend.classList.contains('open')) legendToggle.click()
  })
  addEventListener('pointerdown', event => {
    if (!gestures.hidden && !event.target.closest('#gestures, #help')) {
      gestures.hidden = true
      help.setAttribute('aria-expanded', 'false')
    }
  })

  const sync = () => {
    if (centered !== map.getPitch() > 75) {
      centered = !centered
      map.scrollZoom.disable()
      map.scrollZoom.enable(centered && { around: 'center' })
      map.touchZoomRotate.enable(centered && { around: 'center' })
    }
    compass.style.setProperty('--bearing', `${-map.getBearing()}deg`)
    compass.style.setProperty('--pitch', `${Math.min(map.getPitch(), 75)}deg`)
    tilt.max = state.real ? DEEP : DETENT
    tilt.value = map.getPitch()
  }
  map.on('move', sync)
  sync()

  const intro = () => {
    try {
      if (localStorage.getItem('hint')) return
      localStorage.setItem('hint', '1')
    } catch {}
    hint.hidden = false
    const close = () => { hint.hidden = true }
    setTimeout(close, 12000)
    for (const type of ['pointerdown', 'wheel', 'keydown']) container.addEventListener(type, close, { once: true, passive: true })
  }

  return { intro, sync }
}
