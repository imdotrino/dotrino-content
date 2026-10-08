/**
 * selfUpdate.js — este node SE ACTUALIZA SOLO (CONVENCIONES §15, dueño 2026-10-08).
 *
 * No implementa nada de eso: mirar, comprobar lo que entrega npm contra la release de
 * GitHub, instalar y recordar lo ya preguntado es de `@dotrino/update/npm`; preguntarle a
 * la bóveda y avisarle es de `@dotrino/vault/service`. Aquí solo está el pegamento, y es
 * lo único que conoce las dos piezas a la vez.
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
import { askUpdateApproval, reportUpdated, reportUpdateNeedsRoot } from '@dotrino/vault/service'

export const PKG = '@dotrino/content'
export const REPO = 'imdotrino/dotrino-content'

/**
 * Los tres ganchos que hablan con la bóveda. `conn()` da, EN EL MOMENTO de llamar, con
 * qué identidad se le habla (`{ dir }` o `{ proxyUrl, masterPubkey, device, cert }`): el
 * papel se renueva con el proceso en marcha y uno leído al arrancar ya no valdría.
 *
 * @param {{ product: string, conn: () => object, vault?: any }} o
 */
export function vaultUpdateHooks ({ product, conn, vault = { askUpdateApproval, reportUpdated, reportUpdateNeedsRoot } }) {
  return {
    // true = sí · false = no, o pasó el día sin respuesta · lanza = no se pudo preguntar
    // (eso no es una negativa: `@dotrino/update` lo reintenta en la próxima pasada).
    mayUpdate: async ({ version, from }) => {
      try {
        return (await vault.askUpdateApproval({ product, version, from, ...conn() })).ok === true
      } catch (e) {
        // El pedido quedó pendiente y venció sin que nadie contestara: vencido es no.
        if (e?.code === 'unanswered') return false
        throw e
      }
    },
    onUpdated: ({ version, from }) => vault.reportUpdated({ product, version, from, ...conn() }),
    onNeedsRoot: ({ version, from }) => vault.reportUpdateNeedsRoot({ product, version, from, ...conn() })
  }
}

/**
 * Arranca el vigilante. Devuelve cómo pararlo.
 *
 * @param {{
 *   version: string, dir: string, conn?: (() => object) | null,
 *   restart: (version: string) => void, log?: (m: string) => void,
 *   watch?: typeof watchSelfUpdateNpm, vault?: any
 * }} o
 *   dir: la carpeta del enlace de esta instancia (ahí viven sus ajustes de actualización).
 *   conn: cómo hablarle a la bóveda, o `null` si este node no está enrolado.
 *   restart: salir limpio para que systemd/pm2 levante la versión nueva.
 */
export function startSelfUpdate ({ version, dir, conn = null, restart, log = console.log, watch = watchSelfUpdateNpm, vault }) {
  return watch({
    pkg: PKG,
    current: version,
    repo: REPO,
    dir,
    ...(conn ? vaultUpdateHooks({ product: PKG, conn, ...(vault ? { vault } : {}) }) : {}),
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

export default { PKG, REPO, vaultUpdateHooks, startSelfUpdate }
