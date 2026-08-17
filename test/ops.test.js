/**
 * Pruebas del plano de control (Fase 2): el despachador de operaciones, que es
 * donde vive la lógica. El transporte y la autorización se prueban aparte
 * (`agent.test.js`), contra el middleware de verdad.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { ContentNode } from '../src/node.js'
import { createOps, ACL } from '../src/ops.js'

const OWNER = 'abcdef0123456789'

async function withNode (fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'content-ops-'))
  const node = await new ContentNode({ dir, owner: OWNER }).init()
  try {
    await fn(node, createOps(node, { owner: OWNER, version: '0.1.0' }))
  } finally {
    node.close()
    await rm(dir, { recursive: true, force: true })
  }
}

const put = (node, body, opts) => node.put(Readable.from([Buffer.from(body)]), opts)

test('hello dice quién es el node y estampa el owner en lo que se sube', async () => {
  await withNode(async (node, ops) => {
    const hi = await ops({ op: 'hello', rid: 1 })
    assert.equal(hi.ok, true)
    assert.equal(hi.rid, 1)
    assert.equal(hi.owner, OWNER)
    assert.equal(hi.version, '0.1.0')

    const { cid } = await put(node, 'hola')
    assert.equal(node.stat(cid).owner, OWNER)
  })
})

test('list y stat devuelven el acl, y stat de un cid que no existe da not-found', async () => {
  await withNode(async (node, ops) => {
    const { cid } = await put(node, 'contenido')
    const list = await ops({ op: 'list', rid: 2 })
    assert.equal(list.blobs.length, 1)
    assert.equal(list.blobs[0].cid, cid)
    assert.equal(list.blobs[0].acl, null)

    const st = await ops({ op: 'stat', rid: 3, cid })
    assert.equal(st.blob.cid, cid)

    const nope = await ops({ op: 'stat', rid: 4, cid: 'sha256-' + 'a'.repeat(64) })
    assert.equal(nope.ok, false)
    assert.equal(nope.code, 'not-found')
  })
})

test('sin cid es bad-request; con un cid de forma inválida, not-found', async () => {
  await withNode(async (node, ops) => {
    const bad = await ops({ op: 'pin', rid: 5, cid: 'no-es-un-cid' })
    assert.equal(bad.ok, false)
    assert.equal(bad.code, 'not-found')   // stat() ya filtra la forma → no existe
    const missing = await ops({ op: 'pin', rid: 6 })
    assert.equal(missing.code, 'bad-request')
  })
})

test('pin protege del GC y unpin lo devuelve a la cola de desalojo', async () => {
  await withNode(async (node, ops) => {
    const { cid } = await put(node, 'algo', { ttl: Date.now() - 1 })   // ya vencido
    assert.equal((await ops({ op: 'pin', rid: 7, cid })).pinned, true)

    node.gc()
    assert.ok(node.stat(cid), 'un blob pineado no lo borra el GC ni estando vencido')

    assert.equal((await ops({ op: 'unpin', rid: 8, cid })).pinned, false)
    node.gc()
    assert.equal(node.stat(cid), null, 'sin pin, el vencido se va')
  })
})

test('acl: público es opt-in explícito y un blob cifrado no puede ser público', async () => {
  await withNode(async (node, ops) => {
    const { cid } = await put(node, 'publicable')
    assert.equal(node.stat(cid).acl, null, 'nace sin acl = privado')

    const pub = await ops({ op: 'acl', rid: 9, cid, acl: ACL.PUBLIC })
    assert.equal(pub.ok, true)
    assert.equal(node.stat(cid).acl, 'public')

    const priv = await ops({ op: 'acl', rid: 10, cid, acl: ACL.PRIVATE })
    assert.equal(priv.ok, true)
    assert.equal(node.stat(cid).acl, 'private')

    const bogus = await ops({ op: 'acl', rid: 11, cid, acl: 'sí' })
    assert.equal(bogus.code, 'bad-request')

    const { cid: enc } = await put(node, 'cifrado', { enc: 1 })
    const nope = await ops({ op: 'acl', rid: 12, cid: enc, acl: ACL.PUBLIC })
    assert.equal(nope.ok, false)
    assert.equal(nope.code, 'bad-request')
    assert.equal(node.stat(enc).acl, null, 'y no lo cambió a medias')
  })
})

test('volver a subir los mismos bytes NO reabre un blob que se cerró', async () => {
  await withNode(async (node, ops) => {
    const { cid } = await put(node, 'mismos bytes')
    await ops({ op: 'acl', rid: 13, cid, acl: ACL.PRIVATE })
    const again = await put(node, 'mismos bytes')
    assert.equal(again.cid, cid)
    assert.equal(again.existed, true)
    assert.equal(node.stat(cid).acl, 'private', 'el acl sobrevive al re-put')
  })
})

test('remove borra, y stats/gc responden', async () => {
  await withNode(async (node, ops) => {
    const { cid } = await put(node, 'para borrar')
    assert.equal((await ops({ op: 'stats', rid: 14 })).stats.blobs, 1)

    const del = await ops({ op: 'remove', rid: 15, cid })
    assert.equal(del.removed, cid)
    assert.equal(node.stat(cid), null)

    assert.equal((await ops({ op: 'gc', rid: 16 })).ok, true)
    assert.equal((await ops({ op: 'stats', rid: 17 })).stats.blobs, 0)
  })
})

test('una op desconocida se rechaza por code, no por la frase', async () => {
  await withNode(async (node, ops) => {
    assert.equal((await ops({ op: 'put', rid: 18 })).code, 'unknown-op')
    assert.equal((await ops({ rid: 19 })).code, 'bad-request')
    assert.equal((await ops(null)).code, 'bad-request')
  })
})
