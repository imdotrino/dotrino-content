import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { ContentNode } from '../src/node.js'
import { createServer, parseRange } from '../src/server.js'

let dir, node, server, base

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'dcontent-'))
  node = await new ContentNode({ dir, maxBlobBytes: 5 * 1024 * 1024 }).init()
  server = createServer(node)
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  server.close()
  node.close()
  await rm(dir, { recursive: true, force: true })
})

const upload = (body, mime = 'application/octet-stream', qs = '') =>
  fetch(`${base}/c${qs}`, { method: 'POST', headers: { 'content-type': mime }, body })

test('subir devuelve cid = sha256 del contenido, y dedup en re-subida', async () => {
  const data = Buffer.from('hola dotrino')
  const expected = `sha256-${createHash('sha256').update(data).digest('hex')}`

  const r1 = await upload(data, 'text/plain')
  assert.equal(r1.status, 201)
  const j1 = await r1.json()
  assert.equal(j1.cid, expected)
  assert.equal(j1.size, data.length)
  assert.equal(j1.existed, false)

  const r2 = await upload(data, 'text/plain')
  assert.equal(r2.status, 200)
  assert.equal((await r2.json()).existed, true)
})

test('GET sirve el blob con ETag inmutable; HEAD sin cuerpo; 304 con If-None-Match', async () => {
  const data = Buffer.from('contenido de prueba')
  const { cid } = await (await upload(data, 'text/plain')).json()

  const r = await fetch(`${base}/c/${cid}`)
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('content-type'), 'text/plain')
  assert.equal(r.headers.get('etag'), `"${cid}"`)
  assert.match(r.headers.get('cache-control'), /immutable/)
  assert.equal(Buffer.compare(Buffer.from(await r.arrayBuffer()), data), 0)

  const h = await fetch(`${base}/c/${cid}`, { method: 'HEAD' })
  assert.equal(h.status, 200)
  assert.equal(h.headers.get('content-length'), String(data.length))
  assert.equal((await h.arrayBuffer()).byteLength, 0)

  const n = await fetch(`${base}/c/${cid}`, { headers: { 'if-none-match': `"${cid}"` } })
  assert.equal(n.status, 304)
})

test('Range: 206 parcial, sufijo, y 416 inválido', async () => {
  const data = Buffer.from('0123456789')
  const { cid } = await (await upload(data)).json()

  const r = await fetch(`${base}/c/${cid}`, { headers: { range: 'bytes=2-5' } })
  assert.equal(r.status, 206)
  assert.equal(r.headers.get('content-range'), `bytes 2-5/10`)
  assert.equal(await r.text(), '2345')

  const s = await fetch(`${base}/c/${cid}`, { headers: { range: 'bytes=-3' } })
  assert.equal(s.status, 206)
  assert.equal(await s.text(), '789')

  const bad = await fetch(`${base}/c/${cid}`, { headers: { range: 'bytes=50-' } })
  assert.equal(bad.status, 416)
})

test('parseRange unit', () => {
  assert.deepEqual(parseRange('bytes=0-0', 10), { start: 0, end: 0 })
  assert.deepEqual(parseRange('bytes=3-', 10), { start: 3, end: 9 })
  assert.deepEqual(parseRange('bytes=0-99', 10), { start: 0, end: 9 })
  assert.equal(parseRange('bytes=-0', 10), false)
  assert.equal(parseRange('bytes=9-3', 10), false)
  assert.equal(parseRange(undefined, 10), null)
})

test('list, stats, pin/unpin, delete y 404', async () => {
  const { cid } = await (await upload(Buffer.from('para borrar'))).json()

  const list = await (await fetch(`${base}/list`)).json()
  assert.ok(list.some(b => b.cid === cid))
  const stats = await (await fetch(`${base}/stats`)).json()
  assert.ok(stats.blobs >= 1 && stats.bytes > 0)

  assert.equal((await fetch(`${base}/pin/${cid}`, { method: 'POST' })).status, 200)
  assert.equal(node.stat(cid).pinned, 1)
  assert.equal((await fetch(`${base}/unpin/${cid}`, { method: 'POST' })).status, 200)

  assert.equal((await fetch(`${base}/c/${cid}`, { method: 'DELETE' })).status, 200)
  assert.equal((await fetch(`${base}/c/${cid}`)).status, 404)
  const fake = `sha256-${'0'.repeat(64)}`
  assert.equal((await fetch(`${base}/c/${fake}`)).status, 404)
  assert.equal((await fetch(`${base}/c/no-es-cid`)).status, 400)
})

test('413 si el blob supera max-blob', async () => {
  const big = Buffer.alloc(6 * 1024 * 1024)
  const r = await upload(big)
  assert.equal(r.status, 413)
})

test('GC: ttl vencido se borra; pineado sobrevive a la presión de cuota', async () => {
  // blob con ttl ya vencido (ttl=1ms)
  const { cid: ephemeral } = await (await upload(Buffer.from('efimero'), 'text/plain', '?ttl=1')).json()
  await new Promise(r => setTimeout(r, 10))
  node.gc()
  assert.equal(node.stat(ephemeral), null)

  // cuota: nodo aparte con 100 bytes de cuota
  const dir2 = await mkdtemp(path.join(tmpdir(), 'dcontent-q-'))
  const n2 = await new ContentNode({ dir: dir2, maxBytes: 100 }).init()
  try {
    const a = await n2.put(bufStream(Buffer.alloc(60, 1)))
    n2.pin(a.cid)
    const b = await n2.put(bufStream(Buffer.alloc(30, 2)))
    // el tercero (60b) no cabe: debe desalojar b (no pineado) y conservar a
    await n2.put(bufStream(Buffer.alloc(40, 3)))
    assert.ok(n2.stat(a.cid), 'el pineado sobrevive')
    assert.equal(n2.stat(b.cid), null, 'el no-pineado fue desalojado')

    // si solo quedan pineados y no cabe → ENOSPC
    await assert.rejects(n2.put(bufStream(Buffer.alloc(90, 4))), { code: 'ENOSPC' })
  } finally {
    n2.close()
    await rm(dir2, { recursive: true, force: true })
  }
})

function bufStream (buf) {
  return Readable.from([buf])
}
