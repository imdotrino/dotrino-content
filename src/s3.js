/**
 * Cliente S3 mínimo, sin SDK (DISENO.md §15.10).
 *
 * Habla el protocolo, no un proveedor: **R2, Backblaze, Hetzner, Storj y el propio
 * S3 de Amazon son el mismo código** con otro `endpoint`. Por eso no hay una
 * "integración de Cloudflare" y otra "de S3": es una sola.
 *
 * Sin dependencias, como toda la Fase 1: `node:crypto` para firmar y `fetch` para
 * hablar. El `.npmrc` del ecosistema bloquea los scripts de instalación, y el SDK
 * oficial son decenas de paquetes para hacer un `PUT`.
 *
 * **El detalle que hace esto barato:** S3 exige mandar el SHA-256 del cuerpo en
 * `x-amz-content-sha256`… y aquí el `cid` YA ES ese hash (`sha256-<hex>`), porque los
 * bytes que se suben son exactamente los que el `cid` direcciona. Así que se firma sin
 * leer el cuerpo dos veces y sin tenerlo entero en memoria: se sube en streaming.
 */
import { createHmac, createHash } from 'node:crypto'

const ALGO = 'AWS4-HMAC-SHA256'
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

const sha256hex = (data) => createHash('sha256').update(data).digest('hex')
const hmac = (key, data) => createHmac('sha256', key).update(data, 'utf8').digest()

/**
 * Codificación de URI de AWS: es la de RFC 3986, que NO es la de `encodeURIComponent`
 * (deja pasar `!'()*`). Una sola diferencia hace que la firma no cuadre y el error que
 * devuelve el servidor no dice cuál.
 */
export function uriEncode (str, encodeSlash = true) {
  let out = ''
  for (const ch of Buffer.from(String(str), 'utf8')) {
    const c = String.fromCharCode(ch)
    if (/[A-Za-z0-9\-._~]/.test(c)) out += c
    else if (c === '/') out += encodeSlash ? '%2F' : '/'
    else out += '%' + ch.toString(16).toUpperCase().padStart(2, '0')
  }
  return out
}

/** `20150830T123600Z` y `20150830` a partir de una fecha. */
export function amzDate (date) {
  const iso = date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  return { amz: iso, day: iso.slice(0, 8) }
}

/**
 * Firma una petición con SigV4 y devuelve las cabeceras que hay que mandar.
 *
 * @param {object} o
 * @param {string} o.method
 * @param {string|URL} o.url
 * @param {Record<string,string>} [o.headers] las que ya lleva (se firman todas)
 * @param {string} [o.payloadHash] hex del SHA-256 del cuerpo; por defecto, cuerpo vacío
 * @param {string} o.accessKeyId
 * @param {string} o.secretAccessKey
 * @param {string} o.region
 * @param {string} [o.service] `s3` salvo en los vectores de prueba de AWS
 * @param {Date} [o.now]
 * @returns {Record<string,string>} cabeceras completas, con `authorization`
 */
