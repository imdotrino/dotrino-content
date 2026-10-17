/** Parsea `Range: bytes=a-b|a-|-n` contra `size`. null = sin rango; false = inválido. */
export function parseRange (header, size) {
  if (!header) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim())
  if (!m || (m[1] === '' && m[2] === '')) return false
  let start, end
  if (m[1] === '') { // sufijo: últimos n bytes
    const n = Number(m[2])
    if (n === 0) return false
    start = Math.max(0, size - n)
    end = size - 1
  } else {
    start = Number(m[1])
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1)
  }
  if (start >= size || start > end) return false
  return { start, end }
}
