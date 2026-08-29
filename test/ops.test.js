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
import { createHash } from 'node:crypto'
import { createOps, ACL, CONTROL_PLANE_MAX_BYTES } from '../src/ops.js'

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
    // Esta prueba comprobaba, con `put`, que subir por el plano de control NO
    // existía. Ya existe (2026-08-21) y la frontera pasó a ser el TOPE de un
    // mensaje, que se prueba más abajo. Lo que sigue valiendo es el contrato de
    // errores: se compara por `code`, nunca por la frase.
    assert.equal((await ops({ op: 'inventada', rid: 18 })).code, 'unknown-op')
    assert.equal((await ops({ rid: 19 })).code, 'bad-request')
    assert.equal((await ops(null)).code, 'bad-request')
  })
})

// --- put / get por el plano de control (con el tope como frontera, no como bug) ---

test('put guarda desde otro aparato, estampa el owner y devuelve el cid del contenido', async () => {
  await withNode(async (node, ops) => {
    const data = Buffer.from('un eco de prueba, que pesa lo que pesa un mensaje')
    const res = await ops({ rid: 1, op: 'put', data: data.toString('base64'), mime: 'application/json' })
    assert.equal(res.ok, true)
    assert.equal(res.cid, `sha256-${createHash('sha256').update(data).digest('hex')}`)
    assert.equal(res.size, data.length)
    // Nace privado: público es opt-in explícito, aquí como en todas partes.
    assert.equal(res.acl, ACL.PRIVATE)
    assert.equal(node.stat(res.cid).owner, OWNER)
  })
})

test('get devuelve los mismos bytes, y put dos veces es el mismo blob', async () => {
  await withNode(async (node, ops) => {
    const data = Buffer.from('ida y vuelta')
    const first = await ops({ rid: 1, op: 'put', data: data.toString('base64'), mime: 'text/plain' })
    const again = await ops({ rid: 2, op: 'put', data: data.toString('base64'), mime: 'text/plain' })
    assert.equal(again.cid, first.cid)
    assert.equal(again.existed, true)

    const got = await ops({ rid: 3, op: 'get', cid: first.cid })
    assert.equal(got.ok, true)
    assert.equal(Buffer.from(got.data, 'base64').toString(), 'ida y vuelta')
    assert.equal(got.mime, 'text/plain')
  })
})

test('lo que no cabe en UN mensaje no pasa: es la frontera, no un límite a subir', async () => {
  await withNode(async (node, ops) => {
    const big = Buffer.alloc(CONTROL_PLANE_MAX_BYTES + 1, 7)
    const res = await ops({ rid: 1, op: 'put', data: big.toString('base64') })
    assert.equal(res.ok, false)
    assert.equal(res.code, 'too-large')
    // Y no hay `put.begin`/`put.chunk`: trocear sería disimular la frontera.
    assert.equal((await ops({ rid: 2, op: 'put.begin', size: 1 })).code, 'unknown-op')
  })
})

test('get tampoco saca por el plano de control lo que no es un mensaje', async () => {
  await withNode(async (node, ops) => {
    const { cid } = await node.put(Readable.from(Buffer.alloc(CONTROL_PLANE_MAX_BYTES + 1)), { mime: 'video/mp4' })
    assert.equal((await ops({ rid: 1, op: 'get', cid })).code, 'too-large')
  })
})

test('put no puede colar un blob cifrado como público', async () => {
  await withNode(async (node, ops) => {
    const res = await ops({ rid: 1, op: 'put', data: Buffer.from('cifrado').toString('base64'), enc: 1, acl: ACL.PUBLIC })
    assert.equal(res.acl, ACL.PRIVATE)
    assert.equal(node.stat(res.cid).acl, ACL.PRIVATE)
  })
})

