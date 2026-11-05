/**
 * DE QUIÉN ES LA RED. Regla del dueño (2026-11-01): la red de Dotrino (su proxio y su TURN) es
 * para el contenido de Dotrino. Los bytes de un usuario solo la cruzan si son suyos: por WebRTC
 * directo no pasan por nadie, y por TURN o proxio solo si la cuenta usa los suyos. El TURN lo
 * administra el proxio con el que se está conectado, así que mirar el proxio lo dice todo.
 *
 * Los mensajes pequeños del plano de control no entran aquí: la red existe para ellos.
 */
/** @param {string} proxyUrl */
export function isDotrinoNetwork (proxyUrl) {
  const host = new URL(proxyUrl).hostname.toLowerCase()
  return host === 'dotrino.com' || host.endsWith('.dotrino.com')
}

/**
 * ¿Pueden ir bytes por este camino?
 * @param {string|null} route  `direct`, `turn`, `proxy`, `webrtc` (abierto, sin saber cuál)…
 * @param {string} proxyUrl
 * @returns {'yes'|'ask'|'no'}  `yes`, directo · `ask`, red propia: decide el dueño · `no`
 */
export function bytesAllowed (route, proxyUrl) {
  if (route === 'direct') return 'yes'
  return isDotrinoNetwork(proxyUrl) ? 'no' : 'ask'
}

export default { isDotrinoNetwork, bytesAllowed }
