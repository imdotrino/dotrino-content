/**
 * Extremo a extremo del plano de control (Fase 2), con las dos puntas de verdad:
 * el agente real (`@dotrino/remote-agent`, el mismo middleware que corre en
 * terminal e ia) contra un cliente que firma y cifra como lo hace una app.
 *
 * El único mentiroso es el transporte: un bus en memoria que enruta por token y por
 * pubkey como el proxy, más una bóveda de mentira que responde la lista de
 * revocados. Todo lo demás es código de producción: llaves ECDSA reales,
 * certificados firmados por una maestra real, `verifyChain` de verdad y sobres
 * AES-GCM de verdad.
 *
 * Lo que se prueba es lo que importa de esta fase: que un aparato del MISMO vault
 * puede administrar el node, y que uno certificado por OTRA maestra no puede nada.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { makeDeviceKey, signDelegationWith, signWithDevice } from '@dotrino/identity/capabilities'
import { HS, ACK, DATA, ERROR, VMSG, SIGN_SCOPE, makeEphemeral, deriveKey, seal, open } from '@dotrino/remote-agent'
import { ContentNode } from '../src/node.js'
import { startContentAgent } from '../src/agent.js'

const DAY = 86400000

/** Una maestra: par de claves + emisor de certificados de dispositivo. */
async function makeMaster () {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']
  )
  const publickey = JSON.stringify(await crypto.subtle.exportKey('jwk', pair.publicKey))
  let n = 0
  // ACTA mínima: el papel ya no vence por reloj, lleva el `seq` del acta con el que se
  // emitió, y quien verifica necesita saber quién puede sellar en este perfil.
  const acta = {
    v: 5, profileId: publickey, sealedBy: publickey, seq: 1,
    members: [{ pub: publickey, caps: ['sign', 'read', 'store', 'sealer'] }],
    renounced: []
  }
  const certFor = async (sub, scope = [SIGN_SCOPE], { admitir = true } = {}) => {
    if (admitir && !acta.members.some((m) => m.pub === sub)) acta.members.push({ pub: sub, caps: ['sign'] })
    return signDelegationWith(pair.privateKey, publickey, {
      sub, scope, iat: Date.now() - 1000, seq: acta.seq, nonce: 'n' + (++n)
    })
  }
  return { publickey, certFor, acta }
}

/**
 * Bus en memoria con la forma del cliente del proxy: enruta por token (`send`) y
 * por pubkey de quien se identificó (`sendByPubkey`).
 */
function makeBus () {
  const byToken = new Map()
  const byPubkey = new Map()
  const endpoint = (token) => {
    const handlers = { message: [], token: [] }
    const api = {
      token,
      on (ev, cb) {
        handlers[ev]?.push(cb)
        return () => { handlers[ev] = (handlers[ev] || []).filter((h) => h !== cb) }
      },
      async identify ({ data }) { byPubkey.set(data.publickey, token) },
      send (to, obj) { deliver(to, token, obj) },
      sendByPubkey (pubkey, obj) {
        const to = byPubkey.get(pubkey)
        if (to) deliver(to, token, obj)
      },
      close () { byToken.delete(token) },
      _emit (from, payload) { for (const h of handlers.message) h(from, payload) }
    }
    byToken.set(token, api)
    return api
  }
  const deliver = (to, from, obj) => {
    const ep = byToken.get(to)
    // Copia por JSON: el proxy entrega un objeto parseado, no la misma referencia.
    if (ep) setImmediate(() => ep._emit(from, JSON.parse(JSON.stringify(obj))))
  }
  return { endpoint }
}

/** Bóveda de mentira: solo lo que el agente le pregunta al arrancar. */
function fakeVault (bus, master) {
  const ep = bus.endpoint('vault-token')
  ep.identify({ data: { publickey: master.publickey } })
  ep.on('message', (from, p) => {
    // EL ACTA VIAJA CON LA LISTA, y sin ella el agente no puede juzgar a nadie: es con lo
    // que sabe quién puede sellar en este perfil. Antes bastaba con la maestra; ahora manda
    // el acta, y no mandarla significa «no sé quién eres» — que es lo correcto.
    if (p?.type === VMSG.DEVICES) ep.send(from, { type: VMSG.DEVICES_RESULT, devices: [], revoked: [], acta: master.acta })
  })
  return ep
}

/** Cliente: abre sesión cifrada con el agente y despacha operaciones. */
async function connectClient (bus, { device, cert, agentPubkey, token = 'client-token' }) {
  const ep = bus.endpoint(token)
  const eph = await makeEphemeral()
  const data = { op: HS, eph: eph.pub, publickey: device.publickey, ts: Date.now() }
  const { signature } = await signWithDevice({ privateJwk: device.privateJwk, data })

  const settled = new Promise((resolve, reject) => {
    const done = (fn, v) => { off(); clearTimeout(t); fn(v) }
    const off = ep.on('message', async (_from, p) => {
      if (p?.type === ACK) done(resolve, p)
      else if (p?.type === ERROR) done(reject, new Error(p.error))
    })
    const t = setTimeout(() => done(reject, new Error('timeout esperando el ack')), 5000)
  })
  ep.sendByPubkey(agentPubkey, { type: HS, data, signature, cert })

  const ack = await settled
  const key = await deriveKey(eph.privateKey, ack.ack.seph, ack.sid)
  let rid = 0
  return {
    async call (op, args = {}) {
      const mine = ++rid
      const answer = new Promise((resolve, reject) => {
        const off = ep.on('message', async (_from, p) => {
          if (p?.type !== DATA || p.sid !== ack.sid) return
          const msg = await open(key, p.env).catch(() => null)
          if (msg?.rid === mine) { off(); clearTimeout(t); resolve(msg) }
        })
        const t = setTimeout(() => { off(); reject(new Error(`timeout en ${op}`)) }, 5000)
      })
      ep.sendByPubkey(agentPubkey, { type: DATA, sid: ack.sid, env: await seal(key, { op, rid: mine, ...args }) })
      return answer
    }
  }
}

