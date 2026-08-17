#!/usr/bin/env node
/**
 * CLI de dotrino-content.
 *
 *   dotrino-content enroll <código>     enlaza este node a tu vault (una vez)
 *   dotrino-content start [--port 3777] [--dir <ruta>] [--max-gb <n>] [--gc-min <min>]
 *                         [--no-agent]  arranca sin el plano de control
 *
 * El HTTP sigue escuchando SOLO en loopback: es la vía local para subir y leer. Lo
 * que añade el enlace es el plano de CONTROL (administrar el node desde tus apps,
 * por el proxy, sin abrir puertos) — ver DISENO.md §7 y src/agent.js.
 *
 * Env: DOTRINO_CONTENT_DIR (datos), DOTRINO_CONTENT_LINK_DIR (enlace), PORT.
 */
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { ContentNode } from '../src/node.js'
import { createServer } from '../src/server.js'
import { isLinked, linkDir, startContentAgent } from '../src/agent.js'

const USAGE = `uso:
  dotrino-content enroll <código>
  dotrino-content start [--port 3777] [--dir <ruta>] [--max-gb <n>] [--max-blob-mb <n>] [--gc-min <min>] [--no-agent]`

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    port: { type: 'string' },
    dir: { type: 'string' },
    'max-gb': { type: 'string' },
    'max-blob-mb': { type: 'string' },
    'gc-min': { type: 'string' },
    'no-agent': { type: 'boolean' }
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
  const { enroll, parseQr } = await import('@dotrino/remote-agent/link')
  const dir = linkDir()
  try {
    const link = await enroll({
      qr: parseQr(pairing),
      label: 'content',
      dir,
      onChallenge: ({ deviceId, code }) => {
        console.log(`\n  este node es el aparato ${deviceId}`)
        console.log(`  código para aprobar en tu bóveda:  ${code}\n`)
        console.log('  (apruébalo ahí; este código NO viaja por la red)')
      }
    })
    const days = Math.round((link.cert.exp - Date.now()) / 86400000)
    console.log(`\nlisto: node enlazado. Certificado válido ${days} días (se renueva solo).`)
    console.log(`enlace guardado en ${dir}`)
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

const shutdown = () => {
  clearInterval(gcTimer)
  try { agent?.close() } catch (_) {}
  server.close(() => { node.close(); process.exit(0) })
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