export function signRequest ({
  method, url, headers = {}, payloadHash = EMPTY_SHA256,
  accessKeyId, secretAccessKey, region, service = 's3', now = new Date()
}) {
  const u = new URL(url)
  const { amz, day } = amzDate(now)

  // Las cabeceras firmadas van en minúsculas y ordenadas; `host` y la fecha son
  // obligatorias, y en S3 también el hash del cuerpo.
  const all = { ...headers, host: u.host, 'x-amz-date': amz }
  if (service === 's3') all['x-amz-content-sha256'] = payloadHash
  const names = Object.keys(all).map((k) => k.toLowerCase()).sort()
  const lower = Object.fromEntries(Object.entries(all).map(([k, v]) => [k.toLowerCase(), String(v).trim()]))

  const canonicalHeaders = names.map((n) => `${n}:${lower[n]}\n`).join('')
  const signedHeaders = names.join(';')

  const query = [...u.searchParams.entries()]
    .map(([k, v]) => [uriEncode(k), uriEncode(v)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&')

  const canonicalRequest = [
    method.toUpperCase(),
    uriEncode(decodeURIComponent(u.pathname), false),
    query,
    canonicalHeaders,
    signedHeaders,
    payloadHash
  ].join('\n')

  const scope = `${day}/${region}/${service}/aws4_request`
  const stringToSign = [ALGO, amz, scope, sha256hex(canonicalRequest)].join('\n')

  const kDate = hmac(`AWS4${secretAccessKey}`, day)
  const kRegion = hmac(kDate, region)
  const kService = hmac(kRegion, service)
  const kSigning = hmac(kService, 'aws4_request')
  const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex')

  return {
    ...all,
    authorization: `${ALGO} Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    // Se devuelven para poder diagnosticar una firma que no cuadra: el servidor
    // contesta "SignatureDoesNotMatch" y nada más, así que sin esto no hay por dónde.
    _canonicalRequest: canonicalRequest,
    _stringToSign: stringToSign
  }
}

/** Error de S3 con el código que devolvió el servidor (`NoSuchKey`, `AccessDenied`…). */
export class S3Error extends Error {
  constructor (status, code, message, key) {
    super(`S3 ${status} ${code}${key ? ` (${key})` : ''}: ${message}`)
    this.name = 'S3Error'
    this.status = status
    this.code = code
  }
}

/** El cuerpo de error de S3 es XML; solo interesan dos etiquetas. */
const parseError = (xml) => ({
  code: /<Code>([^<]+)<\/Code>/.exec(xml)?.[1] || 'Unknown',
  message: /<Message>([^<]+)<\/Message>/.exec(xml)?.[1] || xml.slice(0, 200)
})

/**
 * Un bucket. Se crea uno por bucket (público y privado tienen credenciales
 * distintas a propósito, §15.1), y no guarda estado: cada petición se firma sola.
 */
export class S3Bucket {
  /**
   * @param {object} o
   * @param {string} o.endpoint p.ej. `https://<id>.r2.cloudflarestorage.com`
   * @param {string} o.bucket
   * @param {string} o.accessKeyId
   * @param {string} o.secretAccessKey
   * @param {string} [o.region] `auto` en R2
   * @param {typeof fetch} [o.fetch] inyectable para la prueba de integración
   */
  constructor ({ endpoint, bucket, accessKeyId, secretAccessKey, region = 'auto', fetch: f = fetch }) {
    if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
      throw new Error('S3Bucket: faltan endpoint, bucket o credenciales')
    }
    this.base = `${String(endpoint).replace(/\/+$/, '')}/${bucket}`
    this.bucket = bucket
    this.region = region
    this.accessKeyId = accessKeyId
    this.secretAccessKey = secretAccessKey
    this.fetch = f
  }

  /** URL de un objeto (path-style: es lo que entienden todos los proveedores). */
  urlFor (key) {
    return `${this.base}/${key.split('/').map((s) => uriEncode(s)).join('/')}`
  }

  /**
   * @private
   * @param {string} method
   * @param {string} key
   * @param {{ headers?: Record<string,string>, body?: any, payloadHash?: string,
   *           contentLength?: number|null }} [opts]
   */
  async request (method, key, { headers = {}, body = null, payloadHash = '', contentLength = null } = {}) {
    const url = this.urlFor(key)
    const h = signRequest({
      method,
      url,
      headers,
      payloadHash: payloadHash || EMPTY_SHA256,
      accessKeyId: this.accessKeyId,
      secretAccessKey: this.secretAccessKey,
      region: this.region
    })
    delete h._canonicalRequest
    delete h._stringToSign
    if (contentLength != null) h['content-length'] = String(contentLength)

    const res = await this.fetch(url, {
      method,
      headers: h,
      body,
      // Node lo exige para mandar un cuerpo en streaming; sin esto hay que
      // tener el archivo entero en memoria, que es justo lo que se evita.
      ...(body && typeof body !== 'string' ? { duplex: 'half' } : {})
    })
    return res
  }

  /**
   * Sube un objeto. `sha256` es el hex del contenido — que aquí es el `cid` sin su
   * prefijo, así que no hay que calcular nada.
   * @param {string} key
   * @param {any} body stream o buffer
   * @param {{ sha256?: string, size?: number, contentType?: string, cacheControl?: string }} [o]
   */
  async put (key, body, { sha256 = '', size = 0, contentType = '', cacheControl = '' } = {}) {
    if (!sha256) throw new Error('S3Bucket.put: hace falta el sha256 del contenido')
    /** @type {Record<string,string>} */
    const headers = {}
    if (contentType) headers['content-type'] = contentType
    if (cacheControl) headers['cache-control'] = cacheControl
    const res = await this.request('PUT', key, { headers, body, payloadHash: sha256, contentLength: size })
    if (!res.ok) {
      const { code, message } = parseError(await res.text())
      throw new S3Error(res.status, code, message, key)
    }
    return { etag: res.headers.get('etag') }
  }

  /**
   * Descarga un objeto. `range` es `{ start, end }` inclusivo, igual que en el
   * BlobStore, para que el 206 de la API local siga funcionando igual.
   * @returns {Promise<{ body: ReadableStream, size: number|null, contentType: string|null }>}
   */
  async get (key, range = null) {
    const headers = range ? { range: `bytes=${range.start}-${range.end}` } : {}
    const res = await this.request('GET', key, { headers })
    if (!res.ok) {
      const { code, message } = parseError(await res.text())
      throw new S3Error(res.status, code, message, key)
    }
    const len = res.headers.get('content-length')
    return { body: res.body, size: len == null ? null : Number(len), contentType: res.headers.get('content-type') }
  }

  /** Los primeros `n` bytes, que es lo que necesita olfatear un tipo de imagen (§7.2). */
  async head (key, n) {
    const { body } = await this.get(key, { start: 0, end: n - 1 })
    const chunks = []
    for await (const c of body) chunks.push(Buffer.from(c))
    return Buffer.concat(chunks)
  }

  /** Tamaño del objeto, o `null` si no está. No baja el cuerpo. */
  async size (key) {
    const res = await this.request('HEAD', key)
    if (res.status === 404) return null
    if (!res.ok) throw new S3Error(res.status, 'HeadFailed', res.statusText, key)
    const len = res.headers.get('content-length')
    return len == null ? null : Number(len)
  }

  /** Borra. Borrar lo que no está NO es un error (igual que `rm -f`). */
  async remove (key) {
    const res = await this.request('DELETE', key)
    if (!res.ok && res.status !== 404) {
      const { code, message } = parseError(await res.text())
      throw new S3Error(res.status, code, message, key)
    }
  }
}

export default { S3Bucket, signRequest, uriEncode, amzDate, S3Error }
