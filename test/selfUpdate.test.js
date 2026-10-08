/**
 * EL NODE SE ACTUALIZA SOLO (CONVENCIONES §15). Lo que hace el trabajo es de
 * `@dotrino/update/npm` y de `@dotrino/vault/service`, y tiene sus propias pruebas; aquí
 * se comprueba el PEGAMENTO, que es lo único de este repo: que el vigilante arranca con
 * la carpeta de esta instancia, que sin bóveda no se inventa a quién preguntar, que un
 * pedido vencido es un no y un fallo de red no lo es, y que la CLI guarda los dos ajustes.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { startSelfUpdate, vaultUpdateHooks, PKG, REPO } from '../src/selfUpdate.js'

const CLI = fileURLToPath(new URL('../bin/cli.js', import.meta.url))

/** Un vigilante de mentira: se queda con lo que le pasan y devuelve cómo «pararlo». */
function fakeWatch () {
  const seen = { opts: null, stopped: false }
  const watch = (opts) => { seen.opts = opts; return () => { seen.stopped = true } }
  return { seen, watch }
}

test('el vigilante arranca con el paquete, el repo y la carpeta de ESTA instancia', () => {
  const { seen, watch } = fakeWatch()
  const stop = startSelfUpdate({ version: '1.2.3', dir: '/datos/enlace', conn: () => ({ dir: '/datos/servicio' }), restart () {}, log () {}, watch })
  assert.equal(seen.opts.pkg, PKG)
  assert.equal(seen.opts.repo, REPO)
  assert.equal(seen.opts.current, '1.2.3')
  assert.equal(seen.opts.dir, '/datos/enlace')
  for (const k of ['mayUpdate', 'onUpdated', 'onNeedsRoot', 'onInstalled']) assert.equal(typeof seen.opts[k], 'function', k)
  stop()
  assert.equal(seen.stopped, true)
})

test('sin bóveda no hay ganchos: no se inventa a quién preguntar ni a quién avisar', () => {
  const { seen, watch } = fakeWatch()
  startSelfUpdate({ version: '1.2.3', dir: '/datos/enlace', conn: null, restart () {}, log () {}, watch })
  for (const k of ['mayUpdate', 'onUpdated', 'onNeedsRoot']) assert.equal(seen.opts[k], undefined, k)
  assert.equal(typeof seen.opts.onInstalled, 'function', 'instalar sigue funcionando sin bóveda')
})

test('solo se reinicia si hay quien lo levante', () => {
  const { seen, watch } = fakeWatch()
  const restarts = []
  const lines = []
  startSelfUpdate({ version: '1.2.3', dir: '/d', restart: (v) => restarts.push(v), log: (m) => lines.push(m), watch })
  seen.opts.onInstalled({ version: '1.3.0', from: '1.2.3', restart: false })
  assert.deepEqual(restarts, [], 'sin supervisor no se va')
  assert.match(lines.at(-1), /keeps running 1\.2\.3/)
  seen.opts.onInstalled({ version: '1.3.0', from: '1.2.3', restart: true })
  assert.deepEqual(restarts, ['1.3.0'])
})

test('preguntar: sí, no, vencido es no, y «no pude preguntar» se lanza', async () => {
  const calls = []
  let answer = async () => ({ ok: true, asked: true })
  const vault = {
    askUpdateApproval: (o) => { calls.push(o); return answer() },
    reportUpdated: async (o) => { calls.push({ done: o }); return { ok: true } },
    reportUpdateNeedsRoot: async (o) => { calls.push({ root: o }); return { ok: true } }
  }
  // La identidad se lee AL LLAMAR: el papel se renueva con el proceso en marcha.
  let cert = 'viejo'
  const h = vaultUpdateHooks({ product: PKG, conn: () => ({ dir: '/svc', cert }), vault })

  assert.equal(await h.mayUpdate({ version: '2.0.0', from: '1.0.0' }), true)
  assert.deepEqual(calls[0], { product: PKG, version: '2.0.0', from: '1.0.0', dir: '/svc', cert: 'viejo' })
  cert = 'renovado'
  answer = async () => ({ ok: false, asked: true })
  assert.equal(await h.mayUpdate({ version: '2.0.0', from: '1.0.0' }), false)
  assert.equal(calls[1].cert, 'renovado')

  answer = async () => { throw Object.assign(new Error('nobody answered'), { code: 'unanswered' }) }
  assert.equal(await h.mayUpdate({ version: '2.0.0', from: '1.0.0' }), false, 'vencido es no')

  answer = async () => { throw Object.assign(new Error('the vault did not answer'), { code: 'vault-no-reply' }) }
  await assert.rejects(() => h.mayUpdate({ version: '2.0.0', from: '1.0.0' }), (e) => e.code === 'vault-no-reply', 'no poder preguntar NO es una negativa')

  // Una respuesta que no dice que sí no es un sí.
  answer = async () => ({ asked: false })
  assert.equal(await h.mayUpdate({ version: '2.0.0', from: '1.0.0' }), false)

  await h.onUpdated({ version: '2.0.0', from: '1.0.0' })
  await h.onNeedsRoot({ version: '2.0.0', from: '1.0.0' })
  assert.deepEqual(calls.at(-2), { done: { product: PKG, version: '2.0.0', from: '1.0.0', dir: '/svc', cert: 'renovado' } })
  assert.deepEqual(calls.at(-1), { root: { product: PKG, version: '2.0.0', from: '1.0.0', dir: '/svc', cert: 'renovado' } })
})

test('CLI: `update` guarda los dos ajustes en la carpeta de la instancia y los enseña', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'content-upd-'))
  const run = (...args) => spawnSync(process.execPath, [CLI, 'update', ...args], { env: { ...process.env, DOTRINO_CONTENT_LINK_DIR: dir }, encoding: 'utf8' })
  try {
    let r = run()
    assert.equal(r.status, 0, r.stderr)
    assert.equal(r.stdout.trim().split('\n').length, 2, 'sin opciones, las dos líneas')

    r = run('--approval', 'on')
    assert.equal(r.status, 0, r.stderr)
    assert.equal(JSON.parse(await readFile(path.join(dir, 'update-prefs.json'), 'utf8')).approval, true)

    r = run('--notify', 'off')
    assert.equal(r.status, 0, r.stderr)
    const prefs = JSON.parse(await readFile(path.join(dir, 'update-prefs.json'), 'utf8'))
    assert.equal(prefs.notify, false)
    assert.equal(prefs.approval, true, 'cambiar uno no toca el otro')

    assert.equal(run('--approval', 'quizas').status, 2, 'un valor que no vale no guarda nada')
    assert.equal(run('--otra-cosa').status, 2)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('CLI: la ayuda nombra `update`', () => {
  const r = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' })
  assert.equal(r.status, 0)
  assert.match(r.stdout, /dotrino-content update \[--approval on\|off\] \[--notify on\|off\]/)
})
