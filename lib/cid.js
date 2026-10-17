/** El `cid` de unos bytes: `sha256-<hex>`, el mismo que usa el node. */
export async function cidOf (bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return 'sha256-' + [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** ¿Estos bytes son los de `cid`? */
export async function matchesCid (bytes, cid) {
  return (await cidOf(bytes)) === cid
}
