/**
 * Qué almacén monta el node, y las comprobaciones que lo protegen (§15.14 y §15.15).
 *
 * Sin bucket de mentira: lo que se prueba aquí es la DECISIÓN —qué se monta con qué
 * configuración y cuándo se niega a usar el bucket—, que es plana y es donde se
 * equivoca uno. Hablar con un bucket se prueba contra uno de verdad, aparte.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { storageConfig, checkBuckets, openStore } from '../src/storage.js'

const CREDS = {
  CONTENT_S3_ENDPOINT: 'https://cuenta.r2.cloudflarestorage.com',
  CONTENT_S3_BUCKET_PRIVATE: 'privado',
  CONTENT_S3_KEY_ID: 'k',
  CONTENT_S3_SECRET: 's'
}
const dir = () => mkdtemp(path.join(tmpdir(), 'dstore-'))

test('sin CONTENT_STORAGE, disco y nada más', () => {
  assert.equal(storageConfig({}).kind, 'local')
  assert.deepEqual(storageConfig({}).missing, [])
})

test('el valor nombra al proveedor, y de ahí sale su región', () => {
  assert.equal(storageConfig({ CONTENT_STORAGE: 'r2', ...CREDS }).region, 'auto',
    'con r2 no hace falta escribir la región')
  assert.equal(storageConfig({ CONTENT_STORAGE: 'r2', ...CREDS, CONTENT_S3_REGION: 'x' }).region, 'x',
    'pero si la escribes, manda la tuya')
  assert.equal(storageConfig({ CONTENT_STORAGE: 'R2 ', ...CREDS }).kind, 'r2', 'sin importar mayúsculas ni espacios')
})

test('un proveedor desconocido no se inventa: se queda en local y lo dice', async () => {
  const d = await dir(); const said = []
  const { store } = await openStore({ dir: d, env: { CONTENT_STORAGE: 'dropbox' }, log: (m) => said.push(m) })
  assert.equal(store.backed, false)
  assert.match(said.join('\n'), /no es un proveedor conocido/)
  await rm(d, { recursive: true, force: true })
})

test('faltando una credencial NO arranca a medias', async () => {
  const d = await dir(); const said = []
  const { store } = await openStore({
    dir: d,
    env: { CONTENT_STORAGE: 'r2', ...CREDS, CONTENT_S3_SECRET: '' },
    log: (m) => said.push(m)
  })
  assert.equal(store.backed, false, 'se queda en disco')
  assert.match(said.join('\n'), /CONTENT_S3_SECRET/, 'y dice exactamente qué falta')
  await rm(d, { recursive: true, force: true })
})

test('el bucket público a medias también es un error', () => {
  const cfg = storageConfig({ CONTENT_STORAGE: 'r2', ...CREDS, CONTENT_S3_BUCKET_PUBLIC: 'publico' })
  assert.deepEqual(cfg.missing,
    ['CONTENT_S3_PUBLIC_KEY_ID', 'CONTENT_S3_PUBLIC_SECRET', 'CONTENT_PUBLIC_BASE_URL'],
    'declarar el bucket público obliga a completarlo: no se publica «casi»')
})

test('sin bucket público no falta nada: lo público viaja por la red', () => {
  const cfg = storageConfig({ CONTENT_STORAGE: 'r2', ...CREDS })
  assert.deepEqual(cfg.missing, [])
  assert.equal(cfg.pub, null)
})

// --- las tres comprobaciones (§15.15) ---------------------------------------
// La respuesta del bucket se fija a mano porque lo que se prueba es CÓMO SE LEE esa
// respuesta, no el bucket. Un 404 sin credenciales significa «cualquiera puede leer
// los objetos que sí existen», y esa lectura es justo la que hay que dejar clavada.

const fakeBucket = { urlFor: (k) => 'https://cuenta.r2.cloudflarestorage.com/privado/' + k }
const answers = (status) => async () => ({ status, ok: status >= 200 && status < 300, headers: new Map() })

test('el mismo bucket para lo privado y lo público es fatal', async () => {
  const cfg = storageConfig({ CONTENT_STORAGE: 'r2', ...CREDS, CONTENT_S3_BUCKET_PUBLIC: 'privado' })
  const r = await checkBuckets(cfg, { priv: fakeBucket, pub: fakeBucket }, answers(403))
  assert.equal(r.ok, false)
  assert.match(r.fatal.join(), /son el mismo/)
})

test('un bucket privado que contesta sin credenciales está ABIERTO', async () => {
  const cfg = storageConfig({ CONTENT_STORAGE: 'r2', ...CREDS })
  const open_ = await checkBuckets(cfg, { priv: fakeBucket, pub: null }, answers(404))
  assert.equal(open_.ok, false, '404 = el bucket contesta, solo que ese objeto no está')
  assert.match(open_.fatal.join(), /abierto al mundo/)

  const closed = await checkBuckets(cfg, { priv: fakeBucket, pub: null }, answers(403))
  assert.equal(closed.ok, true, '403 = no autorizado, que es lo que queremos')
})

test('el camino público se comprueba subiendo y leyendo, no mirando el error', async () => {
  const cfg = storageConfig({
    CONTENT_STORAGE: 'r2', ...CREDS,
    CONTENT_S3_BUCKET_PUBLIC: 'publico', CONTENT_S3_PUBLIC_KEY_ID: 'k', CONTENT_S3_PUBLIC_SECRET: 's',
    CONTENT_PUBLIC_BASE_URL: 'https://c.dotrino.com'
  })
  const uploaded = []
  const pub = { urlFor: fakeBucket.urlFor, put: async (k) => { uploaded.push(k); return { etag: '"x"' } } }

  // Lo que devuelve un dominio que NO llega al bucket. Da igual si es la página de
  // GitHub o la de Cloudflare: lo que delata es que no devuelve lo que se subió.
  const notConnected = async (u) => (String(u).includes('c.dotrino.com')
    ? { status: 404, ok: false, headers: new Map(), text: async () => '<!doctype html>…' }
    : answers(403)())
  const bad = await checkBuckets(cfg, { priv: fakeBucket, pub }, notConnected)
  assert.equal(bad.ok, true, 'no es fatal: lo privado sigue funcionando')
  assert.match(bad.warn.join(), /no sirve lo que hay en/)
  assert.equal(uploaded.length, 1, 'y la sonda se subió una sola vez')
  assert.match(uploaded[0], /^sha256-[0-9a-f]{64}$/, 'con su hash por nombre: repetirla no ensucia el bucket')

  const connected = async (u) => (String(u).includes('c.dotrino.com')
    ? { status: 200, ok: true, headers: new Map(), text: async () => 'dotrino!' }
    : answers(403)())
  const good = await checkBuckets(cfg, { priv: fakeBucket, pub }, connected)
  assert.deepEqual(good.warn, [], 'y si el dominio devuelve la sonda, no hay nada que avisar')
})

test('si no se puede comprobar, se avisa pero no se bloquea', async () => {
  const cfg = storageConfig({ CONTENT_STORAGE: 'r2', ...CREDS })
  const r = await checkBuckets(cfg, { priv: fakeBucket, pub: null }, async () => { throw new Error('sin red') })
  assert.equal(r.ok, true, 'quedarse sin almacén porque el nodo no tiene red sería peor')
  assert.match(r.warn.join(), /sin red/)
})
