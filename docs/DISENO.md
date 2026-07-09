# Diseño — `dotrino-content` (servidor de contenido del ecosistema)

> **Estado:** diseño cerrado; **Fase 1 (core local) implementada** (2026-07-09,
> ver `HANDOFF.md`). Este doc define el *qué* y el *cómo*.
>
> **Idioma/estilo:** español neutro (tuteo). Fuente de verdad del ecosistema:
> [`CLAUDE.md`](../../CLAUDE.md) y [`CONVENCIONES-APPS.md`](../../CONVENCIONES-APPS.md).

## 1. Propósito

Un **servidor de contenido autohospedado** por el usuario que **guarda y sirve
media pesada** (video, imágenes, audio, archivos) y produce **enlaces
compartibles**. Es el pilar que faltaba: hospedar bytes grandes y servirlos por
URL, con streaming.

**Misión Dotrino:** tu contenido, en tu servidor, bajo tus reglas — sin anuncios,
sin rastreo, sin vender tu identidad. El content server es *dónde* vive lo que
compartes.

### Qué NO es (deslindes)

- **No es `@dotrino/store`.** El store (`store.dotrino.com`, IndexedDB en el
  navegador) guarda **datos chicos y estructurados** (hilos, sets, historial,
  metadatos) del usuario, local, con sync a Drive. Un video **no** cabe ahí ni se
  sirve por URL. El content server **complementa** al store: el store guarda el
  **índice** (chico); los **blobs** (grandes) viven en el content server.
- **No es `qrshare`.** qrshare es transferencia **P2P efímera** (WebRTC, sin
  hospedaje). El content server es **hospedaje persistente** con URL estable.
- **No es el `vault`.** El vault (`dotrino-vault`) es tu **CA/identidad** (guarda
  la llave maestra, firma, emite certs). El content server **usa** la identidad
  del vault para autorizar, pero **no** guarda llaves ni es crítico de seguridad.

## 2. Decisión de arquitectura: lógicamente integrado, físicamente separado

**No** se fusiona con el vault en un solo proceso. Sí se **co-empaqueta** para que
sea una sola instalación. Razones (analizadas con el dueño):

| Motivo | Por qué separar procesos |
|---|---|
| **Seguridad** | El vault tiene la **llave maestra**. Un servidor de media parsea archivos, transcodifica y atiende internet: máxima superficie de ataque. No debe compartir proceso con la CA. |
| **Recursos** | Identidad = mínima, ráfagas. Media = disco + ancho de banda + conexiones largas. Deben poder vivir en hosts distintos (media en NAS/VPS barato, identidad en la máquina de confianza). |
| **Disponibilidad** | Un link de media debe estar arriba 24/7; el vault puede ser intermitente. |
| **Aislamiento de fallos** | Un crash del transcodificador no debe tumbar tu CA. |

**Cómo se resuelve la fricción de "instalar dos cosas":** un **solo instalador /
`npx` / `.deb`** levanta **dos procesos aislados** bajo un supervisor; el
contenido es un **toggle opcional**. El usuario percibe "instalo el nodo Dotrino".
Identidad y túnel **compartidos** (abajo).

```
        ┌─────────────────────  nodo Dotrino (una instalación)  ─────────────────────┐
        │                                                                             │
        │   dotrino-vault  (proceso A, crítico)        dotrino-content (proceso B)     │
        │   · llave maestra, firma, certs              · blobs en disco (hash)         │
        │   · API local (IPC) de identidad/caps        · sirve HTTP + streaming        │
        │            ▲                                   │  pide caps por IPC ─────────┼──┐
        │            └───────────  IPC local  ───────────┘                            │  │
        └─────────────────────────────────────────────────────────────────────────────┘  │
                       (exposición al mundo por túnel / transporte, §7)  ◄────────────────┘
```

## 2.1. Topología: el "node" es la PWA del usuario (+ standalone opcionales)

**"Node" (identidad + contenido) es un ROL**, no una máquina; lo cumplen uno o
varios perfiles de dispositivo, todos bajo **la misma identidad** (una maestra):

