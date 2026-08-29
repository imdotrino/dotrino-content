/**
 * La CONFIGURACIÓN del node, servida por el vault (DISENO.md §15.14).
 *
 * Este node es un servicio del ecosistema como cualquier otro: no lleva su
 * configuración en un `.env`, se la cede la bóveda del dueño **sellada para su llave**
 * (`ns:content`). De ahí salen `CONTENT_STORAGE` y, si vale `s3`, el endpoint, los
 * buckets y las credenciales.
 *
 * **No se reimplementa nada de eso**: lo resuelve `@dotrino/vault/service`, que es lo
 * que usan los proxios. Aquí solo está el pegamento y una decisión propia — qué hacer
 * cuando llega un cambio (abajo).
 *
 * Ojo con el enrolamiento, que tiene dos partes y hacen falta las dos:
 *
 *  · **La llave de FIRMA** (`device`) — dice quién es este aparato.
 *  · **La llave de CIFRADO** (`enc`) — es a la que el vault le SELLA cada variable.
 *    Sin ella el aparato aparece en el acta pero se queda sin configuración, y no da
 *    error: simplemente no le llega nada. Por eso se enrola por este camino y no por
 *    el de `@dotrino/remote-agent`, que todavía no la crea.
 */
import fs from 'node:fs'
import path from 'node:path'
import { linkDir } from './agent.js'

/** El namespace de secretos de esta pieza. Es el mismo que el `pair --service`. */
export const NS = 'content'

/** Dónde vive la identidad de servicio (llave + cert). Junto al enlace del aparato. */
export const serviceDir = () =>
  process.env.DOTRINO_CONTENT_VAULT_DIR || path.join(linkDir(), 'vault-service')

/** ¿Está este node enrolado a un vault? */
export const isEnrolled = (dir = serviceDir()) =>
  fs.existsSync(path.join(dir, 'service-identity.json'))

/**
 * Enrola este node contra el vault del dueño con la invitación de
 * `dotrino-vault pair --service content`.
 *
 * Deja además el enlace que espera el plano de control (`@dotrino/remote-agent`), con
 * LA MISMA llave: un aparato, una identidad. Si se enrolara dos veces —una por cada
 * plano— el acta tendría dos filas para la misma máquina y revocar una dejaría viva a
 * la otra, que es exactamente lo que el modelo de revocación quiere evitar.
 *
 * @param {string} qr la invitación (URL, código pegado o JSON)
 * @param {{ dir?: string, onCode?: (c:{deviceId:string,code:string})=>void,
 *           onReplace?: (p:any)=>void, label?: string }} [opts]
 */
export async function enrollToVault (qr, { dir = serviceDir(), onCode, onReplace, label } = {}) {
  const { enrollService } = await import('@dotrino/vault/service')
  const res = await enrollService({ qr, ns: NS, dir, label: label || 'content', onCode, onReplace })

  // El plano de control usa la misma identidad. `saveLink` es de remote-agent, y su
  // formato es el que lee `startRemoteAgent` al arrancar.
  const { saveLink } = await import('@dotrino/remote-agent/link')
  saveLink(linkDir(), {
    device: res.device,
    cert: res.cert,
    iss: res.iss,
    proxy: res.cert?.proxy || 'wss://proxy.dotrino.com',
    label: label || 'content',
    at: Date.now()
  })
  return res
}

/**
 * Espera la configuración del vault y la vuelca en `process.env`.
 *
 * **Qué hace cuando cambia una variable: reiniciar.** Es lo mismo que decidió el
 * proxio, y por la misma razón: una variable se rota casi siempre PORQUE SE FILTRÓ, y
 * mientras el proceso siga vivo el valor viejo sigue en su memoria y sigue siendo el
 * que usa. Aquí además es literal — el backend del almacén se construye al arrancar
 * con las credenciales de entonces.
 *
 * Si el node no está enrolado no hace nada y se calla: sin vault corre en local, que
 * es el modo normal de quien se lo autohospeda (§15.12).
 *
 * @param {{ dir?: string, onSecrets?: (s:any)=>void, log?: (m:string)=>void,
 *           onChange?: () => void, firstWaitMs?: number }} [opts]
 */
