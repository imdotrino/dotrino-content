/**
 * @dotrino/content-client — lo que usa una APP del ecosistema para guardar y leer
 * contenido en el node de su propio usuario (DISENO.md §10).
 *
 * Qué resuelve, y por qué no lo resuelve cada app por su cuenta:
 *
 *  1. **Encontrar los nodes del usuario.** La referencia nombra al dueño, no a la
 *     máquina, así que hay que pasar de `ownerId` a «qué aparatos suyos con rol de
 *     content están vivos». Para el propio dueño eso lo contesta su bóveda
 *     (`listAgentsByLabel(id, 'content')`), y no hace falta anuncio ninguno.
 *  2. **Hablar con ellos.** Sesión cifrada punto a punto por
 *     `@dotrino/remote-agent`, el mismo middleware de la terminal. Ninguna app
 *     escribe protocolo.
 *  3. **Cifrar.** Por defecto (§4): el node guarda ciphertext y la llave se va en
 *     el `#fragment` del enlace.
 *
 * ## Lo que este cliente NO hace, y conviene saberlo antes de diseñar con él
 *
 * - **No lee el contenido de OTRO usuario.** Hoy solo se puede abrir sesión con un
 *   aparato de tu misma acta, así que un tercero con tu enlace **todavía** no
 *   puede pedir los bytes: eso llega con el transporte P2P. Lo que un tercero sí
 *   ve hoy es la **vista previa** que sirve el node por HTTP (§7.2), si su dueño
 *   la encendió.
 * - **No sustituye al `@dotrino/store`, y no debe.** Regla del dueño: al store va
 *   **lo que tiene que estar SIEMPRE disponible**, porque vive en el aparato y
 *   responde offline. Aquí van **los bytes**, que necesitan un node encendido. Una
 *   app tiene que seguir funcionando **con el store solo**: si deja de andar
 *   porque el node de su dueño está apagado, está mal diseñada. Por eso `put`
 *   falla con `code: 'no-node'` en vez de quedarse esperando — para que la app
 *   pueda seguir su camino en lugar de bloquearse.
 * - **No sube lo que no es un mensaje.** El tope del plano de control son 256 KB
 *   (§7.1). Lo más grande espera al P2P.
 */
import { RemoteAgentClient } from '@dotrino/remote-agent/client'
import { listAgentsByLabel } from '@dotrino/remote-agent/discover'
import { encryptBlob, decryptBlob } from './crypto.js'
import { buildRef, buildUrl, parseRef, isValidCid } from './ref.js'

export { buildRef, buildUrl, parseRef, isValidCid }
export { encryptBlob, decryptBlob, makeKey, exportKey, importKey } from './crypto.js'
export { fetchPublic, fetchFrom, findNodes, channelFor, MSG as PUBLIC_MSG, FETCH_MAX_BYTES } from './public.js'

/** Label con el que se enrola un content node (`dotrino-content enroll`). */
export const NODE_LABEL = 'content'

/** El mismo tope que el node (`ops.js`). Se re-confirma con `hello`. */
export const MAX_BYTES = 256 * 1024

const err = (code, message) => Object.assign(new Error(message), { code })

