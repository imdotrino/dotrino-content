// Las formas de datos del node. Solo tipos: el código es JS con JSDoc.

/** Un rango de bytes, inclusivo. */
export interface ByteRange { start: number, end: number }

/** Presentación de un blob: con esto arma la tarjeta la vista previa (§7.3). */
export interface BlobMeta { name?: string, title?: string, description?: string, [k: string]: unknown }

/** Una fila de `blobs` en el índice (db.js). */
export interface BlobRow {
  cid: string
  size: number
  mime: string
  createdAt: number
  owner: string | null
  enc: number
  acl: string | null
  ttl: number | null
  pinned: number
  thumbnailCid: string | null
  /** JSON de BlobMeta, tal cual está en la base. */
  meta: string | null
  remote: number
  cached: number
  lastRead: number | null
  tag: string | null
}

/** Lo que `list()` saca de cada blob. */
export type BlobListRow = Pick<BlobRow, 'cid' | 'size' | 'mime' | 'createdAt' | 'owner' | 'enc' | 'acl' | 'ttl' | 'pinned' | 'meta' | 'tag'>
/** Lo que `listPublic()` saca de cada blob. */
export type PublicRow = Pick<BlobRow, 'cid' | 'size' | 'mime' | 'createdAt' | 'meta'>

export interface UpsertInput {
  cid: string
  size: number
  mime: string
  owner?: string | null
  enc?: number | boolean
  acl?: string | null
  ttl?: number | null
  meta?: BlobMeta | null
  tag?: string | null
}

/** Opciones de `ContentNode.put`. */
export interface PutOptions {
  mime?: string
  enc?: number
  ttl?: number | null
  acl?: string | null
  meta?: BlobMeta | null
  tag?: string | null
}

/** Lo que se le pasa a `upload` al subir al bucket. */
export interface UploadMeta { size: number, mime: string, public?: boolean }

/** El almacén de bytes del node: disco (`BlobStore`) o bucket con caché (`S3BlobStore`). */
export interface Store {
  backed: boolean
  init (): Promise<Store>
  pathFor (cid: string): string
  sizeOf (cid: string): Promise<number | null>
  put (readable: import('node:stream').Readable, opts?: { maxBytes?: number }): Promise<{ cid: string, size: number, existed: boolean }>
  read (cid: string, range?: ByteRange | null, opts?: { public?: boolean }): import('node:stream').Readable
  readHead (cid: string, n: number, opts?: { public?: boolean }): Promise<Buffer>
  remove (cid: string, opts?: { public?: boolean | null }): Promise<void>
  evict (cid: string): Promise<void>
  /** Solo con bucket detrás. */
  upload? (cid: string, meta: UploadMeta): Promise<unknown>
  urlFor? (cid: string, baseUrl: string | null): string | null
}

/**
 * Lo que se usa del transporte (`WebSocketProxyClient`, ya conectado por el agente). Lo que
 * llega por `message` viene de la red: se comprueba antes de usarlo, y por eso va sin tipo.
 */
export interface ProxyLike {
  token?: string | null
  /** El proxio que nos atiende y los que conoce (la malla). */
  node?: string | null
  knownNodes?: string[]
  on (ev: string, cb: (from: string, payload: any) => void): () => void
  send (to: string, payload: object): unknown
  list (channel: string): Promise<string[]>
  publish (channel: string, extra?: Record<string, unknown>): Promise<unknown>
  unpublish (channel: string): Promise<unknown>
}
