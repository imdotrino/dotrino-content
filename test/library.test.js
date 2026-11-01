/**
 * La biblioteca de punta a punta dentro del node: un aparato sube por `up.*` un archivo cifrado
 * por tramos y su ficha, y la ventana local lo devuelve en claro, con rangos, y solo a quien
 * presenta la llave de ese arranque.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { makeGeneration, sealAccount } from '@dotrino/identity/content'
import { ContentNode } from '../src/node.js'
import { createOps } from '../src/ops.js'
import { Library, LIBRARY_TAG } from '../src/library.js'
import { createGui, safeFileName } from '../src/gui.js'
import { SEGMENT_BYTES, sealSegment, openSegment, plainSize, ivFor } from '../lib/segments.js'
import { isDotrinoNetwork, bytesAllowed } from '../lib/network.js'
import { RELAY_MAX_BYTES } from '@dotrino/proxy-client'

const DIRECT = { route: async () => 'direct' }
const OWN_PROXY = 'wss://proxy.mi-casa.ec'
const DOTRINO = 'wss://proxy.dotrino.com'

async function encryptWhole (plain, key) {
  const out = []
  const count = Math.max(1, Math.ceil(plain.length / SEGMENT_BYTES))
  for (let i = 0; i < count; i++) {
    out.push(Buffer.from(await sealSegment(key, i, i === count - 1, plain.subarray(i * SEGMENT_BYTES, (i + 1) * SEGMENT_BYTES))))
  }
  return Buffer.concat(out)
}
const cidOf = (b) => 'sha256-' + createHash('sha256').update(b).digest('hex')

async function upload (ops, bytes, opts = {}, ctx = DIRECT) {
  const cid = cidOf(bytes)
  const begin = await ops({ op: 'up.begin', rid: 1, cid, size: bytes.length, enc: 1, mime: 'application/octet-stream', ...opts }, ctx)
  assert.equal(begin.ok, true, begin.error)
  let at = begin.at
  while (at < bytes.length) {
    const next = bytes.subarray(at, at + 96 * 1024)
    const r = await ops({ op: 'up.part', rid: 2, cid, at, data: next.toString('base64') }, ctx)
    assert.equal(r.ok, true, r.error)
    at = r.at
  }
  const end = await ops({ op: 'up.end', rid: 3, cid }, ctx)
  assert.equal(end.ok, true, end.error)
  return cid
}

async function withNode (fn, proxyUrl = DOTRINO) {
  const dir = await mkdtemp(path.join(tmpdir(), 'content-lib-'))
  const node = await new ContentNode({ dir, owner: 'o' }).init()
  try { await fn(node, createOps(node, { owner: 'o', proxyUrl }), dir) } finally {
    node.close()
    await rm(dir, { recursive: true, force: true })
  }
}

test('un tramo fuera de sitio, o el último cortado, no abre', async () => {
  const key = randomBytes(32)
  const plain = randomBytes(SEGMENT_BYTES + 10)
  const c0 = await sealSegment(key, 0, false, plain.subarray(0, SEGMENT_BYTES))
  assert.deepEqual(Buffer.from(await openSegment(key, 0, false, c0)), plain.subarray(0, SEGMENT_BYTES))
  await assert.rejects(openSegment(key, 1, false, c0), { code: 'bad-segment' })
  // Cortar el archivo tras el tramo 0 lo haría pasar por el último: tampoco abre.
  await assert.rejects(openSegment(key, 0, true, c0), { code: 'bad-segment' })
  assert.equal(plainSize((await encryptWhole(plain, key)).length), plain.length)
  assert.deepEqual([...ivFor(258, true)], [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2])
})

test('los vectores de oro que comprueba dotrino-native', async () => {
  const v = JSON.parse(readFileSync(new URL('./vectors/segments.json', import.meta.url), 'utf8'))
  const key = Buffer.from(v.key, 'hex')
  const plain = Buffer.alloc(v.plainBytes, 0x61)
  const cipher = await encryptWhole(plain, key)
  assert.equal(cipher.length, v.cipherBytes)
  assert.equal(cidOf(cipher), v.cid)
})

test('quién puede pasar bytes por dónde', () => {
  assert.equal(isDotrinoNetwork(DOTRINO), true)
  assert.equal(isDotrinoNetwork('wss://otro.dotrino.com'), true)
  assert.equal(isDotrinoNetwork('wss://notdotrino.com'), false)
  assert.equal(isDotrinoNetwork(OWN_PROXY), false)
  assert.equal(bytesAllowed('direct', DOTRINO), 'yes')
  assert.equal(bytesAllowed('turn', DOTRINO), 'no')
  assert.equal(bytesAllowed('proxy', DOTRINO), 'no')
  assert.equal(bytesAllowed('turn', OWN_PROXY), 'ask')
  assert.equal(bytesAllowed('proxy', OWN_PROXY), 'ask')
})

test('por la red de Dotrino lo grande no pasa, ni por TURN ni por el proxio', async () => {
  await withNode(async (node, ops) => {
    const bytes = randomBytes(1000)
    for (const route of ['turn', 'proxy', 'webrtc', null]) {
      const r = await ops({ op: 'up.begin', rid: 1, cid: cidOf(bytes), size: bytes.length }, { route: async () => route })
      assert.equal(r.code, 'needs-direct', String(route))
    }
    // Y si el camino cae a mitad de subida, se para ahí.
    const cid = cidOf(bytes)
    assert.equal((await ops({ op: 'up.begin', rid: 1, cid, size: bytes.length }, DIRECT)).ok, true)
    const r = await ops({ op: 'up.part', rid: 2, cid, at: 0, data: bytes.toString('base64') }, { route: async () => 'turn' })
    assert.equal(r.code, 'needs-direct')
  })
})

test('por una red propia pasa, y por su proxio con el tope del pilar', async () => {
  await withNode(async (node, ops) => {
    const bytes = randomBytes(1000)
    const cid = await upload(ops, bytes, {}, { route: async () => 'proxy' })
    assert.ok(node.stat(cid))
    const big = { op: 'up.begin', rid: 1, cid: 'sha256-' + 'a'.repeat(64), size: RELAY_MAX_BYTES + 1 }
    assert.equal((await ops(big, { route: async () => 'proxy' })).code, 'too-big-for-relay')
    assert.equal((await ops(big, { route: async () => 'turn' })).ok, true)
  }, OWN_PROXY)
})

test('una subida cortada se retoma, y unos bytes que no son el cid no entran', async () => {
  await withNode(async (node, ops) => {
    const bytes = randomBytes(300 * 1024)
    const cid = cidOf(bytes)
    await ops({ op: 'up.begin', rid: 1, cid, size: bytes.length }, DIRECT)
    await ops({ op: 'up.part', rid: 2, cid, at: 0, data: bytes.subarray(0, 100).toString('base64') }, DIRECT)
    assert.equal((await ops({ op: 'up.part', rid: 2, cid, at: 50, data: 'AAAA' }, DIRECT)).code, 'wrong-offset')
    const again = await createOps(node, { proxyUrl: DOTRINO })({ op: 'up.begin', rid: 3, cid, size: bytes.length }, DIRECT)
    assert.equal(again.at, 100)
    assert.ok(await upload(ops, bytes))
    assert.equal((await ops({ op: 'up.begin', rid: 4, cid, size: bytes.length }, DIRECT)).existed, true)

    const liar = randomBytes(50)
    const fake = 'sha256-' + 'b'.repeat(64)
    await ops({ op: 'up.begin', rid: 1, cid: fake, size: 50 }, DIRECT)
    await ops({ op: 'up.part', rid: 2, cid: fake, at: 0, data: liar.toString('base64') }, DIRECT)
    assert.equal((await ops({ op: 'up.end', rid: 3, cid: fake }, DIRECT)).code, 'corrupt')
    assert.equal(node.stat(cidOf(liar)), null)
  })
})

async function setupLibrary (node, ops) {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits', 'deriveKey'])
  const myPub = 'node-pub'
  const encPub = JSON.stringify(await crypto.subtle.exportKey('jwk', pair.publicKey))
  const made = await makeGeneration({ members: [{ pub: myPub, encPub }] })
  const generation = made.generation || made
  const { cek } = made
  const account = async () => ({ keyring: [generation], myPub, myEncPrivateKey: pair.privateKey })
  const addItem = async (plain, extra = {}) => {
    const key = randomBytes(32)
    const cipher = await encryptWhole(plain, key)
    const cid = await upload(ops, cipher)
    const card = {
      v: 1, id: 'rec-1', app: 'recorder', kind: 'audio', name: 'Ensayo', file: 'rec-1.wav', mime: 'audio/wav', format: 'WAV24',
      durationMs: 1000, createdAt: 1, updatedAt: 1, cid, key: key.toString('base64'), ...extra
    }
    const env = await sealAccount({ cek, gen: generation.gen, plaintext: JSON.stringify(card) })
    const r = await ops({ op: 'put', rid: 9, data: Buffer.from(JSON.stringify(env)).toString('base64'), enc: 1, tag: LIBRARY_TAG, mime: 'application/json' })
    assert.equal(r.ok, true, r.error)
    return r.cid
  }
  return { account, addItem }
}

test('la ventana: lista, rangos, llave, host, origen, renombrado y borrado', async () => {
  await withNode(async (node, ops, dir) => {
    const { account, addItem } = await setupLibrary(node, ops)
    const plain = randomBytes(SEGMENT_BYTES * 2 + 1234)
    await addItem(plain)
    await addItem(plain, { name: 'Ensayo final', updatedAt: 2 })

    const library = new Library({ node, account })
    let opened = null
    // Un puerto libre, para que la comprobación de Host sea la de verdad.
    const net = await import('node:net')
    const port = await new Promise((resolve) => { const t = net.createServer().listen(0, '127.0.0.1', () => { const n = t.address().port; t.close(() => resolve(n)) }) })
    const gui2 = createGui({ library, port, tokenFile: path.join(dir, 'gui.json'), openFile: (f) => { opened = f } })
    await new Promise((resolve) => gui2.server.listen(port, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${port}`
    try {
      assert.equal((await fetch(`${base}/api/library`)).status, 401)
      assert.equal((await fetch(`${base}/?t=mala`)).status, 403)
      const login = await fetch(`${base}/?t=${gui2.token}`, { redirect: 'manual' })
      assert.equal(login.status, 302)
      const cookie = login.headers.get('set-cookie')
      assert.match(cookie, /HttpOnly/)
      assert.match(cookie, /SameSite=Strict/)
      const h = { cookie: cookie.split(';')[0] }

      const { items, problems } = await (await fetch(`${base}/api/library`, { headers: h })).json()
      assert.deepEqual(problems, [])
      assert.equal(items.length, 1)
      assert.equal(items[0].name, 'Ensayo final')
      assert.equal(items[0].size, plain.length)
      assert.equal(items[0].key, undefined, 'la llave no sale a la página')

      const whole = Buffer.from(await (await fetch(`${base}/media/rec-1`, { headers: h })).arrayBuffer())
      assert.ok(whole.equals(plain))

      // Un rango que cruza dos tramos.
      const a = SEGMENT_BYTES - 5
      const r = await fetch(`${base}/media/rec-1`, { headers: { ...h, range: `bytes=${a}-${a + 9}` } })
      assert.equal(r.status, 206)
      assert.ok(Buffer.from(await r.arrayBuffer()).equals(plain.subarray(a, a + 10)))

      const dl = await fetch(`${base}/media/rec-1?download=1`, { headers: h })
      assert.match(dl.headers.get('content-disposition'), /Ensayo%20final\.wav/)
      await dl.arrayBuffer()

      // Lo que cambia algo pide Origin propio: el de otra web no vale ni con la cookie.
      assert.equal((await fetch(`${base}/api/rec-1/open`, { method: 'POST', headers: { ...h, origin: 'https://malo.example' } })).status, 403)
      const op = await fetch(`${base}/api/rec-1/open`, { method: 'POST', headers: { ...h, origin: base } })
      assert.equal(op.status, 200)
      assert.ok(readFileSync(opened).equals(plain))

      assert.equal((await fetch(`${base}/api/rec-1`, { method: 'DELETE', headers: { ...h, origin: base } })).status, 200)
      assert.deepEqual((await (await fetch(`${base}/api/library`, { headers: h })).json()).items, [])
      assert.equal(node.list().length, 0)

      // Un Host ajeno es rebinding de DNS, aunque traiga cookie.
      const http = await import('node:http')
      const status = await new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path: '/', headers: { ...h, host: 'malo.example' } }, (res) => { res.resume(); resolve(res.statusCode) }).on('error', reject)
      })
      assert.equal(status, 403)
    } finally {
      await gui2.close()
    }
  })
})

test('una ficha que este node no puede abrir se dice, no se esconde', async () => {
  await withNode(async (node, ops) => {
    const { account } = await setupLibrary(node, ops)
    const r = await ops({ op: 'put', rid: 1, data: Buffer.from(JSON.stringify({ gen: 99, iv: 'AA', ct: 'AA' })).toString('base64'), enc: 1, tag: LIBRARY_TAG })
    const { items, problems } = await new Library({ node, account }).list()
    assert.equal(items.length, 0)
    assert.equal(problems[0].cid, r.cid)
  })
})

test('el nombre del archivo no salta de carpeta', () => {
  assert.ok(!safeFileName({ name: '../../etc/passwd', file: 'x.wav' }).includes('/'))
  assert.ok(!safeFileName({ name: 'a\\b', file: 'x.wav' }).includes('\\'))
})
