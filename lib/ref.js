/**
 * ref.js — la REFERENCIA compartible (DISENO.md §3 y §7). Isomórfico y sin
 * dependencias: lo usan las apps, el node y las pruebas.
 *
 * Una referencia es `ownerId + cid` y, si el contenido va cifrado, la LLAVE:
 *
 *     https://eco.dotrino.com/#<ownerId>/<cid>/<llave>
 *                             └──────── el #fragment ────────┘
 *
 * Las dos mitades hacen falta y ninguna sobra:
 *  - el **`cid`** es el hash del contenido: lo vuelve inmutable, deduplicable y
 *    **verificable** (quien lo recibe comprueba que los bytes son los pedidos);
 *  - el **`ownerId`** es la huella de la maestra del dueño, y es lo que permite
 *    **rutear** (`ownerId` → sus nodes) y comprobar que quien sirvió los bytes es
 *    un aparato suyo. Un `cid` suelto es ambiguo: cualquiera podría reclamarlo.
 *
 * **La llave va en el fragmento y por eso NUNCA llega a un servidor**: el
 * navegador no manda el `#` en la petición. Es lo mismo que hace el resto del
 * ecosistema, y es lo que permite compartir un enlace de contenido cifrado sin
 * que quien lo hospeda pueda leerlo.
 */

const CID_RE = /^sha256-[0-9a-f]{64}$/

/** ¿Tiene forma de cid? (no dice si existe, solo si es un cid) */
export const isValidCid = (cid) => typeof cid === 'string' && CID_RE.test(cid)

/**
 * Arma la parte de fragmento de una referencia (sin el `#`).
 * @param {{ owner: string, cid: string, key?: string|null }} ref
 * @returns {string} `<owner>/<cid>` o `<owner>/<cid>/<llave>`
 */
export function buildRef ({ owner, cid, key = null }) {
  if (!owner) throw new Error('buildRef: owner is required')
  if (!isValidCid(cid)) throw new Error(`buildRef: invalid cid: ${cid}`)
  return key ? `${owner}/${cid}/${key}` : `${owner}/${cid}`
}

/**
 * Arma el enlace completo hacia una app del ecosistema.
 * @param {{ owner: string, cid: string, key?: string|null }} ref
 * @param {string} [appUrl]
 */
export function buildUrl (ref, appUrl = 'https://eco.dotrino.com/') {
  return `${appUrl.replace(/\/+$/, '')}/#${buildRef(ref)}`
}

/**
 * Lee una referencia de un fragmento, una URL o la barra de direcciones.
 * Devuelve `null` si eso no es una referencia — que es lo normal: las apps del
 * ecosistema usan el fragmento para muchas cosas (`#room=`, `#vault`…), así que
 * esto tiene que poder decir "no es mío" sin ruido.
 * @param {string} input
 * @returns {{ owner: string, cid: string, key: string|null }|null}
 */
export function parseRef (input) {
  if (typeof input !== 'string' || !input) return null
  let frag = input
  const hash = frag.indexOf('#')
  if (hash >= 0) frag = frag.slice(hash + 1)
  frag = frag.replace(/^\/+/, '')
  const parts = frag.split('/')
  if (parts.length < 2 || parts.length > 3) return null
  const [owner, cid, key = null] = parts
  if (!owner || !isValidCid(cid)) return null
  return { owner, cid, key: key || null }
}

export default { buildRef, buildUrl, parseRef, isValidCid }
