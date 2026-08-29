/**
 * Qué almacén usa este node, y las comprobaciones antes de fiarse de él
 * (DISENO.md §15.14 y §15.15).
 *
 * Una variable pública manda —`CONTENT_STORAGE`— y las demás solo tienen sentido si
 * nombra un proveedor. El valor nombra a QUIÉN está detrás (`r2`, `b2`, `hetzner`,
 * `storj`, `s3`), no al protocolo: todos hablan S3 y usan el mismo backend, pero
 * saberlo permite poner sus valores por omisión y, sobre todo, que quien mire la
 * consola entienda lo que lee.
 *
 * **Nunca arranca a medias.** Si falta algo o una comprobación falla, se queda en
 * `local` y lo DICE. Un almacén mal configurado que parece funcionar es la peor de las
 * tres opciones: se descubre el día que hace falta lo que se creía guardado.
 */
import { createHash } from 'node:crypto'
import { BlobStore } from './blobstore.js'
import { S3BlobStore } from './blobstore-s3.js'
import { S3Bucket } from './s3.js'

/** Proveedores que hablan S3. Solo cambian el endpoint y algún valor por omisión. */
export const PROVIDERS = Object.freeze({
  r2: { region: 'auto' },
  b2: { region: 'us-west-004' },
  hetzner: { region: 'eu-central' },
  storj: { region: 'us-east-1' },
  s3: { region: 'us-east-1' }
})

/** La sonda del camino público: nueve bytes que se suben y se leen por el dominio. */
const PROBE = 'dotrino!'

/** Lo que hace falta para hablar con un bucket, más lo que hace falta para el público. */
const REQUIRED = ['CONTENT_S3_ENDPOINT', 'CONTENT_S3_BUCKET_PRIVATE', 'CONTENT_S3_KEY_ID', 'CONTENT_S3_SECRET']
const REQUIRED_PUBLIC = ['CONTENT_S3_PUBLIC_KEY_ID', 'CONTENT_S3_PUBLIC_SECRET', 'CONTENT_PUBLIC_BASE_URL']

/**
 * Lee la configuración del entorno (que la sirve el vault, §15.14).
 * @param {Record<string,string|undefined>} [env]
 * @returns {{ kind: string, provider: string|null, missing: string[], region: string,
 *             endpoint: string, priv: string, pub: string|null, baseUrl: string|null,
 *             keyId: string, secret: string, pubKeyId: string, pubSecret: string }}
 */
export function storageConfig (env = process.env) {
  const kind = (env.CONTENT_STORAGE || 'local').trim().toLowerCase()
  if (kind === 'local') return { kind: 'local', provider: null, missing: [] , region: '', endpoint: '', priv: '', pub: null, baseUrl: null, keyId: '', secret: '', pubKeyId: '', pubSecret: '' }

  const provider = PROVIDERS[kind] ? kind : null
  const missing = REQUIRED.filter((k) => !env[k])

  // El bucket público es OPCIONAL a propósito: un node puede tener bucket solo para lo
  // privado (durabilidad) y seguir sirviendo lo público por la red (§15.3). Pero si lo
  // declara a medias, eso sí es un error — no se publica «casi».
  const wantsPublic = !!env.CONTENT_S3_BUCKET_PUBLIC
  if (wantsPublic) missing.push(...REQUIRED_PUBLIC.filter((k) => !env[k]))

  return {
    kind,
    provider,
    missing,
    region: env.CONTENT_S3_REGION || PROVIDERS[kind]?.region || 'us-east-1',
    endpoint: env.CONTENT_S3_ENDPOINT || '',
    priv: env.CONTENT_S3_BUCKET_PRIVATE || '',
    pub: wantsPublic ? env.CONTENT_S3_BUCKET_PUBLIC : null,
    baseUrl: env.CONTENT_PUBLIC_BASE_URL || null,
    keyId: env.CONTENT_S3_KEY_ID || '',
    secret: env.CONTENT_S3_SECRET || '',
    pubKeyId: env.CONTENT_S3_PUBLIC_KEY_ID || '',
    pubSecret: env.CONTENT_S3_PUBLIC_SECRET || ''
  }
}

/**
 * Las tres comprobaciones del §15.15, las que se rompen SIN DAR ERROR.
 *
 * @param {ReturnType<typeof storageConfig>} cfg
 * @param {{ priv: S3Bucket, pub: S3Bucket|null }} buckets
 * @param {typeof fetch} [f]
 * @returns {Promise<{ ok: boolean, fatal: string[], warn: string[] }>}
 */
