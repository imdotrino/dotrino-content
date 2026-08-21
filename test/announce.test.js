/**
 * Pruebas del ANUNCIO (DISENO.md §3.1): cómo se pasa de «tengo una referencia de
 * este dueño» a «estos nodes suyos están vivos ahora».
 *
 * El transporte es de mentira (un proxy en memoria con canales, y con DOS proxios
 * federados, que es donde está la trampa); lo que se prueba es la política: en qué
 * canales se publica, qué pasa al reconectar, y que quien busca vea a los nodes del
 * dueño esté conectado al proxio que esté.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { startAnnounce, findNodes, channelFor } from '../src/announce.js'

/**
 * Proxy en memoria con canales y DOS nodos federados. Los canales llevan el id del
 * proxio delante y su membresía es global —igual que en la malla de verdad, donde
 * el nodo dueño del canal guarda la lista y los demás le pasan la operación.
 */
function makeProxy () {
  const channels = new Map()   // nombre → Set(token)
  const nodes = ['NODEUNO12345', 'NODEDOS12345']
  let n = 0
  const members = (name) => channels.get(name) || channels.set(name, new Set()).get(name)

  return {
    nodes,
    channels,
    /** @param {string} [nodeId] a qué proxio se conecta este cliente */
    client (nodeId = nodes[0]) {
      const handlers = { token: [] }
      return {
        token: `T${++n}`,
        node: nodeId,
        knownNodes: nodes,
        on (ev, cb) { handlers[ev]?.push(cb); return () => { handlers[ev] = handlers[ev].filter((h) => h !== cb) } },
        async publish (name) { members(name).add(this.token) },
        async unpublish (name) { members(name).delete(this.token) },
        async list (name) { return [...members(name)] },
        /** Simula una reconexión: token nuevo y aviso, como hace el de verdad. */
        reconnect () {
          const old = this.token
          this.token = `T${++n}`
          for (const set of channels.values()) set.delete(old)
          for (const cb of handlers.token) cb(this.token)
        }
      }
    }
  }
}

const OWNER = 'sha256-ownerdeprueba'
const tick = () => new Promise((r) => setImmediate(r))

test('el node se publica en el canal de su DUEÑO, en todos los proxios de la malla', async () => {
  const proxy = makeProxy()
  const client = proxy.client()
  const beacon = startAnnounce({ client, owner: OWNER, quiet: true })
  await tick()

  assert.deepEqual(beacon.channels(), proxy.nodes.map((n) => channelFor(n, OWNER)))
  // El nombre lleva el ownerId, NO el cid: listar canales no debe contar qué
  // guarda cada quien, solo quién tiene nodes en línea.
  for (const name of beacon.channels()) assert.match(name, /\/content_sha256-ownerdeprueba$/)
  beacon.close()
})

test('quien busca lo encuentra aunque esté conectado al OTRO proxio', async () => {
  const proxy = makeProxy()
  const node = proxy.client(proxy.nodes[0])          // el node vive en el proxio 1
  const visitor = proxy.client(proxy.nodes[1])       // el visitante entró por el 2
  const beacon = startAnnounce({ client: node, owner: OWNER, quiet: true })
  await tick()

  assert.deepEqual(await findNodes({ client: visitor, owner: OWNER }), [node.token])
  beacon.close()
})

test('sin anuncio no hay a quién preguntar (y eso es una lista vacía, no un error)', async () => {
  const proxy = makeProxy()
  assert.deepEqual(await findNodes({ client: proxy.client(), owner: 'sha256-otro' }), [])
})

test('al reconectar se re-publica: el token viejo ya no existe', async () => {
  const proxy = makeProxy()
  const node = proxy.client()
  const visitor = proxy.client(proxy.nodes[1])
  const beacon = startAnnounce({ client: node, owner: OWNER, quiet: true })
  await tick()
  const before = node.token

  node.reconnect()
  await tick()

  const found = await findNodes({ client: visitor, owner: OWNER })
  assert.deepEqual(found, [node.token])
  assert.ok(!found.includes(before), 'un anuncio que apunta a una conexión muerta es peor que no estar')
  beacon.close()
})

test('cerrar el node lo retira de los canales', async () => {
  const proxy = makeProxy()
  const node = proxy.client()
  const visitor = proxy.client(proxy.nodes[1])
  const beacon = startAnnounce({ client: node, owner: OWNER, quiet: true })
  await tick()
  beacon.close()
  await tick()
  assert.deepEqual(await findNodes({ client: visitor, owner: OWNER }), [])
})

test('quien busca no se encuentra a sí mismo (una PWA puede ser node y visitante)', async () => {
  const proxy = makeProxy()
  const self = proxy.client()
  const beacon = startAnnounce({ client: self, owner: OWNER, quiet: true })
  await tick()
  assert.deepEqual(await findNodes({ client: self, owner: OWNER }), [])
  beacon.close()
})

test('un proxio que no contesta no invalida al otro', async () => {
  const proxy = makeProxy()
  const node = proxy.client()
  const beacon = startAnnounce({ client: node, owner: OWNER, quiet: true })
  await tick()

  const visitor = proxy.client(proxy.nodes[1])
  const realList = visitor.list.bind(visitor)
  visitor.list = async (name) => {
    if (name.startsWith(proxy.nodes[0])) throw new Error('ese proxio está caído')
    return realList(name)
  }
  assert.deepEqual(await findNodes({ client: visitor, owner: OWNER }), [node.token])
  beacon.close()
})

test('un proxy sin canales no tumba el node: el anuncio es best-effort', async () => {
  const roto = { token: 'T0', node: 'NODEUNO12345', knownNodes: ['NODEUNO12345'], on: () => () => {},
    publish: async () => { throw new Error('sin canales') } }
  const beacon = startAnnounce({ client: roto, owner: OWNER, quiet: true })
  await tick()
  assert.deepEqual(beacon.channels(), [], 'no se anunció, pero el node sigue vivo')
  beacon.close()
})
