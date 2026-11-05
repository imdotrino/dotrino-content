// La ventana de la biblioteca: lista, reproduce, abre con otro programa, guarda y borra.
/**
 * Un elemento de la biblioteca, como lo da `/api/library` (src/library.js).
 * @typedef {{ id: string, name: string, createdAt: number, durationMs?: number, size: number, format?: string }} Item
 */
/** @typedef {'es' | 'en'} Lang */
/** @typedef {keyof typeof TEXT.es} TextKey */

const TEXT = {
  es: {
    empty: 'Todavía no hay nada aquí. Lo que subas desde la Grabadora aparecerá en esta lista.',
    play: 'Reproducir', open: 'Abrir con otro programa', save: 'Guardar', remove: 'Borrar de aquí',
    confirm: '¿Seguro? Toca otra vez', loadFail: 'No se pudo leer la biblioteca: {e}',
    openFail: 'No se pudo abrir: {e}', removeFail: 'No se pudo borrar: {e}',
    problem: 'Hay {n} elemento(s) que este equipo no puede abrir: {e}', unknown: 'duración desconocida'
  },
  en: {
    empty: 'Nothing here yet. What you upload from Recorder will show up in this list.',
    play: 'Play', open: 'Open with another program', save: 'Save', remove: 'Delete from here',
    confirm: 'Sure? Tap again', loadFail: 'Could not read the library: {e}',
    openFail: 'Could not open it: {e}', removeFail: 'Could not delete it: {e}',
    problem: '{n} item(s) cannot be opened on this computer: {e}', unknown: 'unknown length'
  }
}
const stored = () => { try { return localStorage.getItem('dotrino-lang') } catch (_) { return null } }
/** @param {unknown} l @returns {l is Lang} */
const isLang = (l) => l === 'es' || l === 'en'
const saved = stored() || (navigator.language.startsWith('es') ? 'es' : 'en')
/** @type {Lang} */
let lang = isLang(saved) ? saved : 'en'
/**
 * @param {TextKey} k
 * @param {Record<string, unknown>} [v]
 */
const t = (k, v = {}) => TEXT[lang][k].replace(/\{(\w+)\}/g, (_, x) => String(v[x]))

/**
 * Un elemento de la página (index.html los trae todos).
 * @param {string} id
 * @returns {HTMLElement}
 */
const $ = (id) => {
  const el = document.getElementById(id)
  if (!el) throw new Error(`the page has no #${id}`)
  return el
}
const audio = () => /** @type {HTMLAudioElement} */ ($('audio'))
/** @type {Item[]} */
let items = []
/** @type {{ error: string }[]} */
let problems = []
/** @type {string | null} */
let playing = null

/** @param {string} text */
const showError = (text) => { $('msg').textContent = text; $('msg').hidden = !text }

/** @param {number} n */
function fmtSize (n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + ' GB'
  if (n >= 1e6) return (n / 1e6).toFixed(1) + ' MB'
  return Math.ceil(n / 1e3) + ' KB'
}
/** @param {number | undefined} ms */
function fmtTime (ms) {
  if (ms === undefined || !(ms >= 0)) return t('unknown')
  const s = Math.round(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = String(Math.floor(s / 60) % 60)
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${m.padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

/**
 * @param {string} label
 * @param {string} cls
 * @param {string} testid
 * @param {() => unknown} fn
 */
function button (label, cls, testid, fn) {
  const b = document.createElement('button')
  b.textContent = label
  b.className = cls
  b.dataset.testid = testid
  b.onclick = fn
  return b
}

/** @param {Item} it */
function play (it) {
  playing = it.id
  $('player').hidden = false
  $('now').textContent = it.name
  audio().src = `/media/${encodeURIComponent(it.id)}`
  audio().play().catch((e) => { if (e.name !== 'AbortError') showError(t('openFail', { e: e.message })) })
  render()
}

/**
 * @param {string} path
 * @param {string} method
 * @param {TextKey} failKey
 */
async function call (path, method, failKey) {
  showError('')
  const res = await fetch(path, { method })
  if (res.ok) return true
  const body = await res.json().catch(() => ({}))
  showError(t(failKey, { e: body.error || body.code || res.status }))
  return false
}

/** @param {Item} it */
function row (it) {
  const el = document.createElement('div')
  el.className = 'row' + (it.id === playing ? ' on' : '')
  el.dataset.itemId = it.id
  const info = document.createElement('div')
  info.className = 'info'
  const name = document.createElement('div')
  name.className = 'name'
  name.textContent = it.name
  const sub = document.createElement('div')
  sub.className = 'sub'
  sub.textContent = [new Date(it.createdAt).toLocaleString(lang), fmtTime(it.durationMs), fmtSize(it.size), it.format].filter(Boolean).join(' · ')
  info.append(name, sub)
  const acts = document.createElement('div')
  acts.className = 'acts'
  const save = document.createElement('a')
  save.className = 'btn'
  save.textContent = t('save')
  save.href = `/media/${encodeURIComponent(it.id)}?download=1`
  save.dataset.testid = 'save'
  const del = button(t('remove'), 'danger', 'remove', async () => {
    if (del.dataset.armed !== '1') { del.dataset.armed = '1'; del.textContent = t('confirm'); return }
    if (it.id === playing) { audio().pause(); audio().removeAttribute('src'); $('player').hidden = true; playing = null }
    if (await call(`/api/${encodeURIComponent(it.id)}`, 'DELETE', 'removeFail')) await load()
  })
  acts.append(
    button(t('play'), 'main', 'play', () => play(it)),
    button(t('open'), '', 'open', () => call(`/api/${encodeURIComponent(it.id)}/open`, 'POST', 'openFail')),
    save, del)
  el.append(info, acts)
  return el
}

function render () {
  $('list').replaceChildren(...items.map(row))
  $('empty').hidden = items.length > 0 || problems.length > 0
  $('empty').textContent = t('empty')
  if (problems.length) showError(t('problem', { n: problems.length, e: problems[0].error }))
}

async function load () {
  const res = await fetch('/api/library')
  const body = await res.json().catch(() => ({}))
  if (!res.ok) { showError(t('loadFail', { e: body.error || body.code || res.status })); return }
  items = body.items
  problems = body.problems
  render()
}

const topbar = document.querySelector('dotrino-topbar')
if (!topbar) throw new Error('the page has no <dotrino-topbar>')
topbar.addEventListener('dotrino-lang', (e) => {
  const detail = /** @type {CustomEvent<{ lang?: string } | string>} */ (e).detail
  const next = (typeof detail === 'object' && detail?.lang) || detail
  if (isLang(next)) { lang = next; document.documentElement.lang = next; render() }
})
document.documentElement.lang = lang
load()
setInterval(load, 15000)
