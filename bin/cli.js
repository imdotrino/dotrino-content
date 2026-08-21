#!/usr/bin/env node
/**
 * CLI de dotrino-content.
 *
 *   dotrino-content enroll <código>     enlaza este node a tu vault (una vez)
 *   dotrino-content start [--port 3777] [--dir <ruta>] [--max-gb <n>] [--gc-min <min>]
 *                         [--no-agent]  arranca sin el plano de control
 *                         [--public]    abre el puerto de VISTAS PREVIAS (§7.2)
 *
 * El HTTP de administración sigue escuchando SOLO en loopback: es la vía local
 * para subir y leer. Lo que añade el enlace es el plano de CONTROL (administrar el
 * node desde tus apps, por el proxy, sin abrir puertos) — ver DISENO.md §7.
 *
 * `--public` levanta un SEGUNDO servidor, aparte y con sus propias reglas
 * (src/public.js): sirve las **vistas previas** de lo que marcaste público —solo
 * imágenes comprobadas, con tope de tamaño, límite por IP y techo de salida— para
 * que un enlace compartido tenga tarjeta en las redes. No es un CDN y no lo va a
 * ser: el contenido se sigue abriendo en la app.
 *
 * Env: DOTRINO_CONTENT_DIR (datos), DOTRINO_CONTENT_LINK_DIR (enlace), PORT.
 */
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { ContentNode } from '../src/node.js'
import { createServer } from '../src/server.js'
import { createPublicServer, DEFAULT_PUBLIC_PORT, DEFAULT_MAX_BYTES, DEFAULT_RATE_PER_MIN } from '../src/public.js'
import { isLinked, linkDir, startContentAgent } from '../src/agent.js'

const USAGE = `uso:
  dotrino-content enroll <código>
  dotrino-content start [--port 3777] [--dir <ruta>] [--max-gb <n>] [--max-blob-mb <n>] [--gc-min <min>] [--no-agent]
                        [--public] [--public-port 3778] [--public-host 0.0.0.0] [--public-max-kb 512]
                        [--public-rate 60] [--public-egress-gb <n>] [--public-url https://…] [--app-url https://…]
                        [--public-index]`

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    port: { type: 'string' },
    dir: { type: 'string' },
    'max-gb': { type: 'string' },
    'max-blob-mb': { type: 'string' },
    'gc-min': { type: 'string' },
    'no-agent': { type: 'boolean' },
    // --- modo público (§7.2): apagado por defecto, y cada límite es un flag ---
    public: { type: 'boolean' },
    'public-port': { type: 'string' },
    'public-host': { type: 'string' },
    'public-max-kb': { type: 'string' },
    'public-rate': { type: 'string' },
    'public-egress-gb': { type: 'string' },
    'public-url': { type: 'string' },
    'app-url': { type: 'string' },
    'public-index': { type: 'boolean' }
  }
})

const cmd = positionals[0] || 'start'
if (cmd !== 'start' && cmd !== 'enroll') {
  console.error(`comando desconocido: ${cmd}\n${USAGE}`)
  process.exit(1)
}

/**
 * Enrolamiento: el flujo endurecido del ecosistema, tal cual lo hace la terminal.
 * Este node genera su llave, MUESTRA un código y espera a que lo apruebes tipeando
 * ese código en tu bóveda — así aprobar exige tener delante esta máquina. La clave
 * maestra nunca llega aquí: solo un certificado con fecha de caducidad.
 */
if (cmd === 'enroll') {
  const pairing = positionals[1]
  if (!pairing) {
    console.error('falta el código de emparejamiento.\n' +
      'Sácalo de tu bóveda (dotrino-vault pair, o profile.dotrino.com/#myvault) y pásalo aquí:\n' +
      '  dotrino-content enroll <código>')
    process.exit(1)
  }
  // Se enrola como SERVICIO (`ns:content`), que es lo que le da además la llave de
  // CIFRADO a la que el vault le sella sus variables. El enlace del plano de control
  // queda escrito con la MISMA llave: un aparato, una identidad (ver `vaultEnv.js`).
  const { enrollToVault, serviceDir, NS } = await import('../src/vaultEnv.js')
  try {
    const res = await enrollToVault(pairing, {
      onReplace: (prev) => {
        console.log(`\n⚠ este node YA estaba enrolado (aparato ${prev.deviceId}).`)
        console.log('  Se descarta esa identidad; con ella se va su cajón de variables,')
        console.log('  que va indexado por su llave. Si solo querías recargar la')
        console.log('  configuración, NO enroles: reinicia el node.\n')
      },
      onCode: ({ deviceId, code }) => {
        console.log(`\n  este node es el aparato ${deviceId}`)
        console.log(`  apruébalo en tu bóveda:  dotrino-vault approve ${code}\n`)
        console.log('  (el código NO viaja por la red: lo tipeas tú)')
      }
    })
    const days = Math.round((res.cert.exp - Date.now()) / 86400000)
    console.log(`\nlisto: node enlazado. Certificado válido ${days} días (se renueva solo).`)
    console.log(`identidad en ${serviceDir()}  ·  enlace en ${linkDir()}`)
    console.log(`\nahora carga su configuración en la bóveda (namespace «${NS}»):`)
    console.log('  dotrino-vault secret set content CONTENT_STORAGE=local --public')
  } catch (e) {
    console.error(`\nno se pudo enlazar: ${e.message}`)
    process.exit(1)
  }
  process.exit(0)
}

