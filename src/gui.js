/**
 * LA VENTANA DE LA BIBLIOTECA: un servidor web en loopback para abrir en esta máquina lo que
 * subieron tus aparatos (`dotrino-content gui` la abre en el navegador).
 *
 * Sirve bytes EN CLARO, así que no puede ser como el HTTP de administración, que solo guarda
 * cifrado. Cualquier página que tengas abierta puede pedirle cosas a 127.0.0.1, y por eso:
 *
 *  · **Una llave por arranque**, en un archivo que solo lee tu usuario. Quien la presenta recibe
 *    una cookie `HttpOnly` + `SameSite=Strict`, que una web ajena no manda.
 *  · **El `Host` tiene que ser loopback**, para cerrar el rebinding de DNS.
 *  · **Lo que cambia algo exige `Origin` propio.**
 */
import { spawn } from 'node:child_process'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createWriteStream, readFileSync, writeFileSync } from 'node:fs'
import { chmod, mkdir, rm } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { parseRange } from './range.js'

export const DEFAULT_GUI_PORT = 3779
const COOKIE = 'dotrino_content_gui'
/** @type {Record<string, [string, string]>} */
const ASSETS = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8']
}
const CDN = 'https://cdn.jsdelivr.net'
const CSP = `default-src 'none'; script-src 'self' ${CDN}; style-src 'self' 'unsafe-inline' ${CDN}; font-src ${CDN} data:; ` +
  `img-src 'self' data: ${CDN}; media-src 'self'; connect-src 'self' ${CDN}; frame-src https://store.dotrino.com https://id.dotrino.com; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`

/** @type {(a: unknown, b: unknown) => boolean} */
const same = (a, b) => {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b))
  return x.length === y.length && timingSafeEqual(x, y)
}

/**
 * El nombre del archivo: sale de la ficha, así que no se deja que salte de carpeta.
 * @param {{ file?: unknown, name?: unknown, id?: unknown }} card
 */
