/**
 * announce.js — ANUNCIO del node (DISENO.md §3.1). Es lo que hace que se sepa
 * **dónde** está el contenido de un dueño.
 *
 * La referencia compartible nombra al DUEÑO, no a la máquina (`ownerId + cid`), así
 * que resolverla es contestar «¿qué nodes de este dueño están vivos ahora mismo?».
 * Hay dos caminos, según quién pregunte, y este archivo es el segundo:
 *
 *  - **El dueño** pregunta a su bóveda (`listAgentsByLabel(id, 'content')`): sus
 *    aparatos y sus direcciones. No necesita ningún anuncio.
 *  - **Un tercero con el enlace** no puede consultar la bóveda de nadie — ni debe.
 *    Para él, el node se publica en un **canal del proxy** y cualquiera lista quién
 *    está dentro. Eso es esto.
 *
 * **El nombre del canal lleva el `ownerId`, no el `cid`.** Un canal por contenido
 * filtraría qué guarda cada quien con solo mirar la lista de canales; y además
 * serían miles. Con uno por dueño, lo que se sabe al listar es «este dueño tiene
 * nodes en línea», que es justo lo que hace falta para pedirle algo.
 *
 * **Por qué el canal va con id de proxio delante.** Hay dos proxios federados y un
 * canal SIN prefijo es local a cada uno: el node anunciado en uno sería invisible
 * para quien esté conectado al otro. Se publica en el canal de **cada nodo
 * conocido** y se lista en todos, en vez de elegir uno "dueño" por una fórmula: la
 * lista de nodos de la malla cambia cuando entra o sale un proxio, y una fórmula
 * que dependa de ella reasigna todos los canales el día que eso pase. Son dos
 * canales hoy; publicar en los dos cuesta dos mensajes y no se rompe nunca.
 *
 * **Anunciarse NO da acceso a nada.** Es una guía de teléfonos: dice a quién
 * llamar. Quién puede pedir qué lo siguen decidiendo la ACL y el certificado, en
 * el sitio de siempre.
 */

import { channelFor } from '../lib/public.js'

/** Nombre del canal de un dueño dentro de un proxio concreto (vive en la lib: el cliente del tercero lo necesita igual). */
export { channelFor }

/** Cada cuánto se re-publica (el proxio caduca las entradas de canal). */
export const REPUBLISH_MS = 4 * 60 * 1000

/**
 * Publica este node en el canal de su dueño, en todos los proxios conocidos, y lo
 * mantiene publicado. Best-effort a propósito: si el proxy está caído, el node
 * sigue funcionando —sirve en local y atiende a los aparatos del acta— y el
 * siguiente tic lo vuelve a intentar. Un anuncio perdido no rompe nada; lo único
 * que pasa es que un tercero no lo encuentra hasta que vuelva.
 *
 * @param {{ client: any, owner: string, quiet?: boolean, intervalMs?: number }} opts
 *   client: el `WebSocketProxyClient` YA conectado del agente (`ra.client`) — no se
 *   abre otro: dos conexiones del mismo aparato son dos identidades de transporte.
 * @returns {{ channels: () => string[], close: () => void }}
 */
export function startAnnounce ({ client, owner, quiet = false, intervalMs = REPUBLISH_MS }) {
  if (!client) throw new Error('startAnnounce: falta client')
  if (!owner) throw new Error('startAnnounce: falta owner')

  let stopped = false
  let current = []

  /** Los proxios donde hay que anunciarse: el que nos atiende y los que conoce. */
  const targets = () => {
    const known = Array.isArray(client.knownNodes) ? client.knownNodes : []
    return known.length ? known : (client.node ? [client.node] : [])
  }

  async function publishAll () {
    if (stopped) return
    const names = targets().map((n) => channelFor(n, owner))
    if (!names.length) return          // aún sin `connected`: el próximo tic
    const done = []
    for (const name of names) {
      try {
        await client.publish(name, { app: 'content', owner })
        done.push(name)
      } catch (e) {
        if (!quiet) console.error(`[content] no me pude anunciar en ${name}: ${e.message}`)
      }
    }
    const first = !current.length && done.length
    current = done
    if (first && !quiet) console.log(`[content] anunciado como node de ${owner.slice(0, 16)} en ${done.length} proxio(s) · token ${client.token}`)
  }

  publishAll()
  // Re-publicar al reconectar: el token cambia y el anuncio viejo apunta a una
  // conexión que ya no existe. Sin esto, un corte de red deja al node listado y
  // mudo, que es peor que no estar listado.
  const offToken = client.on('token', () => { current = []; publishAll() })
  const timer = setInterval(publishAll, intervalMs)
  timer.unref?.()

  return {
    channels: () => [...current],
    close () {
      stopped = true
      clearInterval(timer)
      try { offToken?.() } catch (_) {}
      for (const name of current) { try { client.unpublish(name) } catch (_) {} }
      current = []
    }
  }
}

/**
 * Lado del que BUSCA: los tokens de los nodes de un dueño que están en línea, en
 * todos los proxios conocidos, sin repetidos.
 *
 * Lo que devuelve son **candidatos, no autoridades**: cualquiera puede publicarse
 * en el canal de cualquier dueño (el nombre del canal no es un secreto). Quien
 * pregunte tiene que comprobar las dos cosas de siempre — que el node presenta un
 * certificado que encadena a ese `ownerId`, y que los bytes que entrega hashean al
 * `cid` pedido. Con esas dos, un impostor en la lista no consigue nada más que
 * gastar un intento.
 *
 * @param {{ client: any, owner: string }} opts
 * @returns {Promise<string[]>} tokens (direcciones en el proxy)
 */
export async function findNodes ({ client, owner }) {
  if (!client || !owner) throw new Error('findNodes: faltan client u owner')
  const known = Array.isArray(client.knownNodes) && client.knownNodes.length
    ? client.knownNodes
    : (client.node ? [client.node] : [])
  const out = new Set()
  for (const nodeId of known) {
    try {
      for (const token of await client.list(channelFor(nodeId, owner))) out.add(token)
    } catch (_) { /* un proxio que no contesta no invalida al otro */ }
  }
  // El propio que pregunta puede estar en la lista (una PWA que también es node).
  if (client.token) out.delete(client.token)
  return [...out]
}

export default { startAnnounce, findNodes, channelFor, REPUBLISH_MS }
