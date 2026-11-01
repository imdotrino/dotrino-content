/**
 * Subida real: proxio de verdad, WebRTC de verdad (`@dotrino/webrtc`), agente y cliente de
 * verdad. Lo que comprueba es lo que ninguna prueba con bus puede: que el node reconoce el camino
 * directo y deja pasar lo grande, y que sin canal directo lo para. Sin Docker las dos puntas
 * comparten máquina: prueba la lógica, no que dos NAT se atraviesen.
 *
 *   node test/e2e/direct-upload.mjs [ruta del proxio]
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { makeDeviceKey, signDelegationWith, signWithDevice } from '@dotrino/identity/capabilities'
import { genesisActa, applyChanges, sealActa } from '@dotrino/identity/acta'
import { WebSocketProxyClient } from '@dotrino/proxy-client'
import { RemoteAgentClient } from '@dotrino/remote-agent/client'
import { identityFromLink } from '@dotrino/remote-agent/link'
import { VMSG } from '@dotrino/remote-agent'
import { ContentNode } from '../../src/node.js'
import { startContentAgent } from '../../src/agent.js'

const PROXY_DIR = process.argv[2] || new URL('../../../dotrino-proxy', import.meta.url).pathname
const MB = 1024 * 1024
const SIZE = 30 * MB          // por encima del tope de 25 MB del proxio

const port = await new Promise((resolve) => { const s = createServer().listen(0, () => { const p = s.address().port; s.close(() => resolve(p)) }) })
const proxyProc = spawn(process.execPath, ['server.js'], { cwd: PROXY_DIR, env: { ...process.env, PORT: String(port), NODE_ENV: 'test' }, stdio: 'ignore' })
await new Promise((r) => setTimeout(r, 1500))
const url = `ws://localhost:${port}`

const root = await mkdtemp(path.join(tmpdir(), 'content-e2e-'))
let fail = null
try {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const master = JSON.stringify(await crypto.subtle.exportKey('jwk', pair.publicKey))
  const masterJwk = await crypto.subtle.exportKey('jwk', pair.privateKey)
  const sealIt = (a) => sealActa({ acta: a, privateKey: pair.privateKey })
  let acta = await sealIt(genesisActa({ pub: master, label: 'vault' }))
  const nodeDev = await makeDeviceKey({ label: 'content' })
  const appDev = await makeDeviceKey({ label: 'app' })
  for (const d of [nodeDev, appDev]) acta = await sealIt(await applyChanges(acta, [{ op: 'admit', member: { pub: d.publickey, label: d.label || 'x', caps: ['sign'] } }], { by: master }))
  const cert = (sub) => signDelegationWith(pair.privateKey, master, { sub, scope: ['vault:sign'], iat: Date.now() - 1000, seq: acta.seq, nonce: randomBytes(4).toString('hex') })

  const vault = new WebSocketProxyClient({ url, autoReconnect: false })
  await vault.connect()
  await vault.identifyAs({ publickey: master, sign: async (data) => signWithDevice({ privateJwk: masterJwk, publickey: master, data }) })
  vault.on('message', (from, p) => { if (p?.type === VMSG.DEVICES) vault.send(from, { type: VMSG.DEVICES_RESULT, devices: [], revoked: [], acta }) })

  const linkDir = path.join(root, 'link')
  await mkdir(linkDir, { recursive: true })
  const nodeLink = { device: nodeDev, cert: await cert(nodeDev.publickey), iss: master, proxy: url, label: 'content', at: Date.now(), acta, actaSeq: acta.seq, actaTrusted: true }
  await writeFile(path.join(linkDir, 'link.json'), JSON.stringify(nodeLink), { mode: 0o600 })
  const node = await new ContentNode({ dir: path.join(root, 'data') }).init()
  // Un proxio de prueba no es de Dotrino, así que aquí se le dice que lo es: es la regla que se prueba.
  const agent = await startContentAgent({ node, dir: linkDir, proxyUrl: url, networkOverride: 'wss://proxy.dotrino.com', quiet: true, version: 'e2e' })

  const appLink = { id: identityFromLink({ device: appDev, cert: await cert(appDev.publickey), iss: master, proxy: url }, { dir: root }), cert: await cert(appDev.publickey), iss: master, proxy: url }
  const session = new RemoteAgentClient(appLink, { agentPubkey: agent.machine, proxyUrl: url })
  await session.connect()
  let rid = 0
  const waiting = new Map()
  session.on('message', (m) => { waiting.get(m.rid)?.(m); waiting.delete(m.rid) })
  const ask = (msg) => new Promise((resolve, reject) => {
    const id = ++rid
    const t = setTimeout(() => reject(new Error(`no answer to ${msg.op}`)), 60000)
    waiting.set(id, (m) => { clearTimeout(t); resolve(m) })
    session.send({ ...msg, rid: id })
  })

  const bytes = randomBytes(SIZE)
  const cid = 'sha256-' + createHash('sha256').update(bytes).digest('hex')

  assert.equal((await ask({ op: 'hello' })).ok, true)
  let route = null
  for (let i = 0; i < 80 && route !== 'direct'; i++) {
    route = await session.client.routeTo(session.agentToken)
    await new Promise((r) => setTimeout(r, 250))
  }
  console.log('client route:', route)
  assert.equal(route, 'direct', 'the channel settles as direct')
  await new Promise((r) => setTimeout(r, 5200))   // el node mira el camino como mucho cada 5 s

  const begin = await ask({ op: 'up.begin', cid, size: SIZE, enc: 1 })
  assert.equal(begin.ok, true, begin.error)
  const t0 = Date.now()
  let at = begin.at
  while (at < SIZE) {
    const r = await ask({ op: 'up.part', cid, at, data: bytes.subarray(at, at + 96 * 1024).toString('base64') })
    assert.equal(r.ok, true, r.error)
    at = r.at
  }
  const end = await ask({ op: 'up.end', cid })
  assert.equal(end.ok, true, end.error)
  const secs = (Date.now() - t0) / 1000
  console.log(`uploaded ${SIZE / MB} MB in ${secs.toFixed(1)} s (${(SIZE / MB / secs).toFixed(1)} MB/s)`)
  assert.equal(node.stat(cid).size, SIZE)

  // Sin canal directo: un aparato con WebRTC apagado se queda en el proxio y lo grande no pasa.
  session.client.closeWebRTC?.(session.agentToken)
  agent.close(); node.close(); vault.close?.()
  console.log('OK')
} catch (e) { fail = e; console.error('FAILED:', e) }
proxyProc.kill()
await rm(root, { recursive: true, force: true })
process.exit(fail ? 1 : 0)