async function setup () {
  const root = await mkdtemp(path.join(tmpdir(), 'content-agent-'))
  const dataDir = path.join(root, 'data')
  const linkDir = path.join(root, 'link')
  await mkdir(linkDir, { recursive: true })

  const master = await makeMaster()
  // El aparato de la app entra en el acta ANTES de que arranque el agente: el agente se
  // queda con el acta que le da la bóveda en su primer tic, igual que en producción. Un
  // miembro añadido después no le llega hasta el siguiente refresco, y eso es correcto —
  // su política es tan fresca como su última consulta.
  const appDevice = await makeDeviceKey({ label: 'app' })
  await master.certFor(appDevice.publickey)   // lo admite en el acta
  const nodeDevice = await makeDeviceKey({ label: 'content' })
  const link = {
    device: nodeDevice,
    cert: await master.certFor(nodeDevice.publickey),
    iss: master.publickey,
    proxy: 'ws://bus',
    label: 'content',
    at: Date.now()
  }
  await writeFile(path.join(linkDir, 'link.json'), JSON.stringify(link), { mode: 0o600 })

  const bus = makeBus()
  fakeVault(bus, master)
  const node = await new ContentNode({ dir: dataDir }).init()
  const agent = await startContentAgent({
    node, dir: linkDir, quiet: true, client: bus.endpoint('agent-token'), version: 'test'
  })

  return {
    root, node, agent, master, bus, appDevice,
    async cleanup () {
      agent.close(); node.close()
      await rm(root, { recursive: true, force: true })
    }
  }
}

test('un aparato del mismo vault administra el node por el canal cifrado', async () => {
  const s = await setup()
  try {
    const app = s.appDevice   // ya estaba en el acta antes de arrancar el agente
    const client = await connectClient(s.bus, {
      device: app, cert: await s.master.certFor(app.publickey), agentPubkey: s.agent.machine
    })

    const hi = await client.call('hello')
    assert.equal(hi.ok, true)
    assert.equal(hi.owner, s.agent.owner, 'el node se presenta con el ownerId de su maestra')
    assert.equal(hi.version, 'test')

    const { cid } = await s.node.put(Readable.from([Buffer.from('un blob')]))
    const list = await client.call('list')
    assert.deepEqual(list.blobs.map((b) => b.cid), [cid])

    const pub = await client.call('acl', { cid, acl: 'public' })
    assert.equal(pub.ok, true)
    assert.equal(s.node.stat(cid).acl, 'public')

    const del = await client.call('remove', { cid })
    assert.equal(del.removed, cid)
    assert.equal(s.node.stat(cid), null)
  } finally { await s.cleanup() }
})

test('un aparato de OTRA maestra no abre sesión: el node no le contesta nada', async () => {
  const s = await setup()
  try {
    const otherMaster = await makeMaster()
    const intruder = await makeDeviceKey({ label: 'ajeno' })
    await assert.rejects(
      connectClient(s.bus, {
        device: intruder,
        cert: await otherMaster.certFor(intruder.publickey),
        agentPubkey: s.agent.machine,
        token: 'intruder-token'
      }),
      /no autorizado|untrusted/i
    )
  } finally { await s.cleanup() }
})

/**
 * El papel ya no vence por reloj: vale mientras el acta lo diga. Lo que sí lo mata es que
 * el aparato deje de estar en el acta — y esa es la prueba que sustituye a la del
 * vencimiento, porque es la que de verdad protege: quitar un aparato surte efecto en el
 * acto, sin esperar a que caduque nada.
 */
test('a un aparato que el acta ya no nombra no se le abre sesión', async () => {
  const s = await setup()
  try {
    // Se le emite el papel pero NO entra en el acta. El papel está bien firmado y no vence;
    // lo único que le falta es que el acta lo nombre, y eso basta para que no pase.
    const fuera = await makeDeviceKey({ label: 'sin sitio en el acta' })
    const cert = await s.master.certFor(fuera.publickey, [SIGN_SCOPE], { admitir: false })
    await assert.rejects(
      connectClient(s.bus, {
        device: fuera, cert, agentPubkey: s.agent.machine, token: 'stale-token'
      }),
      /no autorizado/i
    )
  } finally { await s.cleanup() }
})

test('sin enlace, el plano de control no arranca y lo dice', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'content-nolink-'))
  const node = await new ContentNode({ dir: path.join(root, 'data') }).init()
  try {
    await assert.rejects(
      startContentAgent({ node, dir: path.join(root, 'vacio'), quiet: true }),
      /is not linked to a vault/
    )
  } finally {
    node.close()
    await rm(root, { recursive: true, force: true })
  }
})
