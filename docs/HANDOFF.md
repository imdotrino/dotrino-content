# Handoff — `dotrino-content` (pasar a otra sesión)

> **Propósito de este archivo:** que una sesión nueva (sin contexto de la charla)
> pueda continuar el diseño/implementación de `dotrino-content`. El diseño
> completo está en **[`DISENO.md`](./DISENO.md)** (léelo entero antes de codear).
> Este handoff resume estado, decisiones cerradas, lo abierto y el siguiente paso.

## Qué es

`dotrino-content` = pilar propuesto del ecosistema **Dotrino** para **hospedar y
compartir media pesada** (video/imagen/audio) con enlaces compartibles,
**autohospedado por el usuario**. Estado: **solo diseño, nada implementado.**
Complementa al `@dotrino/store` (índice chico) y al `vault` (identidad); no los
reemplaza.

**Reglas duras del dueño (no negociables):**
1. El contenido **siempre del lado del usuario, NUNCA en un server de Dotrino**.
2. Si hay **costo de transferencia, lo paga el usuario** (no Dotrino).
3. **Anti-abuso**: nada que permita usar la infra de Dotrino como CDN/relay gratis.

## Decisiones YA cerradas (no re-litigar)

- **El "node" es un ROL, no una máquina.** Dos tiers bajo **una misma identidad**:
  - **Tier PWA (default, cero instalación):** la app en el navegador **es** el node
    (identidad + contenido local en OPFS/IndexedDB + P2P por WebRTC mientras está
    abierta).
  - **Tier standalone (opcional, enrolado):** daemon headless (Docker/`npx`) en
    VPS/NAS, 24/7. Se **enrola al mismo vault** (cert delegado).
- **Identidad = agente enrolado al vault IGUAL que `dotrino-terminal`.** El node
  porta **llave de dispositivo `D` + cert** (`D ← maestra`); la **maestra se queda
  en el vault**. Flujo: `dotrino-vault pair` → `dotrino-content enroll`. Verificación
  con `@dotrino/identity` `verifyChain`. Revocación: `dotrino-vault revoke <deviceId>`.
  Propuesta: extraer un `@dotrino/enroll` compartido (terminal/content/otros).
- **Direccionado por contenido:** referencia compartible = **`ownerId + cid`**
  (`cid` = hash tipo BLAKE3/SHA-256; `ownerId` = pubkeyId de la maestra). El
  `ownerId` es indispensable para **rutear** (ownerId → endpoint del node) y para
  **verificar autenticidad** (el node firma con `D`, cadena `D ← ownerId`).
- **Cifrado E2E por defecto** (server/relay solo ven ciphertext; la llave viaja en
  `#fragment`), **público opt-in**.
- **Dos planos:** control por el **proxy** (`@dotrino/proxy-client`, `identify`
  firmado) como la terminal; **datos/media aparte** (no cabe en el proxy).
- **Transporte de datos por defecto = P2P WebRTC + swarm (tipo WebTorrent):** bytes
  device↔device, Dotrino solo señalización/tracker (kilobytes, sin egress). Volumen
  → los que reciben re-siembran (costo distribuido entre consumidores). `cid` =
  infohash; chunks verificables.
- **TURN (relay, solo si NAT lo obliga ~10-20%) = BYO del emisor, lo paga él**,
  credenciales **efímeras** gated por cap. Dotrino **no** pone TURN abierto.
- **Cuenta oficial de Dotrino = un tercero más (dogfooding):** mismo stack
  (vault+content+TURN), sin backend privilegiado; es la referencia viva y seeder de
  lo público de Dotrino con su propio BW. **El TURN oficial lo paga Dotrino pero es
  SOLO para el contenido de Dotrino** (no relay gratis para terceros). "Dotrino paga
  SU transferencia, no la tuya."
- **Despliegue:** Docker compose (recomendado server/NAS) / `npx` / Tauri.
  Con el túnel, el tier standalone no publica puertos (ingreso por el túnel);
  **excepción coturn** (TURN necesita rango UDP → `network_mode: host`).

## Lo ÚNICO abierto (y NO bloquea empezar)

Un **sí/no**: **¿el tier standalone debe servir además por URL HTTP "normal"**
(para que un `<video src>` en cualquier navegador ajeno, sin el cliente Dotrino, lo
abra / hotlink)**, o basta con que se vea desde apps Dotrino (WebRTC/swarm)?**
- **Basta WebRTC/swarm** → el standalone es solo un **seeder headless 24/7** (sin
  puertos, sin transporte nuevo). Nada que decidir.
- **Quiero URL HTTP** → hay que elegir cómo se expone: (A) túnel de **streaming**
  dedicado —el túnel actual `r.dotrino.com` es 1 MB/30 s, NO sirve para video—, (C)
  puerto/dominio propio del usuario, o (A+D) con fallback a **bucket cifrado opt-in**.