export function startVaultConfig ({ dir = serviceDir(), onSecrets, log = console.log, onChange, firstWaitMs = 20000 } = {}) {
  if (!isEnrolled(dir)) return { enabled: false, ready: Promise.resolve(null), close () {} }
  let stopped = false
  let watcher = null
  /** @type {(v:any)=>void} */
  let arrive = () => {}
  const ready = new Promise((resolve) => { arrive = resolve })

  // La configuración decide QUÉ ALMACÉN usa este node, así que quien arranca la espera…
  // pero con plazo. Si la bóveda está apagada, seguir esperando sería dejar al usuario
  // sin su propio contenido local por una pieza que el ecosistema promete no exigir
  // (`CLAUDE.md`: ninguna app puede requerir un daemon encendido). Al vencer el plazo se
  // sigue en local, y cuando la configuración llegue, `watchEnv` reinicia con ella.
  let expired = false
  const deadline = setTimeout(() => {
    expired = true
    log(`[vault] no answer in ${Math.round(firstWaitMs / 1000)}s: starting with the local config and restarticio cuando llegue`)
    arrive(null)
  }, firstWaitMs)
  deadline.unref?.()

  ;(async () => {
    const { waitForSecrets } = await import('@dotrino/vault/service')
    const { applyEnv, watchEnv } = await import('@dotrino/vault/env')
    const secrets = await waitForSecrets({
      dir,
      ns: NS,
      onRetry: (e, delay) => log(`[vault] no config yet (${e.message}); retrying in ${Math.round(delay / 1000)}s`)
    })
    if (stopped) return

    const { injected, overridden } = applyEnv(secrets)
    log(`[vault] applied ${injected.length} value(s) from the vault to the environment`)
    if (overridden.length) log(`[vault] these overrode the machine environment: ${overridden.join(', ')}`)
    clearTimeout(deadline)
    arrive(secrets)
    onSecrets?.(secrets)

    // LLEGÓ TARDE: el node ya arrancó, y arrancó con lo que había — o sea, con el
    // almacén equivocado si la configuración dice otro. `watchEnv` no sirve aquí
    // porque solo reacciona a CAMBIOS, y esto es la primera llegada: sin esto, un node
    // que arrancó antes que su bóveda se queda en local para siempre, con la
    // configuración correcta puesta en el entorno y sin usarla. Se sale, y el
    // supervisor lo levanta ya con todo.
    if (expired) {
      log('[vault] config arrived after startup: restarting to pick it up')
      setTimeout(() => process.exit(0), 300)
      return
    }

    // Sin `onUpdate`, `watchEnv` sale del proceso él mismo (con el código que
    // corresponda: 0 si cambió la configuración, 1 si revocaron a este agente, para
    // que un supervisor que lo relance no gire en silencio). Es lo que queremos, así
    // que solo se le pasa `onUpdate` si la app quiere hacer otra cosa.
    watcher = await watchEnv({
      dir,
      ns: NS,
      ...(onChange
        ? {
            onUpdate: ({ reason }) => {
              log(`[vault] ${reason === 'revoked' ? 'this device was revoked' : 'new config arrived'}`)
              onChange()
            }
          }
        : {})
    })
  })().catch((e) => { log(`[vault] could not read the config: ${e.message}`); clearTimeout(deadline); arrive(null) })

  return {
    enabled: true,
    /** Resuelve con la configuración, o con `null` si venció el plazo o falló. */
    ready,
    close () { stopped = true; clearTimeout(deadline); try { watcher?.close?.() } catch (_) {} }
  }
}

export default { NS, serviceDir, isEnrolled, enrollToVault, startVaultConfig }