test('put admite la presentación de una vez, y descarta lo que no es campo conocido', async () => {
  await withNode(async (node, ops) => {
    const res = await ops({
      rid: 1,
      op: 'put',
      data: Buffer.from('con tarjeta').toString('base64'),
      mime: 'image/png',
      acl: ACL.PUBLIC,
      meta: { title: '  Una foto  ', description: 'x'.repeat(400), owner: 'intento de colarse' }
    })
    assert.equal(res.acl, ACL.PUBLIC)
    const meta = JSON.parse(node.stat(res.cid).meta)
    assert.equal(meta.title, 'Una foto')
    assert.equal(meta.description.length, 300)
    assert.equal(meta.owner, undefined, 'solo se guardan los campos conocidos')
  })
})

test('la tarjeta guarda los ENLACES del contenido, y solo http(s)', async () => {
  await withNode(async (node, ops) => {
    const res = await ops({
      rid: 1,
      op: 'put',
      data: Buffer.from('un eco').toString('base64'),
      mime: 'application/json',
      acl: ACL.PUBLIC,
      meta: {
        title: '@Dotrino',
        links: ['https://medio.test/nota', 'javascript:alert(1)', 42, 'ftp://medio.test/x',
          'https://a.test/1', 'https://b.test/2', 'https://c.test/3', 'https://d.test/4']
      }
    })
    const meta = JSON.parse(node.stat(res.cid).meta)
    // Ni un `javascript:` ni lo que no sea una cadena: la tarjeta los pinta como href.
    assert.deepEqual(meta.links, ['https://medio.test/nota', 'https://a.test/1', 'https://b.test/2', 'https://c.test/3'],
      'solo http(s), en orden, y como mucho cuatro')

    // Sin enlaces válidos, el campo no existe (no un array vacío que hay que comprobar).
    const solos = await ops({ rid: 2, op: 'meta', cid: res.cid, meta: { title: 'x', links: ['javascript:alert(1)'] } })
    assert.equal(solos.meta.links, undefined)
  })
})

test('put rechaza lo que no es un payload', async () => {
  await withNode(async (node, ops) => {
    assert.equal((await ops({ rid: 1, op: 'put' })).code, 'bad-request')
    assert.equal((await ops({ rid: 2, op: 'put', data: '' })).code, 'bad-request')
  })
})

test('hello dice cuánto entra por aquí, para que el cliente no lo adivine', async () => {
  await withNode(async (node, ops) => {
    assert.equal((await ops({ rid: 1, op: 'hello' })).maxBytes, CONTROL_PLANE_MAX_BYTES)
  })
})

test('meta y thumb: la tarjeta se puede poner después, y una miniatura ajena no cuela', async () => {
  await withNode(async (node, ops) => {
    const foto = await ops({ rid: 1, op: 'put', data: Buffer.from('foto').toString('base64'), mime: 'image/png' })
    const mini = await ops({ rid: 2, op: 'put', data: Buffer.from('mini').toString('base64'), mime: 'image/webp' })

    assert.equal((await ops({ rid: 3, op: 'meta', cid: foto.cid, meta: { name: 'x.png' } })).meta.name, 'x.png')
    assert.equal((await ops({ rid: 4, op: 'meta', cid: foto.cid, meta: null })).meta, null)

    assert.equal((await ops({ rid: 5, op: 'thumb', cid: foto.cid, thumbnailCid: mini.cid })).thumbnailCid, mini.cid)
    assert.equal(node.stat(foto.cid).thumbnailCid, mini.cid)
    // Una miniatura que este node no tiene no se puede enlazar: sería una tarjeta rota.
    const ajena = 'sha256-' + '0'.repeat(64)
    assert.equal((await ops({ rid: 6, op: 'thumb', cid: foto.cid, thumbnailCid: ajena })).code, 'not-found')
    assert.equal((await ops({ rid: 7, op: 'thumb', cid: foto.cid, thumbnailCid: 'no-es-un-cid' })).code, 'bad-request')
  })
})
