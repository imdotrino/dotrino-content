/**
 * thumb.js — MINIATURAS, generadas en el navegador. Solo navegador (usa canvas).
 *
 * El node **no decodifica imágenes** y no va a hacerlo: eso pediría una
 * dependencia nativa, y el `.npmrc` del ecosistema bloquea los build scripts de
 * npm por cadena de suministro. Así que la miniatura la hace el aparato que sube,
 * que además es el único que tiene el original en claro cuando el contenido va
 * cifrado. Es el mismo patrón de siempre: el aparato cumple el rol.
 *
 * Para qué sirve: es lo ÚNICO que sale por el puerto público del node (§7.2), o
 * sea lo que ve alguien cuando pegas el enlace en una red. Por eso se genera
 * pequeña y en WebP: una tarjeta no necesita más, y lo que sale de tu máquina lo
 * pagas tú.
 */

/** Lado mayor de la miniatura, en píxeles. Una tarjeta social no da para más. */
export const THUMB_MAX_SIDE = 640
/** Calidad WebP. 0.75 es donde deja de notarse a ese tamaño. */
export const THUMB_QUALITY = 0.75

/**
 * ¿Este tipo puede tener miniatura y salir por el puerto público? Coincide a
 * propósito con lo que el node acepta servir: mapa de bits y **sin SVG**, que es
 * un documento con scripts y no una imagen.
 */
export const THUMBABLE = /^image\/(jpeg|png|gif|webp|avif)$/

/**
 * Genera la miniatura de una imagen.
 *
 * @param {Blob|File|Uint8Array<ArrayBuffer>|ArrayBuffer} input
 * @param {{ maxSide?: number, quality?: number, type?: string }} [opts]
 * @returns {Promise<{ bytes: Uint8Array<ArrayBuffer>, mime: string, width: number, height: number }>}
 * @throws si el navegador no puede decodificar eso como imagen — no se disimula:
 *   una miniatura vacía sería una tarjeta rota, y es mejor no ofrecer tarjeta.
 */
export async function makeThumbnail (input, opts = {}) {
  const maxSide = opts.maxSide || THUMB_MAX_SIDE
  const quality = opts.quality ?? THUMB_QUALITY
  const type = opts.type || 'image/webp'
  const blob = input instanceof Blob ? input : new Blob([/** @type {BlobPart} */ (input)])

  const bitmap = await createImageBitmap(blob)
  try {
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height))
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))

    // Las dos ramas van separadas y no unificadas en un `canvas` cualquiera:
    // `OffscreenCanvas` y `HTMLCanvasElement` no comparten el método de salida
    // (`convertToBlob` vs `toBlob`), y tratarlas como una sola cosa es justo lo
    // que hace que un `undefined` se descubra en producción.
    let out
    if (typeof OffscreenCanvas !== 'undefined') {
      const canvas = new OffscreenCanvas(width, height)
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('sin canvas 2d en este navegador')
      ctx.drawImage(bitmap, 0, 0, width, height)
      out = await canvas.convertToBlob({ type, quality })
    } else {
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('sin canvas 2d en este navegador')
      ctx.drawImage(bitmap, 0, 0, width, height)
      out = await new Promise((resolve) => canvas.toBlob(resolve, type, quality))
    }
    if (!out) throw new Error('el navegador no pudo generar la miniatura')
    return { bytes: new Uint8Array(await out.arrayBuffer()), mime: out.type || type, width, height }
  } finally {
    bitmap.close?.()
  }
}

/**
 * Sube una imagen y su miniatura de una vez, y las deja listas para tener tarjeta.
 *
 * Reparto, que es el que importa: **el original va cifrado y privado** (solo lo
 * abre quien tenga la llave del enlace) y **la miniatura va en claro y pública**,
 * porque una tarjeta que nadie puede ver no es una tarjeta. Quien decide que haya
 * tarjeta es quien llama a esto, no la librería: si no quieres que se vea nada,
 * sube el original y ya está.
 *
 * @param {import('./index.js').ContentClient} cc
 * @param {Blob|File} file
 * @param {{ meta?: object, thumb?: object, encrypt?: boolean }} [opts]
 * @returns {Promise<{ ref: any, thumb: any|null }>}
 */
export async function putImageWithThumbnail (cc, file, opts = {}) {
  const mime = file.type || 'application/octet-stream'
  const ref = await cc.put(new Uint8Array(await file.arrayBuffer()), {
    mime,
    encrypt: opts.encrypt !== false,
    meta: opts.meta || ('name' in file && file.name ? { name: file.name } : null)
  })

  if (!THUMBABLE.test(mime)) return { ref, thumb: null }

  let thumb = null
  try {
    const t = await makeThumbnail(file, opts.thumb)
    thumb = await cc.put(t.bytes, { mime: t.mime, encrypt: false, acl: 'public' })
    await cc.setThumbnail(ref.cid, thumb.cid)
  } catch (_) {
    // Sin miniatura se pierde la tarjeta, no el contenido. No es motivo para
    // tirar una subida que ya salió bien.
  }
  return { ref, thumb }
}

export default { makeThumbnail, putImageWithThumbnail, THUMBABLE, THUMB_MAX_SIDE }
