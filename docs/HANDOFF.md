# Handoff — `dotrino-content` (pasar a otra sesión)

> **Propósito de este archivo:** que una sesión nueva (sin contexto de la charla)
> pueda continuar el diseño/implementación de `dotrino-content`. El diseño
> completo está en **[`DISENO.md`](./DISENO.md)** (léelo entero antes de codear).
> Este handoff resume estado, decisiones cerradas, lo abierto y el siguiente paso.

## Qué es

`dotrino-content` = pilar del ecosistema **Dotrino** para **hospedar y compartir
media pesada** (video/imagen/audio) con enlaces compartibles, **autohospedado por el
usuario**. Complementa al `@dotrino/store` (índice chico) y al `vault` (identidad);
no los reemplaza.

**Estado: Fases 1 y 2 implementadas** (core local + aparato del vault con plano de
control cifrado) y **sin decisiones abiertas**. Siguiente = Fase 3. Detalle abajo.

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
  **Resuelto: se consume `@dotrino/remote-agent`**, que ya trae todo eso (enroll,
  identify, canal cifrado, revocación y renovación del cert). La propuesta vieja de
  extraer un `@dotrino/enroll` está **obsoleta** — ver `DISENO.md` §5.2.
- **Direccionado por contenido:** referencia compartible = **`ownerId + cid`**
  (`cid` = hash tipo BLAKE3/SHA-256; `ownerId` = pubkeyId de la maestra). El
  `ownerId` es indispensable para **rutear** (`ownerId` → nodes del dueño; cómo se
  resuelve, en `DISENO.md` §3.1) y para **verificar autenticidad** (el node firma con
  `D`, cadena `D ← ownerId`).
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

## El sí/no que estaba abierto: CERRADO (2026-08-17)

Era: *¿el tier standalone debe servir además por URL HTTP "normal", o basta con que
se vea desde apps Dotrino (WebRTC/swarm)?* **Respuesta del dueño: basta
WebRTC/swarm** — con un matiz que sí se implementa. Detalle completo en
`DISENO.md` §7; en corto:

- **El enlace compartible es una URL de app con la referencia (`ownerId + cid` +
  llave si va cifrado) en el `#fragment`**, y **la app que sabe consumirlo es eco**
  (o cualquier otra del ecosistema). El servidor nunca ve la referencia.
- **El standalone es un sembrador headless 24/7**: sin puertos publicados, sin
  transporte nuevo. **Descartados** el túnel de streaming (A) y el bucket cifrado
  (D). El visitante abre eco, una PWA, y **su navegador es el cliente**.
- **El enlace no muere con el beacon de eco:** las 24 h son descubrimiento geo; el
  fragmento se resuelve mientras un node siembre ese `cid`.
- **El proxy no transporta contenido** (verificado en `server.js`): 24 h de TTL,
  200 msgs / **1 MB por pubkey**, 64 MB global, frame `maxPayload` 1 MB y
  **single-drain**. Es plano de control. La disponibilidad la sostiene el sembrador.
- **Matiz que sí va (Fase 3): modo público HTTP opt-in del PROPIO node**
  (`--public`, apagado por defecto), nunca una pieza que re-sirva desde infra de
  Dotrino (sería CDN/relay gratis, regla dura 3). Requiere la ACL de la Fase 2 +
  rate-limit por IP + techo de egress.
- **Sin vista previa social**, y aceptado por el dueño: un `#fragment` hacia una app
  estática no da tarjeta en X/LinkedIn. Solo el contenido público de la cuenta
  oficial puede tenerla, con una envoltura HTML por pieza (`/p/<cid>`) servida por
  el node de Dotrino — **eso es un permalink y se parecerá a un blog**; se dice así.
- **Quién sostiene qué:** el dueño hospeda el contenido **de Dotrino**; quien quiera
  otro content node sostiene el suyo. No se promete disponibilidad a terceros.

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
- **Repo + landing publicados (2026-07-09):** repo `imdotrino/dotrino-content`
  (push por alias SSH `dotrino`), landing estática §1.2 en `web/` desplegada por
  Actions a **`content.dotrino.com`** (Pages `build_type=workflow`, cname fijado
  al final; sirve 200 con SEO/OG/GoatCounter/bilingüe/support). App registrada
  en el catálogo de `dotrino-home` (`cat: 'developers'`, `wip: true`).

## Fase 2: HECHA (2026-08-17) — siguiente paso = Fase 3

