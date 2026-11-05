// Tipos de @dotrino/remote-agent (no publica .d.ts) que usa el cliente de navegador (lib/).
// Solo lo que usa este repo, copiado de su JSDoc. Cuando el pilar traiga sus tipos, se borra de aquí.

declare module '@dotrino/remote-agent/client' {
  export class RemoteAgentClient {
    constructor (link: object, opts: { agentPubkey: string, proxyUrl?: string })
    on (ev: 'message', cb: (payload: any) => void): () => void
    on (ev: 'error', cb: (err: Error & { code?: string }) => void): () => void
    on (ev: 'resumed', cb: () => void): () => void
    connect (): Promise<void>
    send (payload: object): Promise<void>
    close (): Promise<void>
  }
}

declare module '@dotrino/remote-agent/discover' {
  export interface AgentMember { sub: string, label: string, cn: string | null }
  export function listAgentsByLabel (id: unknown, label?: string): Promise<AgentMember[]>
  export function probeAgents (
    client: { on: Function, sendByPubkey: Function },
    subs: string[],
    opts?: { timeoutMs?: number },
  ): Promise<Map<string, { kind: string | null }>>
}

declare module '@dotrino/remote-agent/browser-link' {
  export type BrowserLink =
    | { paired: false, id: unknown, expired?: boolean, exp?: number }
    | { paired: true, id: unknown, cert: unknown, iss: string, proxy: string, deviceId: string, scope: string[] }
  export function linkFromIdentity (id: unknown): Promise<BrowserLink>
}