- **PWA-node (default, CERO instalación):** la propia app del usuario **es** el
  node. Guarda identidad (maestra o dispositivo primario) + **tu contenido local**
  (OPFS/IndexedDB — el navegador ya aguanta GB) y comparte **P2P por WebRTC**
  (`@dotrino/proxy-client`) mientras está abierta/online. Hogar de la identidad y
  tu almacén. No instalas nada.
- **Node standalone (opcional, enrolado):** daemon (Docker/`npx`) en VPS/NAS,
  **siempre encendido y alcanzable** (HTTP por túnel/puerto), disco/BW grandes.
  Enrolado al **mismo** vault (cert delegado, §5).

**Caveat honesto (define qué necesitas):** una **PWA NO es un endpoint público
alcanzable** (el navegador no atiende `GET` entrante; el móvil se duerme). Por eso:

| Necesito… | Basta con |
|---|---|
| Compartir en vivo / P2P / 1-a-pocos **mientras estoy online** | **la PWA** (WebRTC) |
| Un **link que abra cualquiera, cuando sea (24/7, persistente)** | un **node standalone** (o §7-D bucket cifrado) |

No compiten: la **PWA es el node base**; el **standalone es el upgrade de
disponibilidad/alcance**. Con ambos, tu contenido vive en la PWA y lo **fijas
(pin)** en el box para que esté siempre arriba (el box = tu "servidor de casa"
que espeja lo que elijas).

**Reformula la Fase 0 (§7):** el transporte del plano de datos NO es una elección
única global, es **por tier** — PWA → WebRTC/P2P; standalone → HTTP (túnel de
streaming / puerto propio). El `ownerId+cid` resuelve al node que tenga el blob.

## 3. Modelo de datos: direccionado por contenido (hash)

- Cada blob se identifica por el **hash de su contenido** (p. ej. `BLAKE3` o
  `SHA-256`): `cid = <algo>-<hash>`. Ventajas:
  - **Inmutable** (la URL nunca "cambia de significado") → cacheable a full.
  - **Dedup gratis** (el mismo archivo subido dos veces = un blob).
  - **Verificable** (el receptor comprueba que los bytes coinciden con el hash).
- **Almacenamiento en disco:** `blobs/<aa>/<bb>/<cid>` (sharding por prefijo). Un
  índice ligero (SQLite o el mismo `@dotrino/store` para metadatos) guarda:
  `cid, size, mime, createdAt, owner, enc(bool), acl, refs, ttl?, thumbnailCid?`.
- **Metadatos ≠ bytes:** el **índice** (chico) puede sincronizarse por el store;
  los **bytes** viven solo en el content server.
- **Referencia compartible = `ownerId + cid` (+ `#fragment` con la llave si es
  privado).** El `cid` da inmutabilidad/dedup; el **`ownerId`** (pubkeyId de la
  maestra del dueño) **es indispensable para el ruteo**: `ownerId → endpoint del
  node` (por el túnel/proxy). Un `cid` suelto es ambiguo (varios nodes podrían
  tenerlo/reclamarlo); el `ownerId` desambigua y, como el node firma con su `D`
  (cadena `D ← ownerId`), el cliente **verifica** que el contenido viene del dueño
  declarado (ningún relay ni node ajeno puede suplantarlo).

## 4. Privacidad: cifrado E2E por defecto, público opt-in

Dos modos por blob (lo elige el usuario al compartir):

1. **Privado (default): cifrado extremo a extremo.** El cliente cifra el blob
   (AES-GCM / secretbox) **antes** de subir; el server solo ve **ciphertext**. La
   **llave viaja en el `#fragment`** del enlace (`…/c/<cid>#k=<key>`), que **nunca
   llega al servidor** ni es indexable (regla de `CLAUDE.md`). Quien tiene el link
   descifra en su navegador. El server no puede leer tu contenido.
2. **Público (opt-in):** blob en claro, servido tal cual (p. ej. un meme, un `og.jpg`).
   Útil para lo que quieres abierto. El usuario decide, caso por caso.

> El cifrado del contenido privado es **independiente** de la identidad: no
> requiere que el receptor tenga cuenta. La identidad/caps del vault se usan para
> **autorizar escritura** y **ACLs por círculo** (abajo), no para el descifrado
> del link público-por-fragmento.

## 5. Identidad y autorización: **agente enrolado al vault** (igual que la terminal)

