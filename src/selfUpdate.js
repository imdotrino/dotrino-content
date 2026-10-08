/**
 * selfUpdate.js — este node SE ACTUALIZA SOLO (CONVENCIONES §15, dueño 2026-10-08).
 *
 * No implementa nada de eso: mirar, comprobar lo que entrega npm contra la release de
 * GitHub, instalar y recordar lo ya preguntado es de `@dotrino/update/npm`; preguntarle a
 * la bóveda y avisarle es de `@dotrino/vault/service` (`vaultUpdateHooks`). Aquí solo se
 * juntan las dos piezas con la carpeta y la identidad de esta instancia.
 *
 * Los dos ajustes son de ESTA instancia (`update-prefs.json` en su carpeta) y no tienen
 * que ver con el de la bóveda:
 *   · `approval` (apagado): encendido, antes de instalar se le pregunta a la bóveda.
 *   · `notify` (encendido): se avisa a quien aprueba de que el node se actualizó, o de
 *     que hay versión nueva y esta instalación necesita root.
 *
 * SIN BÓVEDA NO HAY A QUIÉN PREGUNTAR NI A QUIÉN AVISAR, y se dice tal cual: no se pasan
 * los ganchos, así que con `approval` encendida y sin enrolar el resultado es
 * `no-approver` y no se instala. Suponer un sí sería saltarse lo que el dueño pidió.
 */
import { watchSelfUpdateNpm } from '@dotrino/update/npm'
import { vaultUpdateHooks } from '@dotrino/vault/service'

export const PKG = '@dotrino/content'
export const REPO = 'imdotrino/dotrino-content'

/**
 * Arranca el vigilante. Devuelve cómo pararlo.
 *
 * @param {{
 *   version: string, dir: string, conn?: (() => object) | null,
 *   restart: (version: string) => void, log?: (m: string) => void,
 *   watch?: typeof watchSelfUpdateNpm, hooks?: typeof vaultUpdateHooks
 * }} o
 *   dir: la carpeta del enlace de esta instancia (ahí viven sus ajustes de actualización).
 *   conn: con qué identidad se le habla a la bóveda (`{ dir }` o `{ proxyUrl, masterPubkey,
 *     device, cert }`), o `null` si este node no está enrolado. Es una FUNCIÓN y se llama en
 *     cada uso: el papel se renueva con el proceso en marcha, y uno leído al arrancar ya no
 *     valdría un día después.
 *   restart: salir limpio para que systemd/pm2 levante la versión nueva.
 */
export function startSelfUpdate ({ version, dir, conn = null, restart, log = console.log, watch = watchSelfUpdateNpm, hooks = vaultUpdateHooks }) {
  // Los ganchos son de la librería de la bóveda; aquí solo se arman con la identidad de AHORA.
  const now = () => hooks({ product: PKG, log, ...conn() })
  return watch({
    pkg: PKG,
    current: version,
    repo: REPO,
    dir,
    ...(conn
      ? {
          mayUpdate: (u) => now().mayUpdate(u),
          onUpdated: (u) => now().onUpdated(u),
          onNeedsRoot: (u) => now().onNeedsRoot(u)
        }
      : {}),
    onInstalled: ({ version: to, restart: canRestart }) => {
      if (canRestart) {
        log(`[update] ${PKG} ${to} installed · restarting to run it`)
        restart(to)
      } else {
        log(`[update] ${PKG} ${to} installed · nothing restarts this process, so it keeps running ${version} until the next start`)
      }
    },
    log
  })
}

export default { PKG, REPO, startSelfUpdate }