/** @returns {Uint8Array<ArrayBuffer>} */
const toBytes = (data) => {
  if (data instanceof Uint8Array) return /** @type {Uint8Array<ArrayBuffer>} */ (data)
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  // Una vista sobre un SharedArrayBuffer no vale: WebCrypto y Blob piden bytes
  // sobre un ArrayBuffer normal, así que se copia en vez de reinterpretar.
  if (ArrayBuffer.isView(data)) return new Uint8Array(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
  if (typeof data === 'string') return new TextEncoder().encode(data)
  throw err('bad-input', 'los datos tienen que ser bytes o texto')
}

const b64 = (bytes) => btoa(String.fromCharCode(...bytes))
/** @returns {Uint8Array<ArrayBuffer>} */
const unb64 = (s) => /** @type {Uint8Array<ArrayBuffer>} */ (Uint8Array.from(atob(s), (c) => c.charCodeAt(0)))

export class ContentClient {
  /**
   * @param {{ link: any, owner: string, agent: any, session: any, hello: any }} parts
   *   No se construye a mano: se usa `ContentClient.connect()`.
   */
  constructor ({ link, owner, agent, session, hello }) {
    this.link = link
    this.owner = owner
    this.agent = agent          // { sub, label, deviceId } del node elegido
    this._session = session
    this.hello = hello
    this.maxBytes = Number(hello?.maxBytes) || MAX_BYTES
    this._rid = 0
    this._waiting = new Map()
    session.on('message', (msg) => {
      const w = this._waiting.get(msg?.rid)
      if (w) { this._waiting.delete(msg.rid); w(msg) }
    })
  }

  /**
   * Lista los content nodes del usuario **según su bóveda**, sin abrir ninguna
   * sesión. Útil para una pantalla de ajustes ("tienes 2 nodes") o para decidir si
   * merece la pena intentar `connect`.
   * @param {object} identity  instancia de `@dotrino/identity` ya conectada
   */
  static async listNodes (identity) {
    return listAgentsByLabel(identity, NODE_LABEL)
  }

  /**
   * Abre sesión con un content node del usuario. Prueba los suyos por orden y se
   * queda con el primero que conteste: no hay «el node principal», solo aparatos
   * del dueño, y cualquiera vale porque el `cid` verifica los bytes.
   *
   * @param {{ link?: any, agentPubkey?: string, proxyUrl?: string, timeoutMs?: number }} [opts]
   *   link: `{ id, cert, iss, proxy }` — el enlace del dispositivo a su bóveda,
   *   el mismo que usa la terminal (`vaultStatus()` + `getVaultCert()`).
   * @throws {Error & {code:'no-node'}} si ninguno contesta. **Es lo esperable** y
   *   la app tiene que saber seguir sin node.
   * @throws {Error & {code:'no-vault-reply'}} si no se pudo ni preguntar (bóveda apagada o
   *   incomunicada). Distinto de `no-node`: aquí no se sabe qué nodes hay.
   */
  static async connect ({ link, agentPubkey, proxyUrl, timeoutMs = 8000 } = {}) {
    if (!link?.id || !link?.iss) throw err('no-vault', 'este dispositivo no está enlazado a una bóveda')
    // Si la bóveda no contesta, NO es «no tienes node»: es que no se pudo preguntar. Un
    // `.catch(() => [])` convertía las dos cosas en el mismo mensaje y mandó al bot social
    // días a buscar un node enrolado que estaba ahí — el error de verdad («the vault did not
    // reply») no aparecía en ningún log (2026-08-24).
    let candidates
    if (agentPubkey) candidates = [{ sub: agentPubkey, label: NODE_LABEL }]
    else {
      try { candidates = await listAgentsByLabel(link.id, NODE_LABEL) }
      catch (e) { throw err('no-vault-reply', `no se pudo preguntar a tu bóveda qué nodes tienes: ${e.message}`) }
    }
    if (!candidates.length) throw err('no-node', 'no tienes ningún node de contenido enrolado')

    let last = null
    for (const agent of candidates) {
      const session = new RemoteAgentClient(link, { agentPubkey: agent.sub, proxyUrl })
      try {
        await session.connect()
        const cc = new ContentClient({ link, owner: null, agent, session, hello: null })
        const hello = await cc._ask({ op: 'hello' }, timeoutMs)
        cc.hello = hello
        cc.owner = hello.owner
        cc.maxBytes = Number(hello.maxBytes) || MAX_BYTES
        return cc
      } catch (e) {
        last = e
        try { await session.close() } catch (_) {}
      }
    }
    throw err('no-node', `ningún node tuyo contestó${last ? ` (${last.message})` : ''}`)
  }

  /** Una petición al node, con su respuesta. Correlación por `rid`. */
  async _ask (msg, timeoutMs = 15000) {
    const rid = ++this._rid
    const reply = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._waiting.delete(rid)
        reject(err('timeout', 'el node no contestó'))
      }, timeoutMs)
      this._waiting.set(rid, (m) => { clearTimeout(timer); resolve(m) })
    })
    await this._session.send({ ...msg, rid })
    const res = await reply
    // El contrato de errores del node es `code`, nunca la frase: traducir la frase
    // rompería en silencio a quien la compare (y alguien siempre la compara).
    if (res.ok === false) throw err(res.code || 'failed', res.error || 'el node rechazó la operación')
    return res
  }

  /**
   * Guarda bytes en el node y devuelve la **referencia compartible**.
   *
   * Cifra por defecto: el node guarda ciphertext y la llave sale en la referencia,
   * para el `#fragment`. Con `encrypt: false` el contenido queda en claro en el
   * node — que es lo que hace falta para poder marcarlo `public` y que tenga vista
   * previa, porque una tarjeta de algo cifrado no la puede ver nadie.
   *
   * @param {Uint8Array|ArrayBuffer|string} data
   * @param {{ mime?: string, encrypt?: boolean, acl?: 'public'|'private',
   *           ttlMs?: number, meta?: object }} [opts]
   * @returns {Promise<{ owner: string, cid: string, key: string|null, size: number, existed: boolean }>}
   */
  async put (data, opts = {}) {
    const raw = toBytes(data)
    const encrypt = opts.encrypt !== false
    if (encrypt && opts.acl === 'public') {
      throw err('bad-input', 'un blob cifrado no puede ser público: nadie sin la llave podría leerlo')
    }
    const { bytes, keyStr } = encrypt ? await encryptBlob(raw) : { bytes: raw, keyStr: null }
    if (bytes.length > this.maxBytes) {
      throw err('too-large',
        `${bytes.length} bytes no caben por el plano de control (tope ${this.maxBytes}); ` +
        'lo grande sube en local o, cuando exista, por P2P')
    }
    const res = await this._ask({
      op: 'put',
      data: b64(bytes),
      mime: opts.mime || 'application/octet-stream',
      enc: encrypt ? 1 : 0,
      acl: opts.acl === 'public' ? 'public' : 'private',
      ttl: opts.ttlMs || 0,
      meta: opts.meta || null
    })
    return { owner: this.owner, cid: res.cid, key: keyStr, size: res.size, existed: !!res.existed }
  }

  /**
   * Lee una referencia y devuelve los bytes en claro.
   *
   * Comprueba el hash: el `cid` **es** el hash de lo que se guardó, así que unos
   * bytes que no cuadren se rechazan aquí, sin importar quién los mandó. Es la
   * mitad de la promesa del direccionado por contenido; la otra mitad —que quien
   * responde sea un aparato del dueño— la da el certificado de la sesión.
   *
   * @param {{owner?:string, cid:string, key?:string|null}|string} ref  referencia o fragmento
   */
  async get (ref) {
    const r = typeof ref === 'string' ? parseRef(ref) : ref
    if (!r?.cid || !isValidCid(r.cid)) throw err('bad-input', 'referencia inválida')
    if (r.owner && this.owner && r.owner !== this.owner) {
      throw err('not-mine', 'esa referencia es de otro dueño: hoy solo puedes leer la tuya')
    }
    const res = await this._ask({ op: 'get', cid: r.cid })
    const stored = unb64(res.data)
    if (!await matchesCid(stored, r.cid)) throw err('corrupt', 'los bytes no coinciden con el cid')
    return r.key ? decryptBlob(stored, r.key) : stored
  }

  /** Metadatos de un blob sin traerse los bytes. */
  async stat (cid) { return (await this._ask({ op: 'stat', cid })).blob }

  /** Qué guarda este node. */
  async list () { return (await this._ask({ op: 'list' })).blobs }

  /** Uso de disco y cuota del node. */
  async stats () { return (await this._ask({ op: 'stats' })).stats }

  /** Retener un blob: el GC no lo toca, ni por vencimiento ni por cuota. */
  async pin (cid, pinned = true) { return this._ask({ op: pinned ? 'pin' : 'unpin', cid }) }

  async remove (cid) { return this._ask({ op: 'remove', cid }) }

  /** Abrir o cerrar un blob al mundo. Público es opt-in, y nunca sobre lo cifrado. */
  async setAcl (cid, acl) { return this._ask({ op: 'acl', cid, acl }) }

  /** Nombre/título/descripción de la tarjeta de la vista previa. */
  async setMeta (cid, meta) { return this._ask({ op: 'meta', cid, meta }) }

  /** Enlaza la miniatura (otro blob, que se publica por su cuenta). */
  async setThumbnail (cid, thumbnailCid) { return this._ask({ op: 'thumb', cid, thumbnailCid }) }

  async close () { try { await this._session.close() } catch (_) {} }
}

/**
 * ¿Estos bytes son los del `cid`?
 * @param {Uint8Array<ArrayBuffer>} bytes @param {string} cid
 */
export async function matchesCid (bytes, cid) {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
  return `sha256-${hex}` === cid
}

export default { ContentClient, buildRef, buildUrl, parseRef, matchesCid, NODE_LABEL, MAX_BYTES }
