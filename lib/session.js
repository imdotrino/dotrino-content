/**
 * El node del usuario para una SESIÓN de la app: se intenta conectar una vez, y si no hay
 * (lo normal: la mayoría no tiene uno) se sigue sin node, sin castigar cada operación con
 * una espera. `retry()` vuelve a intentarlo cuando el usuario acaba de encender uno.
 * Antes cada app (eco, ar) llevaba su copia de esto.
 */
import { ContentClient } from './index.js'

/**
 * @param {() => Promise<any>} getIdentity  devuelve la instancia de `Identity` de la app
 * @param {{ onError?: (e: Error) => void }} [opts]  para los fallos que NO son «no hay node»
 */
export function nodeSession (getIdentity, { onError } = {}) {
  let client = null
  let tried = false
  let lastError = null

  async function node () {
    if (client || tried) return client
    tried = true
    try {
      client = await ContentClient.connectWithIdentity(await getIdentity())
      lastError = null
    } catch (e) {
      lastError = e?.code === 'no-node' || e?.code === 'no-vault' ? e.code : (e?.message || 'could not connect')
      if (e?.code !== 'no-node' && e?.code !== 'no-vault') onError?.(e)
    }
    return client
  }

  return {
    /** El node, o `null` si esta sesión no tiene. */
    node,
    async retry () { tried = false; client = null; return node() },
    /** Sin efectos: para pintar un interruptor sin provocar una conexión. */
    hasNode: () => !!client,
    lastError: () => lastError,
  }
}
