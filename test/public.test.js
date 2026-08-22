/**
 * Pruebas del MODO PÚBLICO (DISENO.md §7.2 / §7.3).
 *
 * Es la única puerta por la que este node manda bytes a internet sin que pase por
 * una app, así que cada cerrojo tiene su prueba: la ACL, el tipo REAL del archivo
 * (no el declarado), el tope de tamaño, el límite por IP y el techo de salida.
 * Lo que se comprueba aquí no es que "funcione": es que lo que NO debe salir, no sale.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { ContentNode } from '../src/node.js'
import { createPublicServer, RateLimiter, sniffImage, utcDay } from '../src/public.js'

let dir, node, server, base

/** PNG 1×1 de verdad (cabecera + IHDR + IDAT + IEND): los bytes mágicos importan. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64')
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')

const put = (buf, opts) => node.put(Readable.from(buf), opts)
const publish = async (buf, opts = {}) => {
  const { cid } = await put(buf, { mime: opts.mime || 'image/png' })
  node.setAcl(cid, 'public')
  return cid
}

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'dcpublic-'))
  node = await new ContentNode({ dir }).init()
  node.owner = 'ownerid-de-prueba'
  server = createPublicServer(node, { maxBytes: 4096, maxEgressBytes: 0, quiet: true })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  server.close()
  node.close()
  await rm(dir, { recursive: true, force: true })
})

test('lo PRIVADO no sale, y contesta 404 (no 403: un 403 confirmaría que existe)', async () => {
  const { cid } = await put(PNG, { mime: 'image/png' })   // sin marcar público
  const res = await fetch(`${base}/c/${cid}`)
  assert.equal(res.status, 404)
  assert.equal((await fetch(`${base}/p/${cid}`)).status, 404)
})

test('lo CIFRADO no sale ni marcado público a mano en el índice', async () => {
  // Bytes propios: el `cid` es el hash, así que reusar los de otra prueba sería el
  // MISMO blob y heredaría su estado (el dedup no es un detalle, es el modelo).
  const { cid } = await put(Buffer.concat([PNG, Buffer.from('cifrado')]), { mime: 'image/png', enc: 1 })
  // Saltándose ops.acl (que ya lo impide) para probar el segundo cerrojo, el que
  // está donde los bytes de verdad salen.
  node.index.setAcl(cid, 'public')
  assert.equal(node.publicStat(cid), null)
  assert.equal((await fetch(`${base}/c/${cid}`)).status, 404)
})

test('lo público y en claro SÍ sale, con ETag inmutable y 304', async () => {
  const cid = await publish(PNG)
  const res = await fetch(`${base}/c/${cid}`)
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'image/png')
  assert.equal(res.headers.get('etag'), `"${cid}"`)
  assert.match(res.headers.get('cache-control'), /immutable/)
  assert.equal(Buffer.from(await res.arrayBuffer()).equals(PNG), true)

  const again = await fetch(`${base}/c/${cid}`, { headers: { 'if-none-match': `"${cid}"` } })
  assert.equal(again.status, 304)
})

test('el tipo lo deciden los BYTES, no lo que dijo quien subió', async () => {
  // Un HTML subido como "image/png": el mime del índice miente y aquí no cuela.
  const html = Buffer.from('<script>alert(1)</script>')
  const { cid } = await put(html, { mime: 'image/png' })
  node.setAcl(cid, 'public')
  assert.equal(await sniffImage(node.store.pathFor(cid)), null)
  assert.equal((await fetch(`${base}/c/${cid}`)).status, 404)

  // Y un GIF de verdad sale como GIF aunque se haya declarado otra cosa.
  const gif = await publish(GIF, { mime: 'image/jpeg' })
  const res = await fetch(`${base}/c/${gif}`)
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'image/gif')
})

test('un SVG no sale: es un documento que ejecuta scripts, no una imagen', async () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>')
  const { cid } = await put(svg, { mime: 'image/svg+xml' })
  node.setAcl(cid, 'public')
  assert.equal((await fetch(`${base}/c/${cid}`)).status, 404)
})

test('el TOPE de tamaño es lo que hace que esto sirva previas y no originales', async () => {
  const big = Buffer.concat([PNG, Buffer.alloc(8192)])   // PNG válido, pero de 8 KB
  const cid = await publish(big)
  const res = await fetch(`${base}/c/${cid}`)
  assert.equal(res.status, 413)
  // La tarjeta sigue existiendo: lo que no sale es el archivo, no el permalink.
  assert.equal((await fetch(`${base}/p/${cid}`)).status, 200)
})

test('el permalink trae las etiquetas OG y el enlace con la referencia en el #fragment', async () => {
  const cid = await publish(PNG)
  node.setMeta(cid, { title: 'Una foto', description: 'de prueba' })
  const html = await (await fetch(`${base}/p/${cid}`)).text()
  assert.match(html, /<meta property="og:title" content="Una foto">/)
  assert.match(html, /<meta property="og:image" content="[^"]+\/c\/sha256-[0-9a-f]{64}">/)
  assert.match(html, /name="twitter:card" content="summary_large_image"/)
  // La referencia va en el fragmento: el servidor de la app nunca la ve.
  assert.match(html, new RegExp(`href="https://eco\\.dotrino\\.com/#ownerid-de-prueba/${cid}"`))
  // Y no se indexa salvo que el dueño lo pida.
  assert.match(html, /name="robots" content="noindex, nofollow"/)
})

test('la tarjeta de un NO-imagen usa su miniatura, y solo si la miniatura es pública', async () => {
  const { cid: docCid } = await put(Buffer.from('%PDF-1.4 nada'), { mime: 'application/pdf' })
  node.setAcl(docCid, 'public')
  const { cid: thumbCid } = await put(Buffer.concat([GIF, Buffer.from('!')]), { mime: 'image/gif' })  // privada todavía
  node.setThumbnail(docCid, thumbCid)

  let html = await (await fetch(`${base}/p/${docCid}`)).text()
  // La tarjeta lleva la imagen de la APP (og.jpg), nunca la miniatura privada por estar enlazada.
  assert.doesNotMatch(html, /\/c\//, 'una miniatura privada no se publica por estar enlazada')
  assert.match(html, /og:image" content="[^"]+\/og\.jpg"/)

  node.setAcl(thumbCid, 'public')
  html = await (await fetch(`${base}/p/${docCid}`)).text()
  assert.match(html, new RegExp(`og:image" content="[^"]+/c/${thumbCid}"`))
})

test('robots.txt prohíbe todo mientras no se pida indexar', async () => {
  assert.match(await (await fetch(`${base}/robots.txt`)).text(), /Disallow: \/$/m)
})

test('el límite por IP corta el bucle ajeno', () => {
  const rl = new RateLimiter(3)
  const t = 1_700_000_000_000
  assert.deepEqual([1, 2, 3, 4].map(() => rl.allow('1.2.3.4', t)), [true, true, true, false])
  // Otro que pide no paga por el primero, y al minuto siguiente se abre la cubeta.
  assert.equal(rl.allow('5.6.7.8', t), true)
  assert.equal(rl.allow('1.2.3.4', t + 60_000), true)
})

test('el techo de salida corta con 503, y cuenta lo que salió de verdad', async () => {
  // Techo de exactamente una respuesta: la primera pasa, la segunda ya no cabe.
  const capped = createPublicServer(node, { maxBytes: 4096, maxEgressBytes: PNG.length, quiet: true })
  await new Promise((r) => capped.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${capped.address().port}`
  const cid = await publish(PNG)
  try {
    assert.equal((await fetch(`${url}/c/${cid}`)).status, 200)
    await new Promise((r) => setTimeout(r, 50))    // el apunte se hace al cerrar el socket
    assert.equal(node.index.egressOn(utcDay()), PNG.length)
    const res = await fetch(`${url}/c/${cid}`)
    assert.equal(res.status, 503)
    assert.equal(res.headers.get('retry-after'), '3600')
    // HEAD no manda cuerpo, así que no gasta techo y sigue contestando.
    assert.equal((await fetch(`${url}/c/${cid}`, { method: 'HEAD' })).status, 200)
  } finally { capped.close() }
})