const dir = values.dir || process.env.DOTRINO_CONTENT_DIR ||
  path.join(os.homedir(), '.dotrino-content')
const port = Number(values.port || process.env.PORT || 3777)
const maxBytes = values['max-gb'] ? Number(values['max-gb']) * 1024 ** 3 : 0
const maxBlobBytes = values['max-blob-mb'] ? Number(values['max-blob-mb']) * 1024 ** 2 : 0
const gcMin = Number(values['gc-min'] || 60)

// La configuración la sirve el vault (§15.14). Se pide ANTES de levantar nada: de
// ahí sale `CONTENT_STORAGE` y, con él, qué almacén usa este node. Sin vault esto no
// hace nada y el node corre en local, que es el modo normal de un autohospedado.
const { startVaultConfig, isEnrolled } = await import('../src/vaultEnv.js')
const vaultConfig = startVaultConfig({
  log: (m) => console.log(m)
})
if (!isEnrolled()) console.log('sin vault: configuración local (enrola con: dotrino-content enroll <código>)')

const node = await new ContentNode({ dir, maxBytes, maxBlobBytes }).init()
const server = createServer(node)

// GC periódico de vencidos (ttl); el GC por cuota corre inline en cada put.
const gcTimer = setInterval(() => node.gc(), gcMin * 60_000)
gcTimer.unref()
node.gc()

// Escuchar SOLO en loopback. La exposición al mundo es la Fase 3 (§7.2) y va con su
// propia ACL, su límite por IP y su techo de salida: no se activa por descuido.
server.listen(port, '127.0.0.1', () => {
  const s = node.stats()
  console.log(`dotrino-content en http://127.0.0.1:${port}  ·  datos: ${dir}`)
  console.log(`blobs: ${s.blobs}  ·  bytes: ${s.bytes}${maxBytes ? ` / ${maxBytes}` : ''}`)
})

// Plano de control: solo si este node ya está enlazado a un vault. Sin enlace sigue
// siendo lo de antes (un node local), y se dice en voz alta para que nadie crea que
// tiene administración remota cuando no la tiene.
let agent = null
if (values['no-agent']) {
  console.log('plano de control: apagado (--no-agent)')
} else if (isLinked()) {
  try {
    agent = await startContentAgent({ node })
  } catch (e) {
    console.error(`plano de control: no arrancó (${e.message})`)
  }
} else {
  console.log('plano de control: sin enlace (corre `dotrino-content enroll <código>` para administrarlo desde tus apps)')
}

// Modo público (§7.2). Va DESPUÉS del agente a propósito: el `owner` del node lo
// resuelve el enlace con el vault, y es la mitad izquierda de la referencia
// `ownerId + cid` que la tarjeta necesita para armar el enlace "Abrir".
let publicServer = null
if (values.public) {
  const maxKb = values['public-max-kb'] !== undefined ? Number(values['public-max-kb']) : DEFAULT_MAX_BYTES / 1024
  const publicPort = Number(values['public-port'] || DEFAULT_PUBLIC_PORT)
  const publicHost = values['public-host'] || '0.0.0.0'
  const egressGb = Number(values['public-egress-gb'] || 0)
  publicServer = createPublicServer(node, {
    maxBytes: maxKb * 1024,
    ratePerMin: Number(values['public-rate'] || DEFAULT_RATE_PER_MIN),
    maxEgressBytes: egressGb ? egressGb * 1024 ** 3 : 0,
    publicUrl: values['public-url'] || null,
    appUrl: values['app-url'] || undefined,
    index: !!values['public-index'],
    owner: node.owner
  })
  publicServer.listen(publicPort, publicHost, () => {
    console.log(`vistas previas públicas en http://${publicHost}:${publicPort}  ·  solo imágenes` +
      `${maxKb ? ` de hasta ${maxKb} KB` : ' (SIN tope de tamaño)'}` +
      `${egressGb ? `  ·  techo de salida ${egressGb} GB/día` : ''}`)
    if (!node.owner) {
      console.log('  ojo: este node no está enlazado a un vault, así que las tarjetas salen sin enlace "Abrir"')
    }
    if (!maxKb) {
      console.log('  ojo: sin tope de tamaño esto sirve originales, no vistas previas — y el ancho de banda lo pagas tú')
    }
  })
}

const shutdown = () => {
  clearInterval(gcTimer)
  try { agent?.close() } catch (_) {}
  try { publicServer?.close() } catch (_) {}
  server.close(() => { node.close(); process.exit(0) })
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