**El node ya es un aparato del vault.** `dotrino-content enroll <código>` lo enlaza
y, con el enlace puesto, `start` levanta además el **plano de control** por el proxy.

- **No se escribió middleware: se consume `@dotrino/remote-agent`** (el que ya usan
  terminal e ia). Ahí viven el emparejamiento endurecido, el `identify` firmado, el
  canal cifrado por sesión, el refresco de revocados, la **renovación del cert** y el
  auto-borrado ante un `vault.revoked` firmado. La propuesta vieja de "extraer
  `@dotrino/enroll`" queda **obsoleta**: la pieza ya existía (ver `DISENO.md` §5.2).
- **Propio de este repo:** `src/agent.js` (pegamento) y `src/ops.js` (las
  operaciones: `hello`, `list`, `stat`, `stats`, `pin`, `unpin`, `remove`, `acl`,
  `gc`). Contrato de errores por **`code`**, no por la frase.
- **`owner` + `acl`:** el node estampa el `ownerId` (huella de la maestra) en lo que
  se sube — la mitad izquierda de `ownerId + cid` — y guarda el `acl`; **público es
  opt-in** y un blob cifrado no puede marcarse público. Eso es lo que la Fase 3 mira
  antes de servir algo por HTTP.
- **Sin `put` por el plano de control, a propósito:** los bytes no van por el proxy
  (§7.1) — subir es local, y P2P desde la Fase 3.
- **Corrección de diseño:** los caps `content:write`/`content:admin` **no existen** en
  el vault; se autoriza con `vault:sign`, que es lo que el vault emite a cada aparato
  del acta. Permisos por app serían un cambio en el vault, no aquí.
- **Pruebas:** 19 en total (7 de la Fase 1 + 12 nuevas), incluido un **extremo a
  extremo** con llaves, certificados, `verifyChain` y sobres AES-GCM de verdad sobre
  un bus en memoria: un aparato de la misma maestra administra, uno de otra maestra
  no abre sesión y un cert vencido tampoco.
- **De paso, arreglado en el pilar:** `@dotrino/remote-agent@0.3.1` — `vaultRpc` no
  cancelaba su temporizador de 15 s y dejaba el bucle de eventos retenido tras cada
  consulta al vault (invisible en un demonio, fatal en un proceso corto).

**Siguiente: Fase 3 — exposición, y empieza por el ANUNCIO** (`DISENO.md` §3.1, nuevo):
sin resolución `ownerId → nodes` no hay a quién pedirle los bytes. Orden: (1) el node se
publica en `<nodeId>/content_<ownerId>` —con prefijo de nodo, que hay dos proxios
federados y un canal sin prefijo es local a cada uno— y para el dueño se cablea
`listAgentsByLabel(id, 'content')` + `stat <cid>`, que ya existen; (2) P2P/swarm por
WebRTC (§13) + `@dotrino/content-client`; (3) **modo público HTTP opt-in** del node
(§7.2: el ACL ya está, faltan bind, límite por IP y techo de egress) y el sembrador
24/7 de la cuenta oficial. Luego Fase 4 = integración con **eco** (la app que resuelve
el `#fragment`) + catálogo. (Fases completas en `DISENO.md` §11.)

**Y dentro de la Fase 3, entre el transporte y el modo público: el sembrador se
alimenta de los otros nodes** (`DISENO.md` §13.1, decidido el 2026-08-17 — sale de los
diferidos, donde estaba como «sync/replicación»). El objetivo es que lo compartible
siga disponible aunque solo quede encendido el sembrador. **No es un subsistema nuevo:
es el sembrador comportándose como un consumidor más del enjambre** — se entera por el
plano de control (ya hecho), pide los `cid` por WebRTC como cualquier peer y los
verifica contra el hash. Por defecto se replica lo **público y lo pineado**, no todo; lo
privado viaja y se guarda **cifrado**, así que el nodo siempre encendido puede sostener
tu contenido sin poder leerlo; y lo replicado compite por la cuota como cualquier blob
(un sembrador lleno avisa, no borra en silencio).

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

Diseño **cerrado y coherente** con las 3 reglas duras, **y ya sin decisiones
abiertas**: el sí/no del HTTP se cerró el 2026-08-17 (ver la sección de arriba) y el
repo está creado, pusheado y con la landing en vivo. **Fase 1 implementada y
testeada (2026-07-09).** Lo que falta es ejecución: **Fase 2 (enrolamiento por vault
+ ACL, extrayendo `@dotrino/enroll`)** y luego Fase 3.