export async function checkBuckets (cfg, { priv, pub }, f = fetch) {
  const fatal = []
  const warn = []

  // 1. El mismo bucket para las dos cosas: lo privado acabaría en el que tiene dominio.
  if (cfg.pub && cfg.pub === cfg.priv) {
    fatal.push('the private and public buckets are the same: encrypted blobs would land in the one with a domain')
  }

  // 2. El privado NO puede responder sin credenciales. Se pide un objeto que no existe:
  //    un bucket cerrado contesta 400/401/403 (falta la firma o no autoriza), y uno
  //    ABIERTO contesta 404 (no está) — que es lo que delata que cualquiera puede leer
  //    los que sí están.
  //
  //    LO QUE ESTO NO VE, y hay que decirlo: si alguien conecta un DOMINIO al bucket
  //    privado, este sondeo no se entera — pregunta al endpoint de S3, que sigue
  //    exigiendo firma aunque el bucket tenga dominio público. Contra eso no hay API:
  //    es responsabilidad de quien crea los buckets (§15.15).
  try {
    const r = await f(priv.urlFor('sha256-' + '0'.repeat(64)), { method: 'GET' })
    if (r.status === 404 || r.ok) {
      fatal.push(`the private bucket "${cfg.priv}" answers without credentials (HTTP ${r.status}): it is open to the world`)
    }
  } catch (e) {
    warn.push(`no se pudo comprobar si el bucket privado está cerrado: ${e.message}`)
  }

  // 3. El dominio del público tiene que servir DE VERDAD, y eso no se deduce mirando
  //    una respuesta de error: se comprueba subiendo algo y leyéndolo por el dominio.
  //
  //    Se intentó antes por las malas —«si el 404 viene en HTML, el dominio no es el
  //    bucket»— y se cayó sola: GitHub Pages contesta un 404 en HTML, pero R2 TAMBIÉN
  //    contesta el suyo en HTML. Dos cosas indistinguibles por su página de error.
  //
  //    La sonda es un objeto de nueve bytes, siempre el mismo (su nombre es su hash, así
  //    que subirla dos veces no ensucia nada) y su presencia documenta que el enlace
  //    funciona. Cuesta dos peticiones al arrancar.
  if (pub && cfg.baseUrl) {
    try {
      const bytes = Buffer.from(PROBE)
      const cid = 'sha256-' + createHash('sha256').update(bytes).digest('hex')
      await pub.put(cid, bytes, { sha256: cid.slice(7), size: bytes.length, contentType: 'text/plain' })
      const r = await f(`${cfg.baseUrl.replace(/\/+$/, '')}/${cid}`, { method: 'GET' })
      const body = r.ok ? (await r.text()).trim() : ''
      if (body !== PROBE) {
        warn.push(`${cfg.baseUrl} no sirve lo que hay en «${cfg.pub}» (HTTP ${r.status}): revisa que el dominio esté conectado AL BUCKET desde el panel`)
      }
    } catch (e) {
      warn.push(`no se pudo comprobar el camino público: ${e.message}`)
    }
  }

  return { ok: fatal.length === 0, fatal, warn }
}

/**
 * Monta el almacén que toca. Devuelve SIEMPRE algo utilizable: si el bucket no está o
 * no pasa las comprobaciones, devuelve el de disco y explica por qué.
 *
 * @param {{ dir: string, env?: any, log?: (m:string)=>void, check?: boolean, fetch?: typeof fetch }} o
 */
export async function openStore ({ dir, env = process.env, log = () => {}, check = true, fetch: f = fetch }) {
  const cfg = storageConfig(env)
  if (cfg.kind === 'local') return { store: await new BlobStore(dir).init(), cfg }

  if (!cfg.provider) {
    log(`[storage] CONTENT_STORAGE="${cfg.kind}" is not a known provider (${Object.keys(PROVIDERS).join(', ')}); staying on LOCAL`)
    return { store: await new BlobStore(dir).init(), cfg }
  }
  if (cfg.missing.length) {
    log(`[storage] ${cfg.kind} requested but these variables are missing: ${cfg.missing.join(', ')}`)
    log('[storage] staying on LOCAL: a half-configured store is worse than none')
    return { store: await new BlobStore(dir).init(), cfg }
  }

  const common = { endpoint: cfg.endpoint, region: cfg.region, fetch: f }
  const priv = new S3Bucket({ ...common, bucket: cfg.priv, accessKeyId: cfg.keyId, secretAccessKey: cfg.secret })
  const pub = cfg.pub
    ? new S3Bucket({ ...common, bucket: cfg.pub, accessKeyId: cfg.pubKeyId, secretAccessKey: cfg.pubSecret })
    : null

  if (check) {
    const { ok, fatal, warn } = await checkBuckets(cfg, { priv, pub }, f)
    for (const w of warn) log(`[storage] ⚠ ${w}`)
    if (!ok) {
      for (const e of fatal) log(`[storage] ✖ ${e}`)
      log('[storage] staying on LOCAL until that is fixed')
      return { store: await new BlobStore(dir).init(), cfg }
    }
  }

  log(`[storage] ${cfg.kind}: private "${cfg.priv}"${cfg.pub ? `, public "${cfg.pub}" at ${cfg.baseUrl}` : ' (no public bucket: public reads go over the network)'}`)
  return { store: await new S3BlobStore({ root: dir, priv, pub, log }).init(), cfg }
}

export default { storageConfig, checkBuckets, openStore, PROVIDERS }