El content node **SÍ porta llave**, pero **delegada, no la maestra**. Se **enrola**
al vault del dueño con el **mismo mecanismo que `dotrino-terminal`** (no se
reinventa):

- **Enrolar una vez:** en el vault `dotrino-vault pair` (QR/JSON) → en el node
  `npx dotrino-content enroll` (pega el QR). El node recibe su **llave de
  dispositivo `D` + cert** encadenado a la maestra (`D ← maestra`). No necesita
  correr en la máquina del vault (puede ser un VPS/NAS).
- **Confianza:** cada extremo verifica que el `cert` del otro **encadena a la
  misma maestra pineada** (`@dotrino/identity` `verifyChain`), mismo trust anchor
  que la terminal. Sin enrolamiento a ESE vault (o revocado) → no sirve nada.
- **Autorización de operaciones:** subir/borrar/administrar exige un cert con
  scope `content:write` / `content:admin` (delegado por el vault). Lectura privada
  por link-con-llave no requiere cuenta (la llave va en el `#fragment`).
- **ACL por círculo (opcional):** media privada compartida con un grupo por
  membresía → scope `content:read:<circleId>` firmado por el dueño (patrón
  `here`/geo + web-of-trust).
- **Revocación real:** `dotrino-vault revoke <deviceId>` corta ese node **sin
  tocar la maestra** ni los demás dispositivos (+ feed de nonces revocados).

> **La maestra (Mpriv) se queda en el vault; el node solo tiene `D` + cert.** Si
> comprometen el box de media, revocas su `deviceId` y listo.

### 5.1. Dos planos (única diferencia con la terminal)

La terminal manda TODO por el **proxy** (mensajes chicos). El content node hace
igual para el **control**, pero la **media no cabe en el proxy** (video), así que
se parte en dos:

- **Plano de control → `@dotrino/proxy-client`** (`identify` firmado, `sendByPubkey`,
  cola offline, E2E): autorizar, ACLs, resolver "¿quién es dueño del `cid`?",
  firmar/entregar manifiestos. Igual que la terminal.
- **Plano de datos (bytes/streaming) → transporte del §7** (túnel de streaming /
  puerto propio / etc.). Este es el añadido sobre el modelo de la terminal.

### 5.2. Patrón repetido → helper compartido

Ya van **terminal + content + (otros servicios)** enrolándose igual. Extraer un
**`@dotrino/enroll`** (o exponerlo desde `@dotrino/identity`) para que todo
servicio enrolado haga *pair → device cert → verifyChain → revoke* **idéntico**,
sin duplicar. "Enlazar un servicio al vault" = una sola pieza reutilizable.

## 6. API (borrador)

HTTP, `Bearer <cert>` o Basic (como `here`) para operaciones autenticadas.
Lectura pública/por-fragmento sin auth.

```
POST   /c                      # subir (streaming). body = bytes (ya cifrados si privado)
                               #   → { cid, size, mime }
GET    /c/<cid>                # descargar/streamear (soporta Range → video seek)
HEAD   /c/<cid>                # size/mime/etag sin cuerpo
GET    /c/<cid>/thumb          # miniatura (si existe; ver §9)
DELETE /c/<cid>                # borrar (auth: content:admin del dueño)
GET    /list                   # índice del dueño (auth) → [{cid,mime,size,createdAt,...}]
POST   /pin  /  /unpin         # retención (evita GC) / liberar
GET    /stats                  # uso de disco, cuota, nº blobs
```

- **Streaming:** `GET /c/<cid>` **debe** soportar `Range` (206 Partial Content)
  para *seek* de video y para que `<video>`/`<audio>` funcionen. `ETag = cid`
  (inmutable) → `Cache-Control: immutable`.
- **Sin trackers**, sin analítica de terceros; si acaso, GoatCounter del ecosistema
  para la cáscara pública (no para el contenido).

## 7. ⚠️ Decisión abierta CRÍTICA: cómo se expone al mundo (el video no cabe en el túnel actual)

El túnel `@dotrino/tunnel` (`r.dotrino.com`) hoy tiene **payload 1 MB y timeout
30 s** (ver `CLAUDE.md`). Eso **sirve para requests chicos** (identidad, JSON),
pero **NO para streamear video** (transferencias grandes, conexiones largas,
Range). Hay que decidir el transporte de la media. Opciones:

