/**
 * El almacén con BUCKET detrás (DISENO.md §15).
 *
 * Misma interfaz que `BlobStore` —`put`, `read`, `sizeOf`, `remove`— para que ni la API
 * local, ni el plano de control, ni el puerto de vistas previas se enteren de dónde
 * salen los bytes. Lo que cambia es de dónde salen:
 *
 *     disco (caché)  →  si está, sale de aquí, y así es como se sirve casi siempre
 *     bucket         →  si no, se jala mientras se sirve y se deja la copia
 *
 * Tres cosas que no son detalles:
 *
 *  · **Se escribe primero en local y se responde.** La subida al bucket va detrás, y
 *    hasta que el bucket confirma, ese blob NO es desalojable (`remote`, §15.11). Un
 *    pendiente que no logra subir se reintenta y se reporta; no se olvida.
 *  · **Público y privado son buckets distintos** y con credenciales distintas (§15.1).
 *    Cuál toca lo dice el ACL del blob, y quien lo sabe es el índice — por eso `put` y
 *    `upload` reciben `isPublic` en vez de adivinarlo.
 *  · **Una lectura parcial NO puebla la caché.** Cachear trozos sueltos dejaría
 *    agujeros que luego parecen un blob completo.
 */
import { createWriteStream } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { PassThrough } from 'node:stream'
import { BlobStore, isValidCid } from './blobstore.js'
import { S3Bucket, S3Error } from './s3.js'

/** Lo que se le pone a un objeto público: es inmutable por construcción (§15.2). */
const IMMUTABLE = 'public, max-age=31536000, immutable'

/** Del `cid` a la clave del objeto. Sin prefijos: el bucket ya separa público de privado. */
const keyOf = (cid) => {
  if (!isValidCid(cid)) throw new Error(`invalid cid: ${cid}`)
  return cid
}

export class S3BlobStore {
  /**
   * @param {object} o
   * @param {string} o.root directorio de la CACHÉ (el mismo árbol `blobs/` de siempre)
   * @param {S3Bucket} o.priv bucket privado (obligatorio: es donde va todo lo cifrado)
   * @param {S3Bucket|null} [o.pub] bucket público; sin él, lo público viaja por la red (§15.3)
   * @param {(m:string)=>void} [o.log]
   */
  constructor ({ root, priv, pub = null, log = () => {} }) {
    if (!priv) throw new Error('S3BlobStore: the private bucket is missing')
    this.cache = new BlobStore(root)
    this.priv = priv
    this.pub = pub
    this.log = log
    /** Hay una segunda copia detrás: el GC puede desalojar en vez de destruir (§15.11). */
    this.backed = true
  }

  async init () {
    await this.cache.init()
    return this
  }

  /** El bucket que le toca a un blob según su ACL. */
  bucketFor (isPublic) {
    if (!isPublic) return this.priv
    if (!this.pub) throw new Error('this node has no public bucket (CONTENT_S3_BUCKET_PUBLIC)')
    return this.pub
  }

  /** La URL pública de un blob, o `null` si este node no publica por bucket. */
  urlFor (cid, baseUrl) {
    return baseUrl ? `${String(baseUrl).replace(/\/+$/, '')}/${keyOf(cid)}` : null
  }

  pathFor (cid) { return this.cache.pathFor(cid) }

  /** Guarda en la caché. La subida al bucket la lanza el node después (`upload`). */
  async put (readable, opts) {
    return this.cache.put(readable, opts)
  }

  /**
   * Sube al bucket que le toca y **confirma**. Quien llama es el único que puede marcar
   * `remote`, y solo con lo que devuelve esto: marcar al lanzar la subida es
   * exactamente el error que deja perder contenido.
   *
   * @param {string} cid
   * @param {{ size: number, mime?: string, public?: boolean }} meta
   */
  async upload (cid, { size, mime, public: isPublic = false }) {
    const bucket = this.bucketFor(isPublic)
    const body = this.cache.read(cid)
    await bucket.put(keyOf(cid), Readable.toWeb(body), {
      sha256: cid.slice('sha256-'.length),
      size,
      contentType: mime || 'application/octet-stream',
      // Solo lo público lleva cabecera de caché: es lo único que sirve un CDN.
      ...(isPublic ? { cacheControl: IMMUTABLE } : {})
    })
    return { cid, remote: true }
  }

  /** ¿Está en la caché de esta máquina? (no pregunta al bucket: eso cuesta una petición) */
  async sizeOf (cid) {
    return this.cache.sizeOf(cid)
  }

  /**
   * Lee. Si está en la caché sale de ahí; si no, se jala del bucket **mientras se
   * sirve** y se deja la copia — salvo que sea una lectura parcial.
   *
   * Devuelve un stream, como el de disco, para que quien llama no cambie.
   *
   * @param {string} cid
   * @param {{ start: number, end: number }} [range] inclusivo
   * @param {{ public?: boolean }} [opts] de qué bucket, si hay que ir a buscarlo
   */
  read (cid, range, { public: isPublic = false } = {}) {
    const out = new PassThrough()
    this.cache.sizeOf(cid).then(async (size) => {
      if (size !== null) return pipeline(this.cache.read(cid, range), out)

      const bucket = this.bucketFor(isPublic)
      const { body } = await bucket.get(keyOf(cid), range || null)
      const src = Readable.fromWeb(/** @type {any} */ (body))

      // Parcial: se sirve y se olvida. Guardar un trozo dejaría en la caché algo que
      // parece el blob entero y no lo es.
      if (range) { src.pipe(out); return }

      // Entero: el mismo stream va a DOS destinos —quien pidió y el disco—, y solo al
      // terminar bien se pone en su sitio. Si la descarga se corta, no queda medio blob
      // con el nombre bueno, que luego se serviría como si estuviera completo.
      const dest = this.cache.pathFor(cid)
      const tmp = dest + '.dl'
      await mkdir(path.dirname(dest), { recursive: true })
      const disk = createWriteStream(tmp)
      src.pipe(out)
      src.pipe(disk)
      disk.on('finish', () => { rename(tmp, dest).catch(() => rm(tmp, { force: true })) })
      src.on('error', () => { disk.destroy(); rm(tmp, { force: true }).catch(() => {}) })
    }).catch((e) => out.destroy(e))
    return out
  }

  /**
   * Los primeros `n` bytes. Es lo que necesita el puerto público para comprobar el tipo
   * REAL de una imagen por sus bytes mágicos (§7.2) — y existe en la interfaz porque
   * con bucket detrás no hay ninguna ruta de disco que abrir.
   */
  async readHead (cid, n, { public: isPublic = false } = {}) {
    const local = await this.cache.sizeOf(cid)
    if (local !== null) return this.cache.readHead(cid, n)
    return this.bucketFor(isPublic).head(keyOf(cid), n)
  }

  /** Suelta la copia local y deja la del bucket (desalojar, §15.11). */
  async evict (cid) {
    await this.cache.remove(cid)
  }

  /** Borra de verdad: de la caché y del bucket. Caducar y despublicar pasan por aquí. */
  async remove (cid, { public: isPublic = null } = {}) {
    await this.cache.remove(cid)
    // Sin saber su ACL se borra de los dos: es idempotente y borrar lo que no está no
    // es un error. Más vale una petición de más que dejar un objeto huérfano pagando.
    const buckets = isPublic === null ? [this.priv, this.pub] : [this.bucketFor(isPublic)]
    for (const b of buckets) {
      if (!b) continue
      try { await b.remove(keyOf(cid)) } catch (e) {
        if (!(e instanceof S3Error) || e.status !== 404) throw e
      }
    }
  }
}

export default { S3BlobStore }
