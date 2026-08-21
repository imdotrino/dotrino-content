/**
 * Pruebas de `@dotrino/content-client` (lib/): lo que una app del ecosistema usa
 * para guardar y leer en el node de su usuario.
 *
 * El transporte y la autorización se prueban de verdad en `agent.test.js` (con el
 * middleware, firmas y certificados reales). Aquí se enchufa el cliente REAL al
 * despachador REAL del node, con una sesión de mentira en medio: así lo que se
 * mide es la política del cliente —cifrar, verificar el hash, respetar el tope,
 * armar la referencia— sin montar un proxy para comprobar un `if`.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ContentNode } from '../src/node.js'
import { createOps, CONTROL_PLANE_MAX_BYTES } from '../src/ops.js'
import { ContentClient, buildRef, buildUrl, parseRef, matchesCid } from '../lib/index.js'
import { decryptBlob } from '../lib/crypto.js'

const OWNER = 'sha256-eldueño'

/** Sesión de mentira: lo que el cliente manda lo despacha el node de verdad. */
function wire (dispatch) {
  const handlers = []
  return {
    on (ev, cb) { if (ev === 'message') handlers.push(cb) },
    async send (payload) {
      // Copia por JSON, como haría el sobre cifrado al ir y volver.
      const reply = await dispatch(JSON.parse(JSON.stringify(payload)))
      setImmediate(() => { for (const h of handlers) h(JSON.parse(JSON.stringify(reply))) })
    },
    async close () {}
  }
}

async function withClient (fn, { hello } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'content-client-'))
  const node = await new ContentNode({ dir, owner: OWNER }).init()
  const dispatch = createOps(node, { owner: OWNER, version: 'test' })
  const cc = new ContentClient({
    link: {}, owner: OWNER, agent: { sub: 'node-pubkey' }, session: wire(dispatch),
    hello: hello || { owner: OWNER, maxBytes: CONTROL_PLANE_MAX_BYTES }
  })
  try { await fn(cc, node) } finally { node.close(); await rm(dir, { recursive: true, force: true }) }
}

// --- la referencia (isomórfica, sin red) ---

test('la referencia lleva dueño, cid y —si va cifrado— la llave', () => {
  const cid = 'sha256-' + 'a'.repeat(64)
  assert.equal(buildRef({ owner: 'O', cid }), `O/${cid}`)
  assert.equal(buildRef({ owner: 'O', cid, key: 'K' }), `O/${cid}/K`)
  assert.equal(buildUrl({ owner: 'O', cid, key: 'K' }), `https://eco.dotrino.com/#O/${cid}/K`)
})

test('parseRef lee un fragmento y sabe decir "esto no es mío"', () => {
  const cid = 'sha256-' + 'b'.repeat(64)
  assert.deepEqual(parseRef(`#O/${cid}/K`), { owner: 'O', cid, key: 'K' })
  assert.deepEqual(parseRef(`https://eco.dotrino.com/#O/${cid}`), { owner: 'O', cid, key: null })
  // Las apps usan el fragmento para muchas cosas: hay que poder decir que no sin ruido.
  for (const otro of ['#room=abc', '#vault', '', 'O/no-es-un-cid', `#O/${cid}/K/de-más`]) {
    assert.equal(parseRef(otro), null, `no debería parsear: ${otro}`)
  }
})

// --- guardar y leer ---

test('put cifra por defecto: el node NO ve el contenido, y la llave sale en la referencia', async () => {
  await withClient(async (cc, node) => {
    const ref = await cc.put('el secreto del usuario', { mime: 'text/plain' })
    assert.equal(ref.owner, OWNER)
    assert.ok(ref.key, 'la llave viaja en la referencia, para el #fragment')

    const stored = node.stat(ref.cid)
    assert.equal(stored.enc, 1)
    assert.equal(stored.acl, 'private')
    // Lo que hay en disco es ciphertext: buscar el texto en claro no lo encuentra.
    const bytes = []
    for await (const c of node.read(ref.cid)) bytes.push(c)
    assert.equal(Buffer.concat(bytes).includes('secreto'), false)
    // Y con la llave sí se abre.
    assert.equal(new TextDecoder().decode(await decryptBlob(Buffer.concat(bytes), ref.key)), 'el secreto del usuario')
  })
})

test('get devuelve el claro a partir de la referencia', async () => {
  await withClient(async (cc) => {
    const ref = await cc.put('ida y vuelta', { mime: 'text/plain' })
    assert.equal(new TextDecoder().decode(await cc.get(ref)), 'ida y vuelta')
    // También desde el fragmento tal cual, que es como llega en un enlace.
    assert.equal(new TextDecoder().decode(await cc.get('#' + buildRef(ref))), 'ida y vuelta')
  })
})

