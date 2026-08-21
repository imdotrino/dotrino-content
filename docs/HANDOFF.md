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

**Estado (2026-08-21): Fases 1, 2 y la mayor parte de la 3 implementadas, y la Fase 4
arrancada — eco ya guarda en el node.** Sin decisiones abiertas.

| | Estado |
|---|---|
| Fase 1 — core local | ✅ 2026-07-09 |
| Fase 2 — aparato del vault | ✅ 2026-08-17 |
| Fase 3.1 — anuncio y resolución | ✅ 2026-08-21 |
| Fase 3.2 — transporte | **parcial**: `put`/`get` por el plano de control con tope de 256 KB, y `@dotrino/content-client` publicado. **Falta el P2P por WebRTC**, que es lo que desbloquea los archivos grandes y la lectura por terceros |
| Fase 3.3 — el sembrador se alimenta de los otros nodes | ❌ (depende del P2P) |
| Fase 3.4 — modo público | ✅ 2026-08-21, reencuadrado a **vistas previas** |
| Fase 4 — eco | **arrancada**: guarda tus ecos en tu máquina, opt-in por eco |

**LO QUE FALTA, en una línea: el transporte P2P.** Es lo único que separa el estado
actual de la promesa completa, y de ahí cuelgan las tres cosas que hoy no se pueden
hacer: que un tercero con tu enlace lea los bytes, que suban archivos grandes, y que el
sembrador replique (§13.1). **Dato comprobado el 2026-08-21:** Node **no** trae
`RTCPeerConnection`, así que el daemon necesita un módulo — y **`@roamhq/wrtc` sirve**,
porque distribuye binarios por `optionalDependencies` por plataforma (como esbuild) y
por tanto funciona con el `ignore-scripts=true` del ecosistema. Ese era el riesgo que
había que despejar antes de planificarlo.

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
- **Qué puede guardar: TODO** (2026-08-17). No es "el servidor de media pesada" —
  guarda cualquier byte del usuario, de cualquier tipo y tamaño, **incluidos los posts
  de las apps** (eco es el ejemplo trabajado en `DISENO.md` §3.2). **La frontera con
  `@dotrino/store` no es el tamaño**: al store va **lo que debe estar SIEMPRE
  disponible** (regla del dueño), porque vive en el aparato y responde offline; al
  content, los bytes, que necesitan un node sembrando. Razón estructural: el `cid` es
  el hash, así que el content guarda **versiones, no variables** — el puntero a "cuál
  es el `cid` vigente" es del store.
  **⚠️ Norma pendiente:** `CONVENCIONES-APPS.md` §4 todavía dice que *todo* el
  contenido del usuario (incluidas imágenes/blobs) va por el store. Habrá que
  actualizarla cuando el content esté disponible para las apps (Fase 3/4) — **no
  antes**, o se estaría mandando a las apps a usar algo que aún no existe.
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

## Fase 3.4: HECHA (2026-08-21) — el modo público es de VISTAS PREVIAS

`dotrino-content start --public` levanta un SEGUNDO servidor HTTP (`src/public.js`),
aparte del de loopback, para que **un enlace compartido tenga tarjeta en las redes**.
Reencuadre del dueño ese día: *"podría incluso solo ser previews para evitar tráfico y
que el contenido sea interno"* + *"podría ser exclusivo de imágenes"*. Quedó más
estrecho que lo que el diseño proponía, y mejor. Ver `DISENO.md` §7.2 y §7.3.

- **Cinco cerrojos, uno por prueba** (11 pruebas nuevas): ACL (`public` + en claro);
  **solo imágenes de mapa de bits** (SVG **fuera**: es un documento con scripts);
  **bytes mágicos** (el `mime` lo dice quien sube, así que se comprueba el archivo —
  un HTML subido como `image/png` da 404); **tope de tamaño** (`--public-max-kb`, 512
  por defecto: es lo que lo hace un servidor de miniaturas y no un CDN); **límite por
  IP + techo de egress diario persistido**, que corta *antes* de mandar una respuesta
  que no cabe.
- **Permalink `/p/<cid>`** con OG/Twitter y botón "Abrir" hacia `<app>/#<ownerId>/<cid>`
  — la referencia va en el `#fragment`, así que el servidor de la app nunca la ve. La
  `og:image` se **comprueba antes de anunciarla**.
- **La miniatura la genera la APP** al subir (canvas) y se sube como otro blob,
  enlazado con la op `thumb`. El node no decodifica imágenes: sigue sin dependencias
  nativas. Enlazar una miniatura **no** la publica.
- Ops nuevas: **`meta`** (nombre/título/descripción de presentación, recortados) y
  **`thumb`**. Índice: columna `meta`, tabla `egress` y migración `ALTER TABLE` para
  las bases ya escritas.
