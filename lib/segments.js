/**
 * ARCHIVOS GRANDES CIFRADOS POR TRAMOS. Un blob de `crypto.js` se cifra entero en memoria, y una
 * grabación de una hora pesa 1 GB. Aquí cada tramo de 1 MiB se cierra por su cuenta con AES-GCM,
 * así que se puede cifrar sin cargar el archivo y leer cualquier punto sin descifrar lo anterior.
 *
 * La llave es de UN solo archivo, y por eso el iv puede ser el número de tramo:
 *   iv = [ último ? 1 : 0, 0, 0, 0, número de tramo en 8 bytes big-endian ]
 * Que el iv diga cuál es y si es el último impide reordenar tramos o cortar el archivo: un
 * archivo truncado no abre. Mismo formato en dotrino-native (`SegmentCipher`), con vectores de
 * oro en `test/vectors/segments.json`.
 */
export const SEGMENT_BYTES = 1024 * 1024
export const TAG_BYTES = 16
const CIPHER_SEGMENT = SEGMENT_BYTES + TAG_BYTES

/** @type {(code: string, message: string) => Error & { code: string }} */
const err = (code, message) => Object.assign(new Error(message), { code })

/**
 * @param {number} index
 * @param {boolean} last
 */
export function ivFor (index, last) {
  const iv = new Uint8Array(12)
  iv[0] = last ? 1 : 0
  new DataView(iv.buffer).setBigUint64(4, BigInt(index))
  return iv
}

/** @param {Uint8Array<ArrayBuffer>} key */
const importRaw = (key) => crypto.subtle.importKey('raw', key, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])

/** @param {Uint8Array<ArrayBuffer>} key @param {number} index @param {boolean} last @param {Uint8Array<ArrayBuffer>} plain */
export async function sealSegment (key, index, last, plain) {
  return new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: ivFor(index, last) }, await importRaw(key), plain))
}

/**
 * Lanza `bad-segment` si el tramo no es de esta llave, se tocó o no está en su sitio.
 * @param {Uint8Array<ArrayBuffer>} key
 * @param {number} index
 * @param {boolean} last
 * @param {Uint8Array<ArrayBuffer>} cipher
 */
export async function openSegment (key, index, last, cipher) {
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ivFor(index, last) }, await importRaw(key), cipher))
  } catch (_) { throw err('bad-segment', `segment ${index} does not open with this key`) }
}

/**
 * Cuántos tramos ocupa un archivo cifrado. Un archivo vacío es un tramo con solo la etiqueta.
 * @param {number} cipherSize
 */
export function segmentCount (cipherSize) {
  if (cipherSize < TAG_BYTES) throw err('bad-segment', 'encrypted file too short')
  return Math.max(1, Math.ceil(cipherSize / CIPHER_SEGMENT))
}

/**
 * Lo que mide en claro un archivo cifrado de `cipherSize` bytes.
 * @param {number} cipherSize
 */
export function plainSize (cipherSize) {
  return cipherSize - segmentCount(cipherSize) * TAG_BYTES
}

/**
 * Dónde empieza en el archivo cifrado el tramo `index`, y cuánto mide.
 * @param {number} index
 * @param {number} cipherSize
 */
export function segmentSpan (index, cipherSize) {
  const start = index * CIPHER_SEGMENT
  return { start, end: Math.min(start + CIPHER_SEGMENT, cipherSize) - 1 }
}

export default { SEGMENT_BYTES, TAG_BYTES, ivFor, sealSegment, openSegment, segmentCount, plainSize, segmentSpan }