export function safeFileName (card) {
  const ext = path.extname(String(card.file || '')).replace(/[^.a-z0-9]/gi, '')
  const base = String(card.name || card.id).replace(/[/\\\0-\x1f<>:"|?*]/g, ' ').replace(/^\.+/, '').trim().slice(0, 120)
  return (base || 'audio') + ext
}

/** Dónde dejar la copia para abrirla con otro programa: en memoria si el sistema lo permite. */
const openDir = () => path.join(process.env.XDG_RUNTIME_DIR || os.tmpdir(), `dotrino-content-open-${process.getuid?.() ?? 'u'}`)

/**
 * @param {string} file
 * @returns {[string, string[]]}
 */
function launcher (file) {
  if (process.platform === 'darwin') return ['open', [file]]
  if (process.platform === 'win32') return ['explorer.exe', [file]]
  return ['xdg-open', [file]]
}

/**
 * @param {{ library: import('./library.js').Library, port: number, tokenFile: string, openFile?: (f:string)=>void }} o
 * @returns {{ server: http.Server, token: string, close: () => Promise<void> }}
 */
export function createGui ({ library, port, tokenFile, openFile }) {
  const token = randomBytes(24).toString('base64url')
  writeFileSync(tokenFile, JSON.stringify({ port, token }), { mode: 0o600 })
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`])
  const origins = new Set([...hosts].map((h) => `http://${h}`))
  const assets = new URL('./gui/', import.meta.url)

  /** @type {(res: import('node:http').ServerResponse, code: number, obj: object) => import('node:http').ServerResponse} */
  const json = (res, code, obj) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(obj))
  /** @param {import('node:http').IncomingMessage} req */
  const authed = (req) => {
    const m = (req.headers.cookie || '').match(new RegExp(`(?:^|; )${COOKIE}=([^;]+)`))
    return !!m && same(m[1], token)
  }
  const launch = openFile || ((/** @type {string} */ f) => {
    const [cmd, args] = launcher(f)
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' })
    child.on('error', (e) => console.error(`[gui] could not open the file: ${e.message}`))
    child.unref()
  })

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  async function route (req, res) {
    if (!hosts.has(req.headers.host || '')) return json(res, 403, { code: 'bad-host' })
    // Un servidor http siempre trae `url` en la petición; el tipo lo deja opcional por los clientes.
    const url = new URL(/** @type {string} */ (req.url), `http://${req.headers.host}`)
    const parts = url.pathname.split('/').filter(Boolean)

    if (req.method === 'GET' && url.pathname === '/' && url.searchParams.has('t')) {
      if (!same(url.searchParams.get('t'), token)) return json(res, 403, { code: 'bad-token' })
      return res.writeHead(302, {
        location: '/',
        'set-cookie': `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/`
      }).end()
    }
    if (!authed(req)) {
      return res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' })
        .end('Open this window with the command: dotrino-content gui\nÁbrela con la orden: dotrino-content gui\n')
    }
    if (req.method !== 'GET' && req.method !== 'HEAD' && !origins.has(req.headers.origin || '')) {
      return json(res, 403, { code: 'bad-origin' })
    }

    const asset = ASSETS[url.pathname]
    if (req.method === 'GET' && asset) {
      return res.writeHead(200, {
        'content-type': asset[1], 'content-security-policy': CSP, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff'
      }).end(readFileSync(new URL(asset[0], assets)))
    }

    if (req.method === 'GET' && url.pathname === '/api/library') return json(res, 200, await library.list())

    if (parts[0] === 'media' && parts[1] && (req.method === 'GET' || req.method === 'HEAD')) {
      const item = await library.find(decodeURIComponent(parts[1]))
      /** @type {Record<string, string | number>} */
      const headers = {
        'content-type': item.card.mime || 'application/octet-stream',
        'accept-ranges': 'bytes',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff'
      }
      if (url.searchParams.has('download')) {
        headers['content-disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(safeFileName(item.card))}`
      }
      const range = parseRange(req.headers.range, item.size)
      if (range === false) return res.writeHead(416, { 'content-range': `bytes */${item.size}` }).end()
      const { start, end } = range || { start: 0, end: item.size - 1 }
      if (range) headers['content-range'] = `bytes ${start}-${end}/${item.size}`
      headers['content-length'] = end - start + 1
      res.writeHead(range ? 206 : 200, headers)
      if (req.method === 'HEAD') return res.end()
      await pipeline(library.stream(item, start, end), res)
      return
    }

    if (parts[0] === 'api' && parts[2] === 'open' && req.method === 'POST') {
      const item = await library.find(decodeURIComponent(parts[1]))
      const dir = openDir()
      await mkdir(dir, { recursive: true, mode: 0o700 })
      await chmod(dir, 0o700)
      const file = path.join(dir, safeFileName(item.card))
      await pipeline(library.stream(item), createWriteStream(file, { mode: 0o600 }))
      launch(file)
      return json(res, 200, { ok: true, inMemory: !!process.env.XDG_RUNTIME_DIR })
    }

    if (parts[0] === 'api' && parts[1] && parts.length === 2 && req.method === 'DELETE') {
      await library.remove(decodeURIComponent(parts[1]))
      return json(res, 200, { ok: true })
    }
    return json(res, 404, { code: 'not-found' })
  }

  const server = http.createServer((req, res) => {
    route(req, res).catch((/** @type {Error & { code?: string }} */ e) => {
      if (res.headersSent) { res.destroy(); return }
      json(res, e?.code === 'not-found' ? 404 : 500, { code: e?.code || 'failed', error: e?.message })
    })
  })

  return {
    server,
    token,
    async close () {
      server.close()
      server.closeAllConnections?.()
      await rm(tokenFile, { force: true })
      // Las copias abiertas son en claro: no sobreviven al node.
      await rm(openDir(), { recursive: true, force: true })
    }
  }
}

export default { createGui, safeFileName, DEFAULT_GUI_PORT }