Notas: el `@dotrino/tunnel` actual (payload **1 MB**, timeout **30 s**) **no
streamea video**. Ver `CLAUDE.md`.

## Fase 1: HECHA (2026-07-09) — siguiente paso = Fase 2

**El core local está implementado y testeado** (7 tests `node:test`, todos verdes,
más smoke test manual con `curl`):

- `src/blobstore.js` — blobs por **`cid`** en disco (`blobs/<aa>/<bb>/<cid>`,
  sharding), escritura streaming con hash al vuelo, dedup, tmp+rename atómico.
- `src/db.js` — índice **`node:sqlite`** (`index.db`, WAL): `cid,size,mime,
  createdAt,owner,enc,acl,ttl,pinned,thumbnailCid`.
- `src/node.js` — `ContentNode`: put con cuota (`ENOSPC` si ni el GC libera),
  pin/unpin, GC (vencidos por ttl + desalojo de no-pineados más viejos; los
  pineados jamás se borran).
- `src/server.js` — HTTP **solo `127.0.0.1`**, sin auth: `POST /c` (streaming,
  `?ttl=&enc=1`), `GET/HEAD /c/<cid>` con **`Range`/206**, `ETag=cid` +
  `immutable` + 304, `DELETE`, `/list`, `/pin|/unpin/<cid>`, `/stats`.
- `bin/cli.js` — `dotrino-content start [--port 3777] [--dir] [--max-gb]
  [--max-blob-mb] [--gc-min]`; GC periódico.
- **Cero dependencias** (Node ≥ 22.5). Decisiones tomadas: hash **SHA-256**
  (`sha256-<hex>`; BLAKE3 requeriría módulo nativo y el `.npmrc` bloquea build
  scripts — el prefijo de algoritmo deja la puerta abierta), índice **SQLite**
  (no el store; el store queda para el índice sincronizable en fases futuras).
- Pendiente de Fase 1: crear el repo `imdotrino/dotrino-content` y push (no
  hecho aún; el directorio no es repo git).

**Siguiente: Fase 2 — auth por vault:** enrolamiento tipo `dotrino-terminal`
(pair → device cert → `verifyChain` → revoke; ver `dotrino-terminal/agent/`),
caps `content:write`/`content:admin`, y valorar extraer el **`@dotrino/enroll`**
compartido. Luego Fase 3 = exposición (P2P/swarm + tier standalone según el
sí/no); Fase 4 = integración app piloto + landing `content.dotrino.com` +
catálogo. (Fases completas en `DISENO.md` §11.)

## Piezas del ecosistema a REUSAR (no reimplementar)

- **`@dotrino/proxy-client`** (`dotrino-proxy-client/`) — WebRTC + señalización por
  `proxy.dotrino.com`; hoy STUN-only con `iceServers` override opcional. Base del
  P2P/swarm y del plano de control.
- **`dotrino-qrshare/`** — precedente de transferencia P2P por WebRTC (patrón a mirar).
- **`dotrino-terminal/`** (`agent/`) — patrón de **enrolamiento** al vault (pair →
  device cert → `verifyChain` → revoke). El content node lo copia.
- **`@dotrino/identity`** (`dotrino-identity/vault/capabilities.js`) —
  `verifyDelegation`/`verifyChain`/`pubkeyId`. Igual que el bridge `/here` del geo.
- **`@dotrino/tunnel`** (`r.dotrino.com`) — túnel reverso (para el tier standalone;
  ojo con el límite 1 MB/30 s para media).
- **`@dotrino/store`** — para el índice sincronizable (metadatos chicos), no para los blobs.

## Convenciones y contexto del repo

- Raíz del ecosistema: `/mnt/sda1/Dotrino/`. Reglas: `CLAUDE.md` +
  `CONVENCIONES-APPS.md` (Vite, PWA, support `@dotrino/support`, bilingüe es/en
  tuteo neutro SIN voseo, GoatCounter, SEO de cáscara, `#fragment` para contenido).
- GitHub org **`imdotrino`**; push por alias SSH **`dotrino`**
  (`git@dotrino:imdotrino/<repo>.git`). Deploy de apps por GitHub Actions (§11.3).
- Negocio/financiación (para el tema "perk de relay compartido"): `MODELO-NEGOCIO.md`.
- Docs relacionadas: `dotrino-vault/docs/`, `dotrino-terminal/README.md`,
  `dotrino-reputation/docs/federacion-confianza.md`.

## Estado de este handoff

Diseño **cerrado y coherente** con las 3 reglas duras. **Fase 1 implementada y
testeada (2026-07-09)** — ver sección "Fase 1: HECHA". Falta: (1) el sí/no de
HTTP del tier standalone (no bloquea), (2) crear/pushear el repo, (3) Fase 2.