test('sin cifrar sí se puede publicar, y es lo que permite que haya tarjeta', async () => {
  await withClient(async (cc, node) => {
    const ref = await cc.put('una miniatura', { mime: 'image/webp', encrypt: false, acl: 'public' })
    assert.equal(ref.key, null)
    assert.equal(node.stat(ref.cid).acl, 'public')
    assert.equal(new TextDecoder().decode(await cc.get(ref)), 'una miniatura')
  })
})

test('cifrado y público a la vez se rechaza EN EL CLIENTE, antes de gastar la subida', async () => {
  await withClient(async (cc, node) => {
    await assert.rejects(() => cc.put('x', { encrypt: true, acl: 'public' }), (e) => e.code === 'bad-input')
    assert.equal(node.stats().blobs, 0, 'no llegó a subir nada')
  })
})

test('unos bytes que no cuadran con el cid se rechazan, venga quien los mande', async () => {
  await withClient(async (cc) => {
    const ref = await cc.put('lo bueno', { encrypt: false })
    const otro = await cc.put('lo cambiado', { encrypt: false })
    // Pedimos un cid pero el node contesta con los bytes del otro: el hash lo caza.
    const real = cc._ask.bind(cc)
    cc._ask = async (msg) => real(msg.op === 'get' ? { ...msg, cid: otro.cid } : msg)
    await assert.rejects(() => cc.get({ ...ref, key: null }), (e) => e.code === 'corrupt')
  })
})

test('lo que no cabe por el plano de control se para en el cliente, con su código', async () => {
  await withClient(async (cc, node) => {
    await assert.rejects(
      () => cc.put(new Uint8Array(CONTROL_PLANE_MAX_BYTES + 1), { encrypt: false }),
      (e) => e.code === 'too-large')
    assert.equal(node.stats().blobs, 0)
  })
})

test('el tope lo dice el node en hello: el cliente no lo adivina', async () => {
  await withClient(async (cc) => {
    assert.equal(cc.maxBytes, 1024)
    await assert.rejects(() => cc.put(new Uint8Array(2048), { encrypt: false }), (e) => e.code === 'too-large')
  }, { hello: { owner: OWNER, maxBytes: 1024 } })
})

test('los errores del node llegan por code, nunca por la frase', async () => {
  await withClient(async (cc) => {
    await assert.rejects(() => cc.stat('sha256-' + '0'.repeat(64)), (e) => e.code === 'not-found')
    await assert.rejects(() => cc.get({ cid: 'no-es-un-cid' }), (e) => e.code === 'bad-input')
  })
})

test('una referencia de OTRO dueño no se pide a mi node', async () => {
  await withClient(async (cc) => {
    const ref = await cc.put('mío', { encrypt: false })
    await assert.rejects(() => cc.get({ ...ref, owner: 'sha256-otrodueño' }), (e) => e.code === 'not-mine')
  })
})

test('la tarjeta se compone desde el cliente: acl, meta y miniatura enlazada', async () => {
  await withClient(async (cc, node) => {
    const foto = await cc.put('unos bytes de foto', { mime: 'image/png', encrypt: false })
    const mini = await cc.put('la miniatura', { mime: 'image/webp', encrypt: false, acl: 'public' })
    await cc.setMeta(foto.cid, { title: 'Mi foto' })
    await cc.setThumbnail(foto.cid, mini.cid)
    await cc.setAcl(foto.cid, 'public')

    const row = node.stat(foto.cid)
    assert.equal(row.acl, 'public')
    assert.equal(row.thumbnailCid, mini.cid)
    assert.equal(JSON.parse(row.meta).title, 'Mi foto')
  })
})

test('pin, list, stats y remove pasan por el mismo canal', async () => {
  await withClient(async (cc, node) => {
    const ref = await cc.put('para retener', { encrypt: false })
    await cc.pin(ref.cid)
    assert.equal(node.stat(ref.cid).pinned, 1)
    assert.equal((await cc.list()).length, 1)
    assert.equal((await cc.stats()).blobs, 1)
    await cc.remove(ref.cid)
    assert.equal(node.stat(ref.cid), null)
  })
})

test('matchesCid es la comprobación que hace verificable el direccionado por hash', async () => {
  const bytes = new TextEncoder().encode('hola')
  const cid = 'sha256-b221d9dbb083a7f33428d7c2a3c3198ae925614d70210e28716ccaa7cd4ddb79'
  assert.equal(await matchesCid(bytes, cid), true)
  assert.equal(await matchesCid(new TextEncoder().encode('holA'), cid), false)
})
