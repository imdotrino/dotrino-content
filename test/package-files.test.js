// Lo que se publica tiene que poder arrancar: cada import relativo de un archivo que entra
// en el paquete apunta a otro archivo que también entra. La 0.6.1–0.6.4 salió sin
// lib/cid.js y el node de proxy1 no arrancaba (ERR_MODULE_NOT_FOUND).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, normalize } from 'node:path'

test('every relative import of a published file is published too', () => {
  // La lista sale de `files` del package.json (lo que decide qué entra), sin llamar a npm.
  const walk = (p) => statSync(p).isDirectory() ? readdirSync(p).flatMap((n) => walk(join(p, n))) : [normalize(p)]
  const { files: listed } = JSON.parse(readFileSync('package.json', 'utf8'))
  const files = new Set(listed.flatMap(walk))
  const missing = []
  for (const f of files) {
    if (!/\.(m?js)$/.test(f)) continue
    const src = readFileSync(f, 'utf8')
    for (const m of src.matchAll(/(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
      const target = normalize(join(dirname(f), m[1]))
      if (!files.has(target)) missing.push(`${f} → ${target}`)
    }
  }
  assert.deepEqual(missing, [])
})
