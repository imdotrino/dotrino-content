/**
 * crypto.js — cifrado E2E por blob (DISENO.md §4). Isomórfico: WebCrypto, que
 * está en el navegador y en Node ≥ 19. Sin dependencias.
 *
 * El modelo, en una frase: **el node guarda ciphertext y la llave viaja en el
 * `#fragment`**, así que quien hospeda el contenido —incluido un sembrador que no
 * es tuyo— puede sostenerlo sin poder leerlo. Eso es lo que hace que replicar en
 * una máquina siempre encendida no sea una concesión (§13.1).
 *
 * Una llave POR BLOB, no una del usuario: compartir un contenido es dar su llave,
 * y con una llave por usuario dar uno sería dar todos. El `cid` que ve el node es
 * el hash del **ciphertext**, no del claro — el node no puede correlacionar dos
 * subidas del mismo archivo, y eso es a propósito aunque cueste el dedup.
 */

const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

const unb64url = (s) => {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
  return Uint8Array.from(bin, (c) => c.charCodeAt(0))
}

/** Llave nueva AES-256-GCM, exportable (tiene que caber en el fragmento). */
export async function makeKey () {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
}

/** La llave como texto para el `#fragment` (base64url, 43 caracteres). */
export async function exportKey (key) {
  return b64url(await crypto.subtle.exportKey('raw', key))
}

/** La llave de vuelta desde el fragmento. */
export async function importKey (str) {
  return crypto.subtle.importKey('raw', unb64url(str), { name: 'AES-GCM' }, true, ['encrypt', 'decrypt'])
}

/**
 * Cifra un blob. El IV (12 bytes, aleatorio) va DELANTE del ciphertext: forma
 * parte del blob, no de la llave, porque no es secreto y así el enlace no crece.
 * @param {Uint8Array<ArrayBuffer>|ArrayBuffer} bytes
 * @param {CryptoKey} [key] si no se pasa, se genera una
 * @returns {Promise<{ bytes: Uint8Array<ArrayBuffer>, key: CryptoKey, keyStr: string }>}
 */
export async function encryptBlob (bytes, key) {
  const k = key || await makeKey()
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, bytes))
  const out = new Uint8Array(iv.length + ct.length)
  out.set(iv, 0)
  out.set(ct, iv.length)
  return { bytes: out, key: k, keyStr: await exportKey(k) }
}

/**
 * Descifra. Si la llave no es la que toca, WebCrypto falla al comprobar la
 * etiqueta GCM y esto lanza: un enlace con la llave cambiada no devuelve basura,
 * devuelve un error.
 * @param {Uint8Array<ArrayBuffer>|ArrayBuffer} bytes  IV (12) + ciphertext
 * @param {CryptoKey|string} key  la llave, o su texto del fragmento
 * @returns {Promise<Uint8Array<ArrayBuffer>>}
 */
export async function decryptBlob (bytes, key) {
  const buf = /** @type {Uint8Array<ArrayBuffer>} */ (bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))
  if (buf.length <= 12) throw new Error('blob cifrado incompleto')
  const k = typeof key === 'string' ? await importKey(key) : key
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: buf.subarray(0, 12) }, k, buf.subarray(12)
  )
  return new Uint8Array(plain)
}

export default { makeKey, exportKey, importKey, encryptBlob, decryptBlob }
