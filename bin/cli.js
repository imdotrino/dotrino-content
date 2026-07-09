#!/usr/bin/env node
/**
 * CLI de dotrino-content (Fase 1: core local, SOLO localhost).
 *
 *   dotrino-content start [--port 3777] [--dir <ruta>] [--max-gb <n>] [--gc-min <min>]
 *
 * Env: DOTRINO_CONTENT_DIR, PORT.
 */
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { ContentNode } from '../src/node.js'
import { createServer } from '../src/server.js'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    port: { type: 'string' },
    dir: { type: 'string' },
    'max-gb': { type: 'string' },
    'max-blob-mb': { type: 'string' },
    'gc-min': { type: 'string' }
  }
})

const cmd = positionals[0] || 'start'
if (cmd !== 'start') {
  console.error(`comando desconocido: ${cmd}\nuso: dotrino-content start [--port 3777] [--dir <ruta>] [--max-gb <n>]`)
  process.exit(1)
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

// Fase 1: escuchar SOLO en loopback (sin auth todavía).
server.listen(port, '127.0.0.1', () => {
  const s = node.stats()
  console.log(`dotrino-content en http://127.0.0.1:${port}  ·  datos: ${dir}`)
  console.log(`blobs: ${s.blobs}  ·  bytes: ${s.bytes}${maxBytes ? ` / ${maxBytes}` : ''}`)
})

const shutdown = () => {
  clearInterval(gcTimer)
  server.close(() => { node.close(); process.exit(0) })
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