- **A. Túnel de streaming dedicado** (recomendado a explorar): extender el relay
  del túnel con un canal **sin el límite de 1 MB/30 s**, con soporte de `Range` y
  backpressure, específico para `dotrino-content`. Mantiene "todo por el nodo del
  usuario", pero limita el ancho de banda al **uplink del usuario** (ok para
  compartir 1-a-pocos; no para viralidad masiva).
- **B. P2P / WebRTC** (como qrshare) para entrega directa emisor→receptor, sin
  relay. Bueno para 1-a-1 en vivo; malo para "link que abro mañana" (requiere que
  el emisor esté online y no hay URL cacheable).
- **C. Puerto propio / dominio propio del usuario** (autohosteo "real"): quien
  tenga un VPS/NAS con puerto abierto sirve directo. Máximo control; más fricción.
- **D. Fallback opcional a bucket público** (rompe el autohosteo puro): subir el
  blob **cifrado** a un almacenamiento barato (R2/S3/etc.) para lo que necesite
  alcance/uptime alto, **opt-in y explícito**. El server solo tiene ciphertext, así
  que sigue sin ver el contenido; pero deja de ser "solo tu servidor".

**Recomendación:** empezar con **A** (túnel de streaming) para el caso "comparto
con mi gente", documentar el límite (tu uplink), y dejar **D** como opción
avanzada y explícita para quien quiera alcance. Definir esto **antes** de codear:
condiciona todo el transporte.

## 8. Co-empaquetado con el vault (una instalación)

- Un **supervisor** (o el propio instalador del vault con un flag
  `--with-content`) arranca ambos procesos con PM2/systemd.
- **IPC local** vault↔content (socket unix / localhost) para pedir/validar caps.
- **Config** compartida (misma identidad, misma llave del túnel si se comparte
  transporte de control). El usuario gestiona **una** identidad.
- **Landing** `content.dotrino.com`: página estática (§1.2 de convenciones) que
  explica qué es y cómo instalarlo; el **servido real** de media va por el
  transporte del §7, no por Pages.

## 9. Diferidos (v2+, no bloquean el MVP)

- **Miniaturas / posters** de video-imagen (generación local, opt-in; cuesta CPU).
- **Transcoding** a formatos web (HLS/dash) — pesado; probablemente fuera de alcance
  o como módulo aparte.
- **Cuotas y GC:** límite de disco configurable; GC de blobs sin `pin` ni `ref` y
  con `ttl` vencido (como el TTL efímero de `here`/geo, pero configurable y con
  retención explícita para lo que quieras permanente).
- **Sync/replicación** entre varios nodos del mismo usuario (casa + VPS).

## 10. Integración con las apps del ecosistema

Reusable por **todas** las apps (regla de `CLAUDE.md`: pilar compartido, no
solución de una app):

- **eco / trueque / messenger:** adjuntar imagen/video a un post/mensaje → sube al
  content server (cifrado), guarda el `cid`+llave en el `#fragment`/store, el
  receptor lo abre.
