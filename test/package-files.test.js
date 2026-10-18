// Lo que se publica tiene que poder arrancar: cada import relativo de un archivo que entra
// en el paquete apunta a otro archivo que también entra. La 0.6.1–0.6.4 salió sin
// lib/cid.js y el node de proxy1 no arrancaba (ERR_MODULE_NOT_FOUND).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, normalize } from 'node:path'

test('every relative import of a published file is published too', () => {
  const [pack] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { encoding: 'utf8' }))
  const files = new Set(pack.files.map((f) => normalize(f.path)))
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
