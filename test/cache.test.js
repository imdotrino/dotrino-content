/**
 * La caché: lo que cambia cuando el disco deja de ser el almacén (DISENO.md §15.11).
 *
 * Todo lo de aquí corre contra el código de verdad —índice SQLite real y blobs en
 * disco real—, sin dobles. Lo que toca al bucket se prueba contra un bucket de
 * verdad cuando exista el backend; aquí se prueba la POLÍTICA, que es lo que se
 * puede equivocar sin que nadie lo note.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { ContentNode } from '../src/node.js'
import { Index } from '../src/db.js'

let dir, node
const put = (txt, opts) => node.put(Readable.from([Buffer.from(txt)]), opts)

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'dcache-'))
  node = await new ContentNode({ dir }).init()
})

after(async () => {
  node.close()
  await rm(dir, { recursive: true, force: true })
})

test('leer anota el acceso: es lo que ordena el desalojo', async () => {
  const { cid } = await put('leeme')
  assert.equal(node.stat(cid).lastRead, null, 'recién subido, nunca leído')
  node.read(cid).destroy()
  assert.ok(node.stat(cid).lastRead > 0, 'leerlo deja marca')
})

test('el desalojo va por USO, no por antigüedad', async () => {
  const viejo = (await put('el viejo, pero muy pedido')).cid
  const nuevo = (await put('el nuevo, que nadie mira')).cid

  node.index.touch(viejo, Date.now())          // se lee ahora
  node.index.touch(nuevo, Date.now() - 60_000) // se leyó hace un minuto

  const orden = node.index.evictable().map((b) => b.cid)
  assert.ok(orden.indexOf(nuevo) < orden.indexOf(viejo),
    'el menos usado sale primero, aunque sea el más nuevo')
})

test('lo que nunca se leyó cuenta por su fecha de subida', async () => {
  const d = await mkdtemp(path.join(tmpdir(), 'dcache2-'))
  const ix = new Index(d)
  ix.upsert({ cid: 'sha256-' + 'a'.repeat(64), size: 1, mime: 'application/octet-stream' })
  ix.upsert({ cid: 'sha256-' + 'b'.repeat(64), size: 1, mime: 'application/octet-stream' })
  ix.touch('sha256-' + 'a'.repeat(64), Date.now() + 60_000) // el primero, leído después
  assert.equal(ix.evictable()[0].cid, 'sha256-' + 'b'.repeat(64))
  ix.close()
  await rm(d, { recursive: true, force: true })
})

test('sin confirmación del bucket no se desaloja NADA (el cerrojo)', async () => {
  const d = await mkdtemp(path.join(tmpdir(), 'dcache3-'))
  const ix = new Index(d)
  const subido = 'sha256-' + 'c'.repeat(64)
  const pendiente = 'sha256-' + 'd'.repeat(64)
  ix.upsert({ cid: subido, size: 10, mime: 'application/octet-stream' })
  ix.upsert({ cid: pendiente, size: 10, mime: 'application/octet-stream' })
  ix.setRemote(subido, true)

  assert.deepEqual(ix.evictable({ requireRemote: true }).map((b) => b.cid), [subido],
    'lo que el bucket no ha confirmado no es desalojable: su única copia es esta')
  assert.equal(ix.evictable().length, 2, 'sin bucket detrás, la condición no aplica')

  assert.deepEqual(ix.pendingUpload().map((b) => b.cid), [pendiente],
    'y lo no confirmado es, exactamente, la cola de subida')
  ix.close()
  await rm(d, { recursive: true, force: true })
})

test('la cuota mira el disco, no el inventario', async () => {
  const d = await mkdtemp(path.join(tmpdir(), 'dcache4-'))
  const ix = new Index(d)
  const aqui = 'sha256-' + 'e'.repeat(64)
  const desalojado = 'sha256-' + 'f'.repeat(64)
  ix.upsert({ cid: aqui, size: 100, mime: 'application/octet-stream' })
  ix.upsert({ cid: desalojado, size: 900, mime: 'application/octet-stream' })
  ix.setCached(desalojado, false)

  assert.equal(ix.cachedBytes(), 100, 'lo desalojado ya no ocupa disco')
  assert.equal(ix.totalBytes(), 1000, 'pero sigue existiendo en el inventario')
  assert.equal(ix.evictable().length, 1, 'y no se puede desalojar dos veces')
  ix.close()
  await rm(d, { recursive: true, force: true })
})

test('sin bucket, el GC sigue destruyendo: no hay segunda copia que fingir', async () => {
  const d = await mkdtemp(path.join(tmpdir(), 'dcache6-'))
  const solo = await new ContentNode({ dir: d }).init()
  const { cid } = await solo.put(Readable.from([Buffer.from('esto se va del todo')]))

  assert.ok(solo.gc({ needBytes: 1 }).freed > 0)
  assert.equal(solo.stat(cid), null, 'sin bucket, desalojar ES destruir, y la fila se va')
  solo.close()
  await rm(d, { recursive: true, force: true })
})

test('un índice viejo se migra solo y estrena las columnas', async () => {
  const d = await mkdtemp(path.join(tmpdir(), 'dcache5-'))
  const antes = new Index(d)
  antes.upsert({ cid: 'sha256-' + '9'.repeat(64), size: 5, mime: 'application/octet-stream' })
  antes.close()

  const despues = new Index(d) // vuelve a abrir: corre las migraciones
  const fila = despues.get('sha256-' + '9'.repeat(64))
  assert.equal(fila.remote, 0, 'lo que ya estaba no está en ningún bucket')
  assert.equal(fila.cached, 1, 'pero sí está en disco')
  assert.equal(fila.lastRead, null)
  despues.close()
  await rm(d, { recursive: true, force: true })
})
