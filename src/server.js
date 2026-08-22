/**
 * API HTTP local (Fase 1, DISENO.md §6). SOLO localhost: sin auth todavía
 * (la auth por vault llega en Fase 2; la exposición al mundo en Fase 3).
 *
 *   POST   /c            subir (streaming; Content-Type = mime; ?ttl=<ms>)
 *   GET    /c/<cid>      descargar/streamear (Range → 206; ETag = cid, immutable)
 *   HEAD   /c/<cid>      size/mime/etag sin cuerpo
 *   DELETE /c/<cid>      borrar
 *   GET    /list         índice
 *   POST   /pin/<cid>    retención (evita GC)     POST /unpin/<cid>
 *   POST   /public/<cid>  publicar (al bucket público si lo hay)  POST /private/<cid>
 *   GET    /stats        uso de disco, nº blobs
 */
import http from 'node:http'
import { pipeline } from 'node:stream/promises'
import { isValidCid } from './node.js'

/** Parsea `Range: bytes=a-b|a-|-n` contra `size`. null = sin rango; false = inválido. */
export function parseRange (header, size) {
  if (!header) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m || (m[1] === '' && m[2] === '')) return false
  let start, end
  if (m[1] === '') { // sufijo: últimos n bytes
    const n = Number(m[2])
    if (n === 0) return false
    start = Math.max(0, size - n)
    end = size - 1
  } else {
    start = Number(m[1])
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1)
  }
  if (start >= size || start > end) return false
  return { start, end }
}

const json = (res, code, obj) => {
  const body = JSON.stringify(obj)
  res.writeHead(code, { 'content-type': 'application/json' }).end(body)
}

/**
 * @param {import('./node.js').ContentNode} node
 * @returns {http.Server}
 */
export function createServer (node) {
  return http.createServer(async (req, res) => {
    try {
      await route(node, req, res)
    } catch (err) {
      if (res.headersSent) { res.destroy(); return }
      if (err.code === 'ETOOBIG') return json(res, 413, { error: 'blob demasiado grande' })
      if (err.code === 'ENOSPC') return json(res, 507, { error: 'cuota de disco excedida' })
      json(res, 500, { error: err.message })
    }
  })
}

async function route (node, req, res) {
  const url = new URL(req.url, 'http://localhost')
  const [, top, cid] = url.pathname.split('/')

  if (req.method === 'POST' && top === 'c' && !cid) {
    const ttlMs = Number(url.searchParams.get('ttl')) || 0
    const out = await node.put(req, {
      mime: req.headers['content-type'] || 'application/octet-stream',
      enc: url.searchParams.get('enc') === '1' ? 1 : 0,
      ttl: ttlMs > 0 ? Date.now() + ttlMs : null
    })
    return json(res, out.existed ? 200 : 201, out)
  }

  if (top === 'c' && cid) {
    if (!isValidCid(cid)) return json(res, 400, { error: 'cid inválido' })
    const meta = node.stat(cid)
    if (!meta) return json(res, 404, { error: 'no existe' })

    if (req.method === 'DELETE') {
      await node.remove(cid)
      return json(res, 200, { ok: true })
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return json(res, 405, { error: 'método no permitido' })
    }

    const headers = {
      'content-type': meta.mime,
      etag: `"${cid}"`,
      'cache-control': 'public, max-age=31536000, immutable',
      'accept-ranges': 'bytes'
    }
    if (req.headers['if-none-match'] === `"${cid}"`) {
      res.writeHead(304, headers).end()
      return
    }
    const range = parseRange(req.headers.range, meta.size)
    if (range === false) {
      res.writeHead(416, { 'content-range': `bytes */${meta.size}` }).end()
      return
    }
    if (range) {
      headers['content-range'] = `bytes ${range.start}-${range.end}/${meta.size}`
      headers['content-length'] = range.end - range.start + 1
      res.writeHead(206, headers)
    } else {
      headers['content-length'] = meta.size
      res.writeHead(200, headers)
    }
    if (req.method === 'HEAD') return res.end()
    await pipeline(node.read(cid, range ?? undefined), res)
    return
  }

  if (req.method === 'GET' && top === 'list') return json(res, 200, node.list())
  if (req.method === 'GET' && top === 'stats') return json(res, 200, node.stats())

  if (req.method === 'POST' && (top === 'pin' || top === 'unpin') && cid) {
    if (!isValidCid(cid)) return json(res, 400, { error: 'cid inválido' })
    const ok = node.pin(cid, top === 'pin')
    return ok ? json(res, 200, { ok: true }) : json(res, 404, { error: 'no existe' })
  }

  // PUBLICAR / despublicar. Existía solo por el plano de control, y eso dejaba sin poder
  // publicar a las herramientas de la propia máquina —que es donde vive el dueño—, y sin
  // poder probar el camino público sin montar medio ecosistema.
  //
  // Con bucket detrás, marcar público MUEVE los bytes al bucket público, que es otro
  // (§15.1): por eso pasa por `node.setAcl` y no por el índice a secas.
  if (req.method === 'POST' && (top === 'public' || top === 'private') && cid) {
    if (!isValidCid(cid)) return json(res, 400, { error: 'cid inválido' })
    const meta = node.stat(cid)
    if (!meta) return json(res, 404, { error: 'no existe' })
    // Un blob CIFRADO no puede ser público, y se rechaza aquí además de en el índice:
    // es la misma frontera del §7.2, y una frontera que solo se comprueba en un sitio
    // acaba teniendo un camino que no pasa por ese sitio.
    if (top === 'public' && meta.enc) return json(res, 400, { error: 'un blob cifrado no puede ser público' })
    const ok = node.setAcl(cid, top === 'public' ? 'public' : null)
    return ok ? json(res, 200, { ok: true, acl: top === 'public' ? 'public' : null }) : json(res, 404, { error: 'no existe' })
  }

  json(res, 404, { error: 'ruta desconocida' })
}
