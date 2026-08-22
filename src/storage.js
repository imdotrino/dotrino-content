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
    fatal.push('el bucket privado y el público son el mismo: lo cifrado acabaría en el que tiene dominio')
  }

  // 2. El privado NO puede responder sin credenciales. Se pide un objeto que no existe:
  //    un bucket cerrado contesta 401/403 (no autorizado), y uno ABIERTO contesta 404
  //    (no está) — que es lo que delata que cualquiera puede leer los que sí están.
  try {
    const r = await f(priv.urlFor('sha256-' + '0'.repeat(64)), { method: 'GET' })
    if (r.status === 404 || r.ok) {
      fatal.push(`el bucket privado «${cfg.priv}» responde sin credenciales (HTTP ${r.status}): está abierto al mundo`)
    }
  } catch (e) {
    warn.push(`no se pudo comprobar si el bucket privado está cerrado: ${e.message}`)
  }

  // 3. El dominio del público tiene que servir de verdad. Un dominio mal conectado no
  //    da error en ningún sitio: simplemente no sirve nunca, y se descubre tarde.
  if (pub && cfg.baseUrl) {
    try {
      const r = await f(`${cfg.baseUrl.replace(/\/+$/, '')}/sha256-${'0'.repeat(64)}`, { method: 'GET' })
      // Un 404 aquí es la respuesta BUENA: el dominio llega al bucket y el objeto no
      // existe. Lo malo es un 5xx, un 000 o una redirección a otra cosa.
      if (r.status >= 500 || r.status === 0) warn.push(`el dominio público ${cfg.baseUrl} contestó ${r.status}`)
    } catch (e) {
      warn.push(`el dominio público ${cfg.baseUrl} no contesta: ${e.message}`)
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
    log(`[almacén] CONTENT_STORAGE=«${cfg.kind}» no es un proveedor conocido (${Object.keys(PROVIDERS).join(', ')}); sigo en local`)
    return { store: await new BlobStore(dir).init(), cfg }
  }
  if (cfg.missing.length) {
    log(`[almacén] ${cfg.kind} pedido pero faltan variables: ${cfg.missing.join(', ')}`)
    log('[almacén] sigo en LOCAL: un almacén a medio configurar es peor que ninguno')
    return { store: await new BlobStore(dir).init(), cfg }
  }

  const common = { endpoint: cfg.endpoint, region: cfg.region, fetch: f }
  const priv = new S3Bucket({ ...common, bucket: cfg.priv, accessKeyId: cfg.keyId, secretAccessKey: cfg.secret })
  const pub = cfg.pub
    ? new S3Bucket({ ...common, bucket: cfg.pub, accessKeyId: cfg.pubKeyId, secretAccessKey: cfg.pubSecret })
    : null

  if (check) {
    const { ok, fatal, warn } = await checkBuckets(cfg, { priv, pub }, f)
    for (const w of warn) log(`[almacén] ⚠ ${w}`)
    if (!ok) {
      for (const e of fatal) log(`[almacén] ✖ ${e}`)
      log('[almacén] sigo en LOCAL hasta que eso se arregle')
      return { store: await new BlobStore(dir).init(), cfg }
    }
  }

  log(`[almacén] ${cfg.kind}: privado «${cfg.priv}»${cfg.pub ? `, público «${cfg.pub}» en ${cfg.baseUrl}` : ' (sin bucket público: lo público viaja por la red)'}`)
  return { store: await new S3BlobStore({ root: dir, priv, pub, log }).init(), cfg }
}

export default { storageConfig, checkBuckets, openStore, PROVIDERS }
