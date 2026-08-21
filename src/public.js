/**
 * public.js — MODO PÚBLICO del node (DISENO.md §7.2 y §7.3). APAGADO por defecto.
 *
 * Es la única puerta por la que los bytes de este node salen a internet sin pasar
 * por una app del ecosistema, y existe para UNA cosa: que un enlace compartido
 * tenga **vista previa** (la tarjeta de X, LinkedIn, WhatsApp, Telegram…). El
 * contenido de verdad sigue viajando por el camino de siempre — app + `#fragment`
 * + transporte P2P—, donde el servidor nunca ve la referencia.
 *
 * Cuatro cerrojos, y ninguno es decorativo:
 *
 *  1. **ACL:** solo sale lo marcado `public` y EN CLARO. Lo cifrado no sale ni
 *     aunque alguien le ponga `public` a mano en el índice (`node.publicStat`).
 *  1b. **SOLO IMÁGENES, y de mapa de bits.** Es lo único que una vista previa
 *     necesita, y de paso cierra de golpe todo lo demás: nada de HTML, PDF,
 *     vídeo ni archivos comprimidos saliendo de tu máquina. **El SVG queda
 *     fuera a propósito**: es un documento que ejecuta scripts, así que servirlo
 *     desde tu dominio es regalarle un origen a quien lo suba. Y el tipo NO se
 *     cree: el `mime` lo declara quien sube, así que se comprueban los BYTES
 *     MÁGICOS del archivo antes de mandarlo (`sniffImage`).
 *  2. **TOPE DE TAMAÑO (`maxBytes`, 512 KB por defecto):** es lo que convierte
 *     esto en «un servidor de miniaturas» en vez de «un CDN gratis». Una
 *     miniatura pesa decenas de KB; un original, megas. Con el tope puesto, el
 *     hotlinking —que es el modo natural en que esta puerta te cuesta dinero—
 *     deja de importar. `maxBytes: 0` lo quita, y es una decisión del dueño.
 *  3. **Límite por IP:** cubeta por minuto, para que un bucle ajeno no te use de
 *     origen.
 *  4. **TECHO DE EGRESS DIARIO, persistido:** al pasarse, corta con 503. Se
 *     guarda en el índice y no en memoria a propósito: un techo que se reinicia
 *     con el proceso no es un techo.
 *
 * Rutas (y no hay más):
 *   GET|HEAD /c/<cid>   los bytes, si pasan los cuatro cerrojos (Range/206, ETag)
 *   GET      /p/<cid>   permalink: HTML con las etiquetas OG de la tarjeta
 *   GET      /robots.txt  Disallow: / (ver abajo)
 *   GET      /health    vivo + uso del techo, sin decir qué guarda
 *
 * `robots.txt` prohíbe TODO a propósito. Las tarjetas sociales funcionan igual
 * (los rastreadores de redes piden la página cuando alguien pega el enlace, no
 * indexan), y la norma del ecosistema es que el contenido del usuario no se
 * indexa (CLAUDE.md §SEO). Se puede levantar con `index: true`, que es lo que
 * haría la cuenta oficial para su contenido público, y de nadie más.
 */
import http from 'node:http'
import { open as openFile } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { isValidCid } from './node.js'

export const DEFAULT_PUBLIC_PORT = 3778
/** Tope por blob: lo que hace que esto sirva previsualizaciones y no originales. */
export const DEFAULT_MAX_BYTES = 512 * 1024
/** Cubeta por IP y minuto. */
export const DEFAULT_RATE_PER_MIN = 60

/**
 * Lo único que sale por el puerto público: imágenes de mapa de bits. Cada entrada
 * lleva su firma en los primeros bytes, porque el `mime` del índice es lo que
 * DIJO quien subió, y aquí no se cree nada que no se pueda comprobar.
 */
