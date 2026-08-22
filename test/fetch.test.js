/**
 * La lectura PÚBLICA por la red (DISENO.md §16): un tercero sin sesión pide un `cid`
 * por el proxio y recibe SOLO lo marcado público y en claro. Se prueba de punta a
 * punta sobre un proxio de mentira en memoria —mismo contrato que el de verdad:
 * `send(token, obj)`, `on('message', (from, obj))`, `list(canal)`— con el node real y
 * el cliente real (`fetchPublic`). Sin red.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { ContentNode } from '../src/node.js'
import { startPublicFetch, FETCH_MAX_BYTES } from '../src/fetch.js'
import { startAnnounce } from '../src/announce.js'
import { fetchPublic, findNodes, channelFor } from '../lib/public.js'

const OWNER = 'sha256-' + 'ab'.repeat(32)

/** Proxio en memoria: tokens, canales y entrega de mensajes entre endpoints. */
function makeProxy () {
  const endpoints = new Map()
  const channels = new Map()
  const members = (name) => channels.get(name) || channels.set(name, new Set()).get(name)
  const nodes = ['NODEUNO12345']
  let n = 0
  return {
    endpoint () {
      const token = `T${++n}`
      const handlers = { message: [], token: [] }
      const ep = {
        token,
        node: nodes[0],
        knownNodes: nodes,
        on (ev, cb) { handlers[ev]?.push(cb); return () => { handlers[ev] = handlers[ev].filter((h) => h !== cb) } },
        send (to, obj) {
          for (const t of Array.isArray(to) ? to : [to]) {
            const dst = endpoints.get(t)
            if (dst) setImmediate(() => dst._emit(token, JSON.parse(JSON.stringify(obj))))
          }
        },
        _emit (from, obj) { for (const h of handlers.message) h(from, obj) },
        async publish (name) { members(name).add(token) },
        async unpublish (name) { members(name).delete(token) },
        async list (name) { return [...members(name)] }
      }
      endpoints.set(token, ep)
      return ep
    }
  }
}

async function makeNode (t, opts = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'fetch-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return new ContentNode({ dir, ...opts }).init()
}

const put = (node, bytes, opts = {}) => node.put(Readable.from(Buffer.from(bytes)), { mime: 'text/plain', ...opts })

test('un tercero lee lo PÚBLICO por la red, y los bytes vuelven verificados por el cid', async (t) => {
  const proxy = makeProxy()
  const node = await makeNode(t)
  const nodeEp = proxy.endpoint()
  const beacon = startAnnounce({ client: nodeEp, owner: OWNER, quiet: true })
  const fetcher = startPublicFetch({ client: nodeEp, node, quiet: true })
  t.after(() => { fetcher.close(); beacon.close() })
  await new Promise((r) => setImmediate(r))

  const { cid } = await put(node, 'hola mundo')
  node.setAcl(cid, 'public')

  const third = proxy.endpoint()
  assert.deepEqual(await findNodes({ client: third, owner: OWNER }), [nodeEp.token], 'lo encuentra por el canal del dueño')

  const r = await fetchPublic({ client: third, owner: OWNER, cid })
  assert.equal(Buffer.from(r.bytes).toString(), 'hola mundo')
  assert.equal(r.mime, 'text/plain')
  assert.equal(r.url, null, 'sin bucket público no hay atajo: viaja por la red')
  assert.equal(fetcher.served(), 1)
})

test('lo privado y lo cifrado NO salen, y no se distingue de «no existe»', async (t) => {
  const proxy = makeProxy()
  const node = await makeNode(t)
  const nodeEp = proxy.endpoint()
  startAnnounce({ client: nodeEp, owner: OWNER, quiet: true })
  startPublicFetch({ client: nodeEp, node, quiet: true })
  await new Promise((r) => setImmediate(r))
  const third = proxy.endpoint()

  const priv = await put(node, 'secreto')                       // sin acl → privado
  await assert.rejects(fetchPublic({ client: third, owner: OWNER, cid: priv.cid }), { code: 'not-found' })

  const enc = await put(node, 'cifrado', { enc: 1 })
  node.setAcl(enc.cid, 'public')                                 // el index lo permite…
  await assert.rejects(fetchPublic({ client: third, owner: OWNER, cid: enc.cid }), { code: 'not-found' }, '…pero el fetch no lo sirve')

  await assert.rejects(fetchPublic({ client: third, owner: OWNER, cid: 'sha256-' + '0'.repeat(64) }), { code: 'not-found' })
})