- `robots.txt` = `Disallow: /` por defecto (`--public-index` lo levanta, y es para la
  cuenta oficial). 404 y nunca 403 para lo privado.

## Fase 3.1: HECHA (2026-08-21) — el anuncio

`src/announce.js`. El node se publica en `<nodeId>/content_<ownerId>` y `findNodes()`
contesta qué nodes de un dueño están vivos.

- **El canal lleva el `ownerId`, no el `cid`**: uno por contenido filtraría qué guarda
  cada quien con solo listar canales, y serían miles.
- **Se publica en el canal de CADA proxio conocido y se lista en todos**, en vez de
  elegir uno por una fórmula: la lista de nodos de la malla cambia cuando entra o sale
  un proxio, y una fórmula que dependa de ella reasignaría todos los canales ese día.
  Son dos canales hoy.
- Re-publica al reconectar (el token cambia) y es best-effort: sin proxy el node sigue
  sirviendo en local y atendiendo a los aparatos del acta.
- **Anunciarse NO da acceso**: es una guía de teléfonos. Quien pregunta sigue teniendo
  que comprobar el certificado del node y el hash de los bytes.
- Para esto hizo falta que `@dotrino/remote-agent` **expusiera su cliente de proxy**
  (0.4.0, publicado): abrir una segunda conexión sería un segundo `identify`, una
  segunda identidad de transporte y una segunda cola.

## Fase 3.2: PARCIAL (2026-08-21) — `put`/`get` y el cliente

- **`put` y `get` por el plano de control, con tope de 256 KB**, anunciado en `hello`
  (`maxBytes`). **No es un límite a subir después: es la frontera del §7.1.** Por ahí
  pasa lo que **es** un mensaje —un eco, una miniatura—, no contenido. Por eso **no hay
  subida por partes**: trocear un archivo para colarlo por el proxy sería justo lo que
  §7.1 prohíbe, solo que disfrazado.
- **`@dotrino/content-client@0.1.0`** publicado, y vive en **`lib/` de este repo** (como
  `dotrino-vault` publica el suyo): el protocolo es de las dos puntas y separarlas en
  dos repos es la forma de que acaben diciendo cosas distintas.
  - `ref.js` (referencia `ownerId+cid[+llave]`), `crypto.js` (AES-256-GCM, **una llave
    por blob**), `index.js` (encuentra los nodes por la bóveda, sesión por
    `@dotrino/remote-agent`, **comprueba el hash** de lo que llega, y falla con
    `code: 'no-node'` en vez de esperar), `thumb.js` (miniatura en canvas).
- **Falta el P2P.** Ver arriba.

## Fase 4: ARRANCADA (2026-08-21) — eco guarda en tu máquina

`dotrino-eco` consume el cliente. Cada eco es un objeto firmado e inmutable → encaja
exacto en el direccionado por hash (§3.2). Lo que se implementó tal cual lo pedía el
diseño: **durabilidad opt-in POR ECO**, con lo efímero como default y **sin memoria
entre un eco y otro** — guardar cambia lo que eco promete y eso se pide, no se hace por
detrás. El **índice** de lo guardado va al **store** (tiene que estar aunque la máquina
esté apagada) y los **bytes** al content. Sin node, eco funciona igual y el interruptor
ni aparece. La copy no dice «node» en ninguna parte (§9.1): dice «una copia, en tu
propia máquina».

**Siguiente: el transporte P2P — y con él, el resto** (`DISENO.md` §3.1, nuevo):
sin resolución `ownerId → nodes` no hay a quién pedirle los bytes. Orden: (1) el node se
publica en `<nodeId>/content_<ownerId>` —con prefijo de nodo, que hay dos proxios
federados y un canal sin prefijo es local a cada uno— y para el dueño se cablea
`listAgentsByLabel(id, 'content')` + `stat <cid>`, que ya existen; (2) P2P/swarm por
WebRTC (§13) + `@dotrino/content-client`; (3) **modo público HTTP opt-in** del node
(§7.2: el ACL ya está, faltan bind, límite por IP y techo de egress) y el sembrador
24/7 de la cuenta oficial. Luego Fase 4 = integración con **eco** (la app que resuelve
el `#fragment`), con el patrón ya definido en §3.2: **cada eco = un blob** (objeto
firmado e inmutable) y sus adjuntos otros blobs; **la línea de tiempo NO** (lista que
crece → índice en el store); y **durabilidad opt-in por post**, porque guardar tus ecos
en tu node cambia lo que el usuario entiende por "efímero" y eso se dice en la app, no
se hace por detrás. Más el catálogo. (Fases completas en `DISENO.md` §11.)

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
