/**
 * agent.js — Fase 2 (DISENO.md §5, §11): este node deja de ser una pieza local y
 * pasa a ser un APARATO DEL VAULT, administrable a distancia desde tus propias apps
 * sin abrir un solo puerto.
 *
 * NO IMPLEMENTA NADA DE ESO: lo hace `@dotrino/remote-agent`, el middleware que ya
 * usan `dotrino-terminal` y `dotrino-ia`. De ahí salen, y por eso no se reescriben
 * aquí: el enrolamiento contra el vault (llave `D` propia + cert `D ← maestra`, la
 * maestra nunca vive aquí), el `identify` firmado en el proxy, el canal cifrado por
 * sesión, el refresco de la lista de revocados, la RENOVACIÓN del cert antes de que
 * venza y el auto-borrado cuando llega un `vault.revoked` firmado por la maestra.
 *
 * Lo único de este archivo es el pegamento: cada payload que llega por una sesión
 * ya autorizada se despacha en `ops.js`, y la respuesta vuelve por el mismo canal
 * cifrado. Autorizar = tener un cert de LA MISMA maestra que este node (eso lo
 * comprueba `verifyChain` dentro del middleware); no hay lista de invitados propia.
 *
 * El `owner` del node se deriva de la maestra a la que está enlazado: es el
 * `ownerId` de la referencia compartible `ownerId + cid` (§3), y se estampa en todo
 * lo que se suba mientras el node esté enlazado.
 */
import { pubkeyId } from '@dotrino/identity/capabilities'
import { startRemoteAgent } from '@dotrino/remote-agent/agent'
import { dataDir, loadLink } from '@dotrino/remote-agent/link'
import { createOps } from './ops.js'

/** Carpeta de datos del enlace (NO es la de los blobs: el enlace es del aparato). */
export const linkDir = () => process.env.DOTRINO_CONTENT_LINK_DIR || dataDir('dotrino-content')

/** ¿Está este node enlazado a un vault? (sin enlace, Fase 1: solo loopback) */
export const isLinked = (dir = linkDir()) => {
  const link = loadLink(dir)
  return !!(link?.device?.privateJwk && link?.cert && link?.iss)
}

/**
 * Arranca el plano de control del node.
 *
 * @param {{
 *   node?: import('./node.js').ContentNode,
 *   dir?: string, proxyUrl?: string, version?: string|null,
 *   client?: any, quiet?: boolean, onRevoked?: () => void
 * }} opts
 *   client: transporte inyectado — SOLO para pruebas (bus en memoria). En
 *   producción lo levanta el middleware con el proxy del ecosistema.
 * @returns {Promise<{ machine: string, machineId: string, owner: string, close: () => void }>}
 */
export async function startContentAgent ({
  node, dir = linkDir(), proxyUrl, version = null, client, quiet = false, onRevoked
} = {}) {
  if (!node) throw new Error('startContentAgent: falta node')
  const link = loadLink(dir)
  if (!link?.iss) {
    throw new Error('este node no está enlazado a un vault. Ejecuta primero: dotrino-content enroll <código>')
  }

  // El node representa a la maestra que lo certificó: su huella es el `ownerId`.
  // Se resuelve ANTES de abrir el transporte, para que la primera sesión que entre
  // ya encuentre el despachador armado.
  const owner = await pubkeyId(link.iss)
  node.owner = owner
  const dispatch = createOps(node, { owner, version })

  const agent = await startRemoteAgent({
    dir,
    proxyUrl,
    client,
    quiet,
    onRevoked,
    onSession: (session) => {
      session.on('message', (msg) => {
        dispatch(msg)
          .then((reply) => session.send(reply))
          .catch((e) => session.send({ rid: msg?.rid, ok: false, code: 'failed', error: e.message }))
      })
    }
  })

  if (!quiet) console.log(`[content] control plane ready · owner ${owner.slice(0, 16)}`)

  return { ...agent, owner }
}

export default { startContentAgent, isLinked, linkDir }