test('sin ningún node del dueño en línea: no-node, que es lo que la app tiene que saber seguir', async (t) => {
  const proxy = makeProxy()
  const third = proxy.endpoint()
  await assert.rejects(fetchPublic({ client: third, owner: OWNER, cid: 'sha256-' + '1'.repeat(64) }), { code: 'no-node' })
})

test('con bucket público: la URL viaja como ATAJO, y lo grande solo por URL', async (t) => {
  const proxy = makeProxy()
  const node = await makeNode(t, { publicBase: 'https://c.example.com' })
  // Un almacén «con bucket» de mentira: mismo contrato que S3BlobStore para lo que mira el node.
  node.store.backed = true
  node.store.urlFor = (cid, base) => `${base}/${cid}`
  let release = null
  node.store.upload = () => new Promise((r) => { release = r })   // la subida tarda lo que queramos
  const nodeEp = proxy.endpoint()
  startAnnounce({ client: nodeEp, owner: OWNER, quiet: true })
  startPublicFetch({ client: nodeEp, node, quiet: true })
  await new Promise((r) => setImmediate(r))
  const third = proxy.endpoint()

  const { cid } = await put(node, 'imagen', { mime: 'image/png' })
  node.setAcl(cid, 'public')
  assert.equal(node.publicUrl(cid), null, 'hasta que el bucket confirme, no hay URL que dar')
  release(); await new Promise((r) => setImmediate(r))   // termina la subida privada…
  release(); await new Promise((r) => setImmediate(r))   // …y la pública que iba detrás
  assert.equal(node.publicUrl(cid), `https://c.example.com/${cid}`)

  const h = await fetchPublic({ client: third, owner: OWNER, cid })
  assert.equal(h.bytes, null, 'con atajo, los bytes no viajan por el proxio')
  assert.equal(h.url, `https://c.example.com/${cid}`)
  const f = await fetchPublic({ client: third, owner: OWNER, cid, full: true })
  assert.equal(Buffer.from(f.bytes).toString(), 'imagen', 'salvo que se insista (la URL falló)')

  node.store.upload = async () => {}
  const big = await put(node, Buffer.alloc(FETCH_MAX_BYTES + 1, 7), { mime: 'image/png' })
  node.setAcl(big.cid, 'public')
  await new Promise((r) => setImmediate(r))
  const r = await fetchPublic({ client: third, owner: OWNER, cid: big.cid })
  assert.equal(r.bytes, null, 'no cabe en un mensaje')
  assert.equal(r.url, `https://c.example.com/${big.cid}`, 'pero sí tiene por dónde cargarse')
})

test('el límite por remitente existe', async (t) => {
  const proxy = makeProxy()
  const node = await makeNode(t)
  const nodeEp = proxy.endpoint()
  startAnnounce({ client: nodeEp, owner: OWNER, quiet: true })
  startPublicFetch({ client: nodeEp, node, quiet: true, ratePerMin: 2 })
  await new Promise((r) => setImmediate(r))
  const third = proxy.endpoint()
  const { cid } = await put(node, 'x')
  node.setAcl(cid, 'public')
  await fetchPublic({ client: third, owner: OWNER, cid })
  await fetchPublic({ client: third, owner: OWNER, cid })
  await assert.rejects(fetchPublic({ client: third, owner: OWNER, cid }), { code: 'rate-limited' })
  assert.equal(channelFor('N', OWNER), `N/content_${OWNER}`)
})
