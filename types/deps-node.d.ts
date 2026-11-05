// Tipos de los pilares que usa la parte de Node y no publican .d.ts (@dotrino/remote-agent,
// @dotrino/vault, @dotrino/update y dos subrutas de @dotrino/identity). Solo lo que usa este
// repo, copiado de su JSDoc. Cuando el pilar traiga sus tipos, se borra de aquí.

/** El enlace de un aparato con su bóveda, como lo guarda @dotrino/remote-agent. */
interface DotrinoDeviceLink {
  device: { publickey: string, privateJwk: import('node:crypto').JsonWebKey, publicJwk?: import('node:crypto').JsonWebKey }
  cert: object
  iss: string
  proxy?: string
  label?: string
  at?: number
  acta?: { keyring?: object[], [k: string]: unknown }
  [k: string]: unknown
}

declare module '@dotrino/remote-agent/link' {
  export function dataDir (name?: string): string
  /** null si no existe; lanza `link-unreadable` si existe y no se puede leer. */
  export function loadLink (dir?: string): DotrinoDeviceLink | null
  export function saveLink (dir: string, link: object): void
}

declare module '@dotrino/remote-agent/agent' {
  /** Una sesión cifrada con un cliente autorizado. */
  export interface AgentSession {
    sid: string
    /** El token del cliente en el proxio. */
    from: string
    /** La pubkey del aparato cliente. */
    device: string
    on (ev: 'message', cb: (payload: any) => void): void
    on (ev: string, cb: (...args: any[]) => void): void
    send (payload: object): Promise<void>
    /** ¿Va por un canal directo (WebRTC) ahora mismo? */
    direct (): boolean
  }
  export interface RemoteAgent {
    machine: string
    machineId: string
    master: string
    /** El transporte ya conectado e identificado (se reusa, nunca se abre otro). */
    client: import('@dotrino/proxy-client').WebSocketProxyClient & { routeTo?: (token: string) => Promise<string> }
    close (): void
    [k: string]: unknown
  }
  export function startRemoteAgent (opts?: {
    dir?: string
    proxyUrl?: string
    client?: object
    quiet?: boolean
    onRevoked?: () => void
    label?: string
    onSession?: (session: AgentSession) => void
    product?: string
    version?: string
    needs?: string[]
  }): Promise<RemoteAgent>
}

declare module '@dotrino/identity/capabilities' {
  /** La huella (id largo) de una pubkey. */
  export function pubkeyId (publicJwkStr: string): Promise<string>
}

declare module '@dotrino/identity/content' {
  /** Abre un sobre con el llavero de la cuenta y la llave de cifrado de este aparato. */
  export function decryptWithKeyring (o: {
    envelope: object
    keyring: object[]
    myPub: string
    myEncPrivateKey: import('node:crypto').webcrypto.CryptoKey
  }): Promise<string>
}

declare module '@dotrino/vault/service' {
  /** La identidad persistida de un servicio, o null. */
  export function readServiceIdentity (dir: string): {
    device: { publickey: string, privateJwk: import('node:crypto').JsonWebKey }
    cert: object
    iss: string
    proxy?: string
    ns?: string
    enc?: { privateJwk?: import('node:crypto').JsonWebKey, [k: string]: unknown }
    [k: string]: unknown
  } | null
  export function enrollService (opts: {
    qr: object | string
    ns: string
    dir: string
    label?: string
    onCode?: (c: { deviceId: string, code: string }) => void
    onReplace?: (prev: { ns: string, enrolledAt: number, deviceId: string }) => void
    approveTimeoutMs?: number
  }): Promise<{ device: object, cert: object, iss: string, replaced: object | null }>
  export function waitForSecrets (opts: {
    dir?: string
    ns?: string
    onRetry?: (e: Error, delayMs: number) => void
    [k: string]: unknown
  }): Promise<Record<string, string>>
  export interface UpdateHooks {
    mayUpdate: (u: { version: string, from?: string }) => Promise<boolean>
    onUpdated: (u: { version: string, from?: string }) => Promise<void>
    onNeedsRoot: (u: { version: string, from?: string }) => Promise<void>
  }
  export function vaultUpdateHooks (o: {
    product: string
    log?: (m: string) => void
    dir?: string
    proxyUrl?: string
    masterPubkey?: string
    device?: object
    cert?: object
  }): UpdateHooks
}

declare module '@dotrino/vault/env' {
  export function applyEnv (secrets: Record<string, string>, override?: boolean): { injected: string[], overridden: string[], skipped: string[] }
  export function watchEnv (opts?: {
    ns?: string
    dir?: string
    onUpdate?: (info: { ns: string, ts: number, reason: 'changed' | 'revoked', via?: 'notice' | 'reconcile' }) => void
    exitCode?: number
    quiet?: boolean
  }): Promise<{ stop: () => void, reconcile: () => Promise<boolean> }>
}

declare module '@dotrino/vault/device-info' {
  export interface DeviceInfo { id: string, [k: string]: unknown }
  export function deviceInfo (link: { device?: { publickey?: string }, cert?: object, iss?: string, proxy?: string }, extra?: Record<string, unknown>): Promise<DeviceInfo>
  export function formatDeviceInfo (info: DeviceInfo): string
}

declare module '@dotrino/update/npm' {
  export function watchSelfUpdateNpm (o: {
    pkg: string
    current: string
    repo?: string
    dir?: string
    mayUpdate?: (u: { version: string, from?: string }) => Promise<boolean>
    onUpdated?: (u: { version: string, from?: string }) => Promise<void>
    onNeedsRoot?: (u: { version: string, from?: string }) => Promise<void>
    onInstalled?: (r: { version: string, restart: boolean }) => void
    log?: (m: string) => void
  }): () => void
  export function updatePrefsCommand (args?: string[], opts?: { dir?: string, lang?: string }): {
    handled: boolean
    ok: boolean
    text: string
    prefs?: { approval: boolean, notify: boolean }
  }
  export function updateStatusText (o: { dir?: string, current: string, lang?: string, now?: () => number }): string
}