const IMAGE_TYPES = [
  { mime: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/png', test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { mime: 'image/gif', test: (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 },
  // RIFF....WEBP
  { mime: 'image/webp', test: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
  // ....ftypavif  (caja ISO-BMFF)
  { mime: 'image/avif', test: (b) => b.subarray(4, 8).toString('latin1') === 'ftyp' && b.subarray(8, 12).toString('latin1').startsWith('avif') }
]

export const PUBLIC_MIMES = Object.freeze(IMAGE_TYPES.map((t) => t.mime))

/**
 * Lee los primeros bytes del blob y devuelve el tipo REAL, o null si no es una
 * imagen de las admitidas. Es lo que se sirve como `content-type`: si alguien
 * subió un HTML diciendo que era un PNG, aquí no pasa.
 * @returns {Promise<string|null>}
 */
export async function sniffImage (path) {
  let fh
  try {
    fh = await openFile(path, 'r')
    const buf = Buffer.alloc(16)
    const { bytesRead } = await fh.read(buf, 0, 16, 0)
    if (bytesRead < 12) return null
    return IMAGE_TYPES.find((t) => t.test(buf))?.mime || null
  } catch {
    return null
  } finally {
    await fh?.close().catch(() => {})
  }
}

/** Día UTC (clave del techo de egress). */
export const utcDay = (now = Date.now()) => new Date(now).toISOString().slice(0, 10)

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;')

const text = (res, code, body, extra = {}) =>
  res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8', ...extra }).end(body)

const json = (res, code, obj) =>
  res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(obj))

/** Cubeta por IP: N peticiones por minuto, ventana deslizante gruesa (por minuto). */
export class RateLimiter {
  constructor (perMinute = DEFAULT_RATE_PER_MIN) {
    this.perMinute = perMinute
    this.window = 0
    this.hits = new Map()
  }

  /** @returns {boolean} true si la petición pasa. */
  allow (ip, now = Date.now()) {
    if (!this.perMinute) return true
    const w = Math.floor(now / 60_000)
    if (w !== this.window) { this.window = w; this.hits.clear() }
    const n = (this.hits.get(ip) || 0) + 1
    this.hits.set(ip, n)
    return n <= this.perMinute
  }
}

/** IP del cliente, respetando un proxy inverso delante (nginx/Caddy/Cloudflare). */
export function clientIp (req) {
  const fwd = req.headers['x-forwarded-for']
  if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim()
  return req.socket?.remoteAddress || '?'
}

/** Base pública absoluta (para las URLs de las etiquetas OG). */
function baseUrl (req, configured) {
  if (configured) return configured.replace(/\/+$/, '')
  const proto = (req.headers['x-forwarded-proto'] || 'http').toString().split(',')[0].trim()
  const host = req.headers.host || 'localhost'
  return `${proto}://${host}`
}

const parseMeta = (row) => {
  if (!row?.meta) return {}
  try { return JSON.parse(row.meta) || {} } catch { return {} }
}

/**
 * Página del permalink (§7.3). Es una tarjeta y un enlace, y se dice así: no
 * pretende ser un visor. Lleva la imagen solo si el propio blob es una imagen o
 * si tiene una miniatura pública enlazada (`thumbnailCid`).
 */
export function previewHtml ({ cid, row, base, appUrl, owner, index, imageCid = null }) {
  const m = parseMeta(row)
  const title = m.title || m.name || 'Contenido compartido'
  // La imagen de la tarjeta la decide la ruta, que es quien pudo COMPROBAR que
  // ese cid es una imagen de verdad y que sale por el puerto. Aquí solo se pinta.
  const image = imageCid ? `${base}/c/${imageCid}` : null
  const kb = Math.max(1, Math.round(row.size / 1024))
  const desc = m.description || `${row.mime} · ${kb} KB`
  // El enlace de "abrir" lleva la referencia en el #fragment: el servidor de la
  // app nunca la ve (CLAUDE.md §SEO). Sin `owner` no hay referencia que armar.
  const open = owner ? `${appUrl.replace(/\/+$/, '')}/#${owner}/${cid}` : null
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="robots" content="${index ? 'index, follow' : 'noindex, nofollow'}">
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${esc(base)}/p/${cid}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Dotrino">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(base)}/p/${cid}">
${image ? `<meta property="og:image" content="${esc(image)}">` : ''}
<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(desc)}">
${image ? `<meta name="twitter:image" content="${esc(image)}">` : ''}
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         background: #0e1116; color: #e8ecf1; font: 16px/1.5 system-ui, sans-serif;
         padding: max(1rem, env(safe-area-inset-top)) 1rem; }
  main { max-width: 34rem; text-align: center; }
  img { max-width: 100%; height: auto; border-radius: .75rem; }
  h1 { font-size: 1.25rem; margin: 1rem 0 .25rem; }
  p { color: #9aa7b4; margin: .25rem 0 1.25rem; }
  a.open { display: inline-block; background: #2f6bff; color: #fff; text-decoration: none;
           padding: .7rem 1.4rem; border-radius: .6rem; font-weight: 600; }
  small { display: block; margin-top: 1.5rem; color: #6b7787; }
  small a { color: #6b7787; }
</style>
</head>
<body>
<main>
${image ? `<img src="${esc(image)}" alt="${esc(title)}">` : ''}
<h1>${esc(title)}</h1>
<p>${esc(desc)}</p>
${open ? `<a class="open" href="${esc(open)}">Abrir</a>` : ''}
<small>Servido desde el node de su dueño · <a href="https://content.dotrino.com/">Dotrino</a></small>
</main>
</body>
</html>`
}

/**
 * Servidor del modo público.
 *
 * @param {import('./node.js').ContentNode} node
 * @param {{
 *   maxBytes?: number, ratePerMin?: number, maxEgressBytes?: number,
 *   publicUrl?: string|null, appUrl?: string, index?: boolean, owner?: string|null,
 *   quiet?: boolean
 * }} [opts]
 */
export function createPublicServer (node, opts = {}) {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
  const maxEgressBytes = opts.maxEgressBytes || 0
  const appUrl = opts.appUrl || 'https://eco.dotrino.com/'
  const limiter = new RateLimiter(opts.ratePerMin ?? DEFAULT_RATE_PER_MIN)

  /** ¿Queda techo de egress para hoy? */
  const egressLeft = () => {
    if (!maxEgressBytes) return Infinity
    return maxEgressBytes - node.index.egressOn(utcDay())
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (!limiter.allow(clientIp(req))) return text(res, 429, 'demasiadas peticiones\n', { 'retry-after': '60' })
      await route(req, res)
    } catch (err) {
      if (res.headersSent) { res.destroy(); return }
      text(res, 500, 'error\n')
      if (!opts.quiet) console.error('[content:public]', err.message)
    }
  })

  async function route (req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return text(res, 405, 'método no permitido\n')
    const url = new URL(req.url, 'http://localhost')
    const [, top, cid] = url.pathname.split('/')

    if (url.pathname === '/robots.txt') {
      return text(res, 200, opts.index ? 'User-agent: *\nAllow: /p/\nDisallow: /c/\n' : 'User-agent: *\nDisallow: /\n')
    }
    if (url.pathname === '/health') {
      const used = maxEgressBytes ? node.index.egressOn(utcDay()) : 0
      return json(res, 200, { ok: true, egressToday: used, maxEgressBytes: maxEgressBytes || null })
    }

    if ((top === 'c' || top === 'p') && cid) {
      if (!isValidCid(cid)) return text(res, 400, 'cid inválido\n')
      // 404 y no 403 para lo privado: un 403 confirmaría que ese cid existe aquí.
      const row = node.publicStat(cid)
      if (!row) return text(res, 404, 'no disponible\n')

      if (top === 'p') {
        const body = previewHtml({
          cid, row, imageCid: await pickImage(cid, row),
          base: baseUrl(req, opts.publicUrl), appUrl, owner: opts.owner ?? node.owner, index: !!opts.index
        })
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'public, max-age=3600',
          'x-robots-tag': opts.index ? 'all' : 'noindex, nofollow'
        })
        return res.end(req.method === 'HEAD' ? undefined : body)
      }

      // --- bytes ---
      // El tipo REAL, sacado del archivo. `row.mime` no decide nada aquí.
      const kind = await sniffImage(node.store.pathFor(cid))
      if (!kind) return text(res, 404, 'no disponible\n')
      if (maxBytes && row.size > maxBytes) {
        // No es un error del que pide: es la política del node. Se dice cuál es.
        return text(res, 413, 'este node solo publica vistas previas; el contenido se abre en la app\n')
      }
      const headers = {
        'content-type': kind,
        etag: `"${cid}"`,
        'cache-control': 'public, max-age=31536000, immutable',
        'accept-ranges': 'bytes',
        'x-content-type-options': 'nosniff',
        'x-robots-tag': 'noindex',
        // El blob es de otro dominio y lo pide una app del ecosistema: sin CORS
        // el <img>/fetch de la app no lo puede leer.
        'access-control-allow-origin': '*'
      }
      if (req.headers['if-none-match'] === `"${cid}"`) return res.writeHead(304, headers).end()

      const range = parseRangeHeader(req.headers.range, row.size)
      if (range === false) return res.writeHead(416, { 'content-range': `bytes */${row.size}` }).end()
      const sending = range ? range.end - range.start + 1 : row.size
      // El techo se mira contra lo que ESTA respuesta va a mandar, no contra cero:
      // dejar entrar una petición porque "aún quedan 10 bytes" es rebasarlo igual,
      // solo que fingiendo que no. Un HEAD no manda cuerpo, así que no gasta.
      if (req.method === 'GET' && egressLeft() < sending) {
        return text(res, 503, 'techo de salida diario alcanzado\n', { 'retry-after': '3600' })
      }
      if (range) {
        headers['content-range'] = `bytes ${range.start}-${range.end}/${row.size}`
        headers['content-length'] = sending
        res.writeHead(206, headers)
      } else {
        headers['content-length'] = sending
        res.writeHead(200, headers)
      }
      if (req.method === 'HEAD') return res.end()
      // Se contabiliza lo que de verdad sale por el socket, no lo que se prometió:
      // una descarga abortada a la mitad no debe gastar el techo entero.
      let sent = 0
      res.on('close', () => { if (maxEgressBytes && sent) node.index.addEgress(sent, utcDay()) })
      const src = node.read(cid, range ?? undefined)
      src.on('data', (c) => { sent += c.length })
      await pipeline(src, res)
      return
    }

    return text(res, 404, 'no disponible\n')
  }

  /**
   * Qué imagen lleva la tarjeta: el propio blob si es una imagen servible, y si
   * no su miniatura (`thumbnailCid`), que tiene que ser pública por su cuenta —
   * enlazar una miniatura no la vuelve pública, la publica su dueño.
   * @returns {Promise<string|null>}
   */
  async function pickImage (cid, row) {
    for (const candidate of [{ cid, row }, row.thumbnailCid ? { cid: row.thumbnailCid, row: node.publicStat(row.thumbnailCid) } : null]) {
      if (!candidate?.row) continue
      if (maxBytes && candidate.row.size > maxBytes) continue
      if (await sniffImage(node.store.pathFor(candidate.cid))) return candidate.cid
    }
    return null
  }

  return server
}

/** Igual que el del servidor local; duplicado mínimo para no acoplar los dos. */
function parseRangeHeader (header, size) {
  if (!header) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim())
  if (!m || (m[1] === '' && m[2] === '')) return false
  let start, end
  if (m[1] === '') {
    const n = Number(m[2])
    if (n === 0) return false
    start = Math.max(0, size - n); end = size - 1
  } else {
    start = Number(m[1]); end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1)
  }
  if (start >= size || start > end) return false
  return { start, end }
}

export default { createPublicServer, RateLimiter, previewHtml, utcDay, DEFAULT_PUBLIC_PORT, DEFAULT_MAX_BYTES }