- **wallet / qrshare:** persistir lo que hoy es efímero.
- **`<dotrino-share>`:** compartir un `cid` como cualquier otro enlace (#fragment).
- Cliente: paquete **`@dotrino/content-client`** (browser) que cifra, sube por
  streaming, arma el link `…/c/<cid>#k=…`, y ofrece un `<video>`/`<img>` que
  descifra al vuelo (Media Source / fetch + decrypt + blob URL).

## 11. Fases de implementación (propuesta)

1. **Fase 0 — decidir el §7** (transporte de media). Bloqueante.
2. **Fase 1 — core local:** `dotrino-content` daemon: subir/leer/borrar por `cid`
   en disco, `Range`, índice SQLite, cuotas básicas. Sin cifrado aún (o cifrado del
   lado cliente ya, mejor). Solo local (localhost).
3. **Fase 2 — auth por vault:** caps `content:write/admin`, IPC con el vault.
4. **Fase 3 — exposición** por el transporte elegido (§7) + `@dotrino/content-client`
   (cifrado E2E + link por fragmento).
5. **Fase 4 — integración** en una app piloto (eco o messenger) y landing
   `content.dotrino.com` + catálogo.
6. **Fase 5 — diferidos** (miniaturas, GC avanzado, replicación).

## 12. Preguntas abiertas para el dueño

1. **§7 es la grande:** ¿A (túnel streaming), C (dominio/puerto propio), o A+D
   (con fallback a bucket cifrado opt-in)? Define el transporte.
2. **Hash:** ¿BLAKE3 (rápido) o SHA-256 (ubicuo)? (Recomiendo BLAKE3.)
3. **Índice de metadatos:** ¿SQLite propio del content, o reusar `@dotrino/store`?
   (SQLite escala mejor para muchos blobs; el store para el índice sincronizable.)
4. **¿MVP con cifrado desde el día 1** (recomendado) o público primero y cifrado
   después?
5. **Cuota/retención por defecto** y política de GC.

## 13. Compartir grandes volúmenes: P2P + swarm (sin server, costo del usuario)

Reglas duras del dueño: **el contenido siempre del lado del usuario, NUNCA en un
server de Dotrino; y si hay costo de transferencia, lo paga el usuario.** La única
arquitectura que las cumple:

- **Transporte = WebRTC device↔device.** Los bytes van **directo peer↔peer**;
  Dotrino solo relaya **señalización** (SDP/ICE, kilobytes) por el proxy. El
  contenido **nunca** toca un server. Direccionado por `cid` (chunks verificables),
  E2E. Precedente: `qrshare` + `@dotrino/proxy-client` (WebRTC + señalización).
- **Relay (TURN) solo si el NAT lo obliga (~10-20%):** **BYO del emisor, lo paga
  él**, creds efímeras. Sin TURN del emisor y sin conexión directa → la
  transferencia **falla** (no hay relay gratis a costa de Dotrino).
- **Volumen / muchos receptores → swarm tipo WebTorrent sobre WebRTC:** quienes ya
  recibieron **re-siembran**; el ancho de banda se **distribuye entre los que
  consumen**, no se centraliza. `cid` = "infohash". Nada en un server de Dotrino.
- **Anti-abuso (sin costo para Dotrino):** solo peers **enrolados/identificados**
  anuncian en el tracker (proxy, `identify` firmado) + **rate-limit**; anuncios
  **firmados** (`ownerId`, revocables); privado gated por llave-en-fragment + cap
  por círculo; público opt-in; TURN con creds efímeras (no leecheable).
- **Caveat honesto:** P2P puro exige **ambos online**; "bajar después" requiere el
  **nodo del emisor arriba** (su box/ancho de banda) o **seeders** en el swarm. Un
  archivo sin seeders online = no disponible (igual que un torrent sin seeds).

> Esto **es** el transporte del plano de datos por defecto (tier PWA): **P2P/swarm**,
> no un túnel de streaming que pasaría bytes por infra de Dotrino. El tier standalone
> = "tu box, tu ancho de banda" para 24/7.

## 14. La cuenta oficial de Dotrino = un tercero más (dogfooding)

**La cuenta `dotrino` NO tiene backend privilegiado.** Corre el MISMO stack que
cualquier tercero: su **vault + content node + TURN** propio. No hay "servidor
especial" ni ruta privilegiada; Dotrino es otro usuario de su propio protocolo.

- **Ejemplo/referencia viva:** el deploy oficial es la implementación de referencia
  ("así corre el nuestro"); onboarding y docs apuntan a él. Federado por
  construcción (un peer más, sin autoridad central de contenido).
- **Seeder de lo público de Dotrino:** siembra la media pública del ecosistema con
  **su propio ancho de banda**, como cualquier publicador.
- **⚠️ TURN oficial = BYO-TURN de Dotrino, pagado por Dotrino, para el contenido de
  Dotrino.** NO es un relay abierto/gratis para terceros (eso reintroduce el abuso
  y el costo que el §13 elimina). Creds efímeras gated por la identidad de Dotrino →
  solo relaya las transferencias del node oficial. Cada tercero trae su propio TURN.

> Regla para evitar malentendidos: **"Dotrino paga SU transferencia, no la tuya."**
> Un relay/seedbox compartido para terceros solo existiría como **producto explícito
> financiado** (perk de plan patrocinador, `MODELO-NEGOCIO.md`), nunca como default
> gratis. La cuenta oficial es **ejemplo, no excepción**: no se da un privilegio que
> rompa las reglas para el resto.
