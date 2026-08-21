# Diseño — `dotrino-content` (servidor de contenido del ecosistema)

> **Estado:** diseño cerrado y **sin decisiones abiertas**; **Fases 1 (core local) y
> 2 (aparato del vault) implementadas** (ver `HANDOFF.md`). Este doc define el *qué* y
> el *cómo*.
>
> **Idioma/estilo:** español neutro (tuteo). Fuente de verdad del ecosistema:
> [`CLAUDE.md`](../../CLAUDE.md) y [`CONVENCIONES-APPS.md`](../../CONVENCIONES-APPS.md).

## 1. Propósito

Un **almacén de contenido autohospedado** por el usuario que guarda **cualquier
byte suyo** y produce **enlaces compartibles**. Es el pilar que faltaba: guardar lo
que el usuario tiene y servirlo, con streaming cuando hace falta.

> **Corregido el 2026-08-17 (decisión del dueño): esto NO es "el servidor de media
> pesada".** Así estaba escrito, y era una herencia del primer caso de uso (compartir
> video) que limitaba el pilar sin motivo: lo que guarda son **bytes direccionados por
> su hash**, y a eso le da igual si dentro hay un video, un PDF, un `.zip` de
> respaldo, un `.vcf`, un APK o una nota de dos líneas. **La respuesta a "¿qué puede
> almacenar?" es TODO** — con la única frontera del §3.2, que no es de tipo ni de
> tamaño.

**Misión Dotrino:** tu contenido, en tu servidor, bajo tus reglas — sin anuncios,
sin rastreo, sin vender tu identidad. El content server es *dónde* vive lo que
compartes.

### Qué NO es (deslindes)

- **No es `@dotrino/store`, y la frontera NO es el tamaño.** Regla del dueño, y es la
  que se aplica primero: **el store guarda lo que debe estar SIEMPRE disponible.**
  Vive en el navegador (IndexedDB, offline, instantáneo, con sync cifrado), así que
  responde aunque no haya ningún node encendido: preferencias, el índice de lo tuyo,
  el puntero que dice **cuál es el `cid` vigente**. El content guarda **el resto** —
  los bytes—, y para eso hace falta que alguien lo esté sembrando. Detalle, razón
  estructural y ejemplo trabajado en el **§3.2**.
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
varios perfiles de dispositivo, todos bajo **la misma identidad** (una maestra). Es el
**patrón del ecosistema** —el mismo que hace que un dispositivo pueda ser bóveda cuando
no hay daemon del vault—, escrito en `CLAUDE.md`: el aparato cumple el rol y la pieza
dedicada es un upgrade, **nunca un requisito**.

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
| Un **link que abra cualquiera, cuando sea (24/7, persistente)** | un **node standalone** sembrando (§7) |

No compiten: la **PWA es el node base**; el **standalone es el upgrade de
disponibilidad/alcance**. Con ambos, tu contenido vive en la PWA y lo **fijas
(pin)** en el box para que esté siempre arriba (el box = tu "servidor de casa"
que espeja lo que elijas).

**Ya resuelto en el §7 (2026-08-17):** el transporte del plano de datos es **WebRTC
en los dos tiers** — el standalone es un **sembrador headless** y no necesita servir
por HTTP para que las apps consuman (el modo público HTTP es un extra opt-in, §7.2).
El `ownerId + cid` resuelve al node que tenga el blob (§3.1).

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
  maestra del dueño) **es indispensable para el ruteo**: `ownerId → nodes del dueño`
  (cómo se resuelve, en el **§3.1**). Un `cid` suelto es ambiguo (varios nodes podrían
  tenerlo/reclamarlo); el `ownerId` desambigua y, como el node firma con su `D`
  (cadena `D ← ownerId`), el cliente **verifica** que el contenido viene del dueño
  declarado (ningún relay ni node ajeno puede suplantarlo).

### 3.1. Enrutamiento: cómo se sabe DÓNDE está el contenido (y qué pasa con dos nodes)

> Escrito el 2026-08-17 a partir de la pregunta del dueño («¿qué pasa si tengo dos
> content server, y cómo se sabe dónde está el contenido?»). Era la última pieza del
> modelo que estaba nombrada pero sin especificar.

**Un dueño puede tener N nodes, y eso NO es un conflicto: es un enjambre.** La
referencia nombra al **dueño**, no a la máquina (`ownerId` = huella de la maestra), así
que todos los aparatos de la misma acta son tenedores legítimos del mismo `cid`. Dos
respuestas al mismo pedido no se contradicen: los bytes se verifican contra el hash, y
además cada node firma con su `D` (cadena `D ← ownerId`), así que el consumidor
comprueba las dos cosas — que los bytes son los pedidos y que quien los sirvió es un
aparato del dueño declarado. **No hace falta saber dónde está: hace falta alguien que
lo tenga.**

La resolución `ownerId → nodes` tiene **dos caminos, según quién pregunte**:

| Pregunta | Directorio | Estado |
|---|---|---|
| **El dueño** (sus propias apps, aparatos del acta) | **la bóveda**: `vault.devices` da la pubkey (`sub`) y el label de cada aparato = su dirección en el proxy. Es `listAgentsByLabel(id, 'content')` de `@dotrino/remote-agent/discover`, lo mismo que usa la terminal para encontrar máquinas. Luego a cada node se le pregunta `stat <cid>` (§Fase 2) | **las dos piezas ya existen**; falta cablearlas |
| **Un tercero con el enlace** (no es del acta) | **canal firmado en el proxy**: el node se publica en `<nodeId>/content_<ownerId>` y cualquiera lista quién está en línea. NO puede consultar la bóveda del dueño — ni debe | **NO implementado**: hoy el node no anuncia nada |

**El prefijo de nodo en el canal no es decorativo.** Hay dos proxios federados y un
canal **sin** el id del nodo dueño es local a cada uno: dos consumidores en proxios
distintos verían listas distintas del mismo dueño. Por eso el anuncio va en
`<nodeId>/content_<ownerId>`, que es exactamente para lo que existe esa forma
(`dotrino-proxy/API.md`, «Canales con nodo dueño»). El bloque publicado va firmado y
cabe en 1000 caracteres; la lista devuelve hasta 100 miembros vivos.

**⚠️ Los nodes de un mismo dueño NO se replican todavía.** El almacén, el índice y el
dedup por `cid` son de cada node. Si subes algo al portátil, el VPS no lo tiene: el
enlace resuelve a *quien lo tenga*, así que con el portátil apagado el contenido no
está disponible aunque el VPS esté encendido y sea del mismo dueño. **Eso se arregla
en la Fase 3 con §13.1** (el sembrador se alimenta de los otros nodes), que existe
precisamente para esto. Hasta entonces, y como criterio permanente: **lo que se
comparte debe vivir en el node que está siempre** (para la cuenta oficial, el sembrador
del VPS); el portátil es origen y caché, no respaldo.

### 3.2. Qué puede guardar: TODO — y la única frontera (con eco como ejemplo)

> Decidido por el dueño el 2026-08-17: *"¿qué puede almacenar dotrino-content? y la
> respuesta debería ser todo"*, con el caso concreto *"debería poder almacenar los
> posts de eco"*.

**Cualquier byte del usuario, de cualquier tipo y cualquier tamaño**, cifrado o en
claro: documentos, fotos, respaldos, exportaciones, adjuntos de mensajería, pases de
la wallet, archivos sueltos… y **los posts de las apps**. No hay lista de tipos
permitidos y no debe haberla.

**La frontera no es el tipo ni el tamaño. Son dos criterios que apuntan al mismo
sitio**, uno operativo y otro estructural:

1. **El operativo, y es la regla de entrada (del dueño): al store va lo que debe
   estar SIEMPRE disponible.** El store vive en el aparato del usuario y responde
   offline, al instante, haya o no un node encendido. El content depende de que
   alguien esté sembrando: perfecto para los bytes, inaceptable para lo que la app
   necesita para arrancar. Si sin ese dato la app no funciona, es del store.
2. **El estructural, que explica por qué lo anterior no es una preferencia:** el `cid`
   *es* el hash, así que el content guarda **versiones, no variables**. No puede
   guardar *«lo actual»* de algo —un documento que editas, una lista que crece— porque
   cada cambio produce un `cid` distinto y el content no sabe cuál es el vigente. Eso
   solo lo puede saber algo mutable, y eso es el store.

| Va en el **content** | Va en el **store** |
|---|---|
| el objeto, tal como quedó (bytes) | **qué `cid` es el vigente** |
| cada versión, con su propio `cid` | los índices que crecen (mi línea de tiempo, mis carpetas) |
| lo que tiene tamaño o se comparte por enlace | lo que la app necesita para arrancar y operar |
| lo que puede esperar a que haya un node | preferencias, sesión, lo chico de la UI |

> **Matiz honesto del tier PWA:** cuando el node *es* la propia app (§2.1), sus blobs
> están en el aparato (OPFS) y también responden offline. La regla sigue valiendo igual,
> porque lo que no se puede dar por disponible es el contenido que vive **en otro**
> aparato o en el sembrador; y porque el índice de qué hay sigue siendo mutable.

**Ejemplo trabajado: los posts de eco.** Es el caso que mejor parte por esa línea.

- **Cada eco = un blob.** Un eco es un objeto **firmado e inmutable** (texto, enlaces,
  tags, geohash grueso, firma) que no se edita nunca: encaja exacto en el direccionado
  por hash. Sus **adjuntos** (imagen, audio, video) son blobs aparte, referenciados
  por `cid` desde el eco.
- **Mi línea de tiempo NO es un blob**: es una lista que crece → índice mutable en el
  store, o un **blob índice** cuyo `cid` vigente guarda el store. Ese es el patrón
  general para cualquier app, no un truco de eco.
- **Qué cambia en la promesa de eco, y hay que decirlo en la app.** Eco es *"efímero
  en la red, durable solo en tu copia local"*: el **TTL de 24 h gobierna el
  descubrimiento** (el beacon geo), no la existencia — su propio diseño ya dice que
  sobrevive la copia local de quien lo guardó. Guardar tus ecos en tu node añade **tu
  propia copia**, tuya y en tu máquina, alcanzable solo con la referencia
  (`ownerId + cid`, más la llave si va cifrado). Eso no rompe la promesa, la vuelve
  honesta — **pero la durabilidad tiene que ser opt-in por post** («guardar este eco
  en mi node»), con lo efímero como default. Publicar creyendo que se borra solo y
  toparse un año después con el enlace vivo es exactamente lo que el ecosistema no
  hace.
- **Muchos blobs chiquitos:** un eco pesa cientos de bytes y esto genera miles de
  blobs diminutos (un archivo + una fila de índice cada uno). Aguanta, pero si algún
  día pesa, la salida es **empaquetar por periodo** (un blob archivo por día/mes) y
  dejar el índice en el store. No se optimiza antes de tiempo, pero queda dicho.

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
- **Autorización de operaciones (CORREGIDO en la Fase 2):** administrar exige un
  cert **de la misma maestra**, con el scope **`vault:sign`** que el vault ya emite
  a cada aparato del acta. Los scopes `content:write` / `content:admin` que decía
  este documento **no existen**: el vault emite un juego fijo
  (`vault:sign`/`read`/`store`, `vault:admin` para la consola remota, y
  `vault:secrets:<ns>` para servicios), así que pedirlos habría exigido cambiar la
  emisión de certificados y el acta. Si algún día se quieren permisos por app, ese
  es el cambio a hacer — en el vault, no aquí. Lectura privada por link-con-llave no
  requiere cuenta (la llave va en el `#fragment`).
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

### 5.2. El helper compartido YA EXISTE: `@dotrino/remote-agent`

> Corregido el 2026-08-17. Este documento proponía **extraer** un `@dotrino/enroll`.
> No hace falta: la pieza está escrita, publicada y en producción. **No la
> reescribas ni escribas otra.**

**`@dotrino/remote-agent`** es el middleware de "aparato remoto enrolado al vault"
del ecosistema, y ya lo consumen `dotrino-terminal` y `dotrino-ia`. De ahí sale todo
lo que este node necesitaba para la Fase 2:

| Del paquete | Qué resuelve |
|---|---|
| `/link` → `enroll()`, `parseQr()` | emparejamiento endurecido (llave `D` propia, código que se muestra y NO viaja, `commit` del código, verificación de la cadena, `link.json` en 0600) |
| `/agent` → `startRemoteAgent()` | `identify` firmado en el proxy, canal cifrado por sesión (ECDH → AES-GCM), refresco de revocados, **renovación del cert** antes de vencer y auto-borrado al recibir un `vault.revoked` firmado |
| raíz | constantes del protocolo + el `e2e` isomórfico (lo usan las pruebas) |

Lo único propio de `dotrino-content` es el pegamento (`src/agent.js`) y las
operaciones (`src/ops.js`). **Deuda conocida, ajena a este repo:** el agente de
`dotrino-terminal` sigue con su copia inline anterior a la extracción (y por eso sin
renovación de cert); migrarlo al paquete es tarea suya, con su republicación.

## 6. API (borrador)

HTTP, `Bearer <cert>` o Basic (como `here`) para operaciones autenticadas.
Lectura pública/por-fragmento sin auth.

**Dos servidores, y no se mezclan.** El de abajo es el **local** (loopback, sin auth,
la vía de subida del propio aparato). El **público** (§7.2) es otro proceso HTTP con
otras reglas y solo tres rutas: `GET|HEAD /c/<cid>` (imágenes públicas comprobadas,
bajo el tope), `GET /p/<cid>` (el permalink con la tarjeta) y `GET /robots.txt` +
`/health`. Nada de subir, borrar ni listar por ahí.

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

## 7. Cómo se expone al mundo — CERRADO (2026-08-17)

> Decidido por el dueño. **Era la decisión bloqueante del §Fase 0 y ya no lo es.**
> No re-litigar: quedó descartado el túnel de streaming (A) y el bucket cifrado (D).

**El enlace compartible es una URL de una app del ecosistema con la referencia en
el `#fragment`, y el consumidor es una app Dotrino, no un navegador cualquiera.**

```
https://eco.dotrino.com/#<ownerId>/<cid>[/<llave>]     ← la referencia va en el fragmento
```

- **Quien sabe encontrar el contenido es la app** (eco, messenger, trueque…): lee
  la referencia del fragmento y pide los bytes al node del dueño. El servidor
  **nunca** ve `ownerId`, `cid` ni la llave (el fragmento no viaja en la petición).
- **Transporte de datos = WebRTC** (P2P/swarm del §13), con **señalización** por el
  proxy. El **tier standalone NO necesita servir por URL HTTP** para que las apps
  consuman: es un **sembrador headless 24/7**, sin puertos publicados y sin
  transporte nuevo.
- **El visitante no necesita instalar nada:** abre eco (una PWA) y **su navegador
  es el cliente**. Por eso el "no hay cliente Dotrino en ese navegador" dejó de ser
  un problema.
- **El enlace no depende del beacon efímero de eco.** El beacon de 24 h es
  *descubrimiento* geo; el enlace se resuelve solo con el fragmento, así que vive
  mientras haya un node sembrando ese `cid`.

### 7.1. El proxy NO transporta contenido (medido, no supuesto)

La cola offline del proxy es del **plano de control**, y sus topes lo dicen:
**24 h de TTL**, **200 mensajes / 1 MB por pubkey**, 64 MB globales con eviction
oldest-first, `maxPayload` de frame **1 MB**, y **single-drain** (el primer cliente
que se identifica la drena y se borra). Por ahí no pasa media, y lo que pasara lo
consumiría el primer lector.

> **La disponibilidad la sostiene el sembrador del dueño, no el proxy.** Las 24 h
> son la ventana de descubrimiento, no almacenamiento. Dotrino hospeda **su**
> contenido; quien quiera otro content node se lo monta y sostiene el suyo.

### 7.2. Modo público HTTP: SOLO vistas previas, y solo en el node del dueño

> **Reencuadrado por el dueño el 2026-08-21, e IMPLEMENTADO** (`src/public.js`,
> `--public`). La pregunta que lo cerró fue suya: *"podría incluso solo ser previews
> para evitar tráfico y que el contenido sea interno"* y, después, *"podría ser
> exclusivo de imágenes"*. Las dos van al mismo sitio, y el sitio es el correcto.

**Para qué existe este puerto: para que un enlace compartido tenga TARJETA.** No para
servir contenido. El contenido se sigue abriendo en una app del ecosistema, con la
referencia en el `#fragment` (§7). Lo que sale por aquí es una **derivada** —la
miniatura— que el dueño marcó pública, no el archivo.

Por qué se estrechó así, en vez de dejarlo como "un HTTP público con ACL":

- **El costo vive en el tamaño.** Una miniatura son decenas de KB; un original,
  megas. Es un factor ~100×, y la regla dura 2 dice que la transferencia la paga el
  usuario: cuanto menos salga, más honesto es el trato.
- **El riesgo también.** Un `/c/<cid>` abierto a originales es *hotlinking*: un
  tercero embebe tu archivo en su web y la factura es tuya. Si lo máximo que sale
  pesa 512 KB, el hotlinking deja de ser un problema económico.
- **La tarjeta no necesita más.** X, LinkedIn y WhatsApp recomprimen a ~1200×630 de
  todos modos.

**Es un MODO del propio content node** (`--public`, apagado por defecto), **no otra
app.** Una pieza aparte que fuera a buscar contenido y lo re-sirviera desde infra de
Dotrino es exactamente el caso prohibido por la regla dura 3.

**Los cinco cerrojos, todos implementados y con prueba propia** (`test/public.test.js`):

| Cerrojo | Qué hace |
|---|---|
| **ACL** | solo sale lo marcado `public` **y en claro**. Lo cifrado no sale ni aunque alguien le ponga `public` a mano en el índice (`node.publicStat` es el segundo cerrojo, en el sitio por donde los bytes salen de verdad) |
| **Solo imágenes de mapa de bits** | JPEG, PNG, GIF, WebP, AVIF. **El SVG queda fuera a propósito**: es un documento que ejecuta scripts, y servirlo desde tu dominio es regalarle un origen a quien lo suba |
| **Bytes mágicos** | el `mime` lo declara **quien sube**, así que no se cree: se leen los primeros bytes del archivo y se sirve el tipo REAL (`sniffImage`). Un HTML subido como `image/png` responde 404 |
| **Tope de tamaño** (`--public-max-kb`, 512 por defecto) | es lo que convierte esto en un servidor de miniaturas en vez de un CDN. `0` lo quita, y entonces sirve originales: es decisión del dueño y se avisa por consola |
| **Límite por IP + techo de egress diario** | cubeta por minuto, y un techo que **se persiste en el índice** (un techo que se reinicia con el proceso no es un techo) y que corta **antes** de mandar una respuesta que no cabe, no cuando ya se pasó |

Detalles que no son decoración:

- **404, nunca 403**, para lo privado: un 403 confirmaría que ese `cid` está aquí.
- **`robots.txt` prohíbe todo** por defecto. Las tarjetas sociales funcionan igual
  (los rastreadores de redes piden la página cuando alguien pega el enlace; no
  indexan), y la norma del ecosistema es que el contenido del usuario no se indexa.
  `--public-index` lo levanta: es para la cuenta oficial y su contenido público, y
  para nadie más.
- **La miniatura la genera la APP al subir** (canvas en el navegador) y se sube como
  **otro blob**, enlazado con la op `thumb` (`thumbnailCid`). El node no decodifica
  imágenes: así sigue sin dependencias nativas y el trabajo lo pone el aparato, que es
  el patrón del ecosistema. **Enlazar una miniatura no la publica**: tiene que estar
  marcada `public` por su cuenta.
- **Para la cuenta oficial el dueño es Dotrino**, así que su sembrador sirviendo su
  propio contenido público no rompe ninguna regla: es *"Dotrino paga SU transferencia,
  no la tuya"* (§14).

### 7.3. Vista previa social (OG): la hay, y es el permalink `/p/<cid>`

Un enlace con `#fragment` hacia una app estática **no puede** tener tarjeta propia en
X ni en LinkedIn: el rastreador solo ve la cáscara de la app, la misma para todos los
enlaces. Eso **sigue siendo cierto** y el dueño lo aceptó (2026-08-17).

Lo que cambió el 2026-08-21 es que el modo público (§7.2) **sí** da una tarjeta, y no
solo a la cuenta oficial: cualquier dueño que encienda `--public` obtiene un
**permalink por pieza** servido por **su propio node**:

```
GET /p/<cid>   →  HTML con og:title / og:description / og:image (+ twitter:card)
                  y un botón "Abrir" hacia  <app>/#<ownerId>/<cid>
```

- La `og:image` apunta a `/c/<imgCid>` y **se comprueba antes de anunciarla**: es el
  propio blob si es una imagen servible, o su miniatura si la tiene y es pública. Si
  no hay ninguna, la tarjeta sale sin imagen en vez de con un enlace roto.
- El botón "Abrir" lleva la referencia en el **`#fragment`**: el servidor de la app
  nunca la ve. La tarjeta es pública; la referencia, no.
- **Llamémoslo por su nombre: eso es un permalink y se va a parecer a un blog.** Es
  legítimo, pero no se vende como otra cosa.

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
- ~~**Sync/replicación** entre varios nodos del mismo usuario (casa + VPS).~~
  **PROMOVIDO a la Fase 3 el 2026-08-17** (decisión del dueño: *"el content server
  debe ir alimentándose de los otros nodos, la idea es que esté siempre online"*).
  Ver **§13.1**.

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

1. ~~**Fase 0 — decidir el §7**~~ **CERRADA (2026-08-17):** referencia por
   `#fragment` en una URL de app, consumo por app Dotrino, transporte WebRTC,
   standalone = sembrador sin HTTP. Ver §7.
2. **Fase 1 — core local: HECHA (2026-07-09).** Blobstore por `cid`, `Range`/206,
   índice SQLite, cuota + GC, CLI, cero dependencias, tests verdes.
3. **Fase 2 — auth por vault: HECHA (2026-08-17).** El node se enrola
   (`dotrino-content enroll <código>`) consumiendo **`@dotrino/remote-agent`**
   (§5.2), y con el enlace puesto atiende su **plano de control** por el proxy:
   `hello`, `list`, `stat`, `stats`, `pin`, `unpin`, `remove`, `acl`, `gc`
   (`src/ops.js`), cada uno dentro de una sesión cifrada y autorizada con
   `verifyChain` contra la misma maestra. Estampa el `owner` (`ownerId`) en lo que
   se sube y guarda el **ACL** (`public` opt-in; un blob cifrado no puede ser
   público). **No hay `put` por el plano de control**, a propósito: los bytes no
   viajan por el proxy (§7.1). 12 pruebas nuevas, incluido un extremo a extremo con
   firmas y cifrado de verdad sobre un bus en memoria.
4. **Fase 3 — exposición (SIGUIENTE).** En este orden, porque el anuncio va **antes**
   del transporte: sin él no hay a quién pedirle los bytes.
   1. **Anuncio y resolución (§3.1):** el node se publica en
      `<nodeId>/content_<ownerId>` y la lista responde qué nodes de ese dueño están en
      línea; para el dueño, cablear `listAgentsByLabel(id, 'content')` + `stat <cid>`.
   2. **P2P/swarm por WebRTC** (§13) + `@dotrino/content-client` (cifrado E2E + link
      por fragmento).
   3. **El sembrador se alimenta de los otros nodes** (§13.1): con el transporte
      puesto, es el mismo código — el sembrador pide `cid` como cualquier peer. Es lo
      que hace que un enlace no dependa de que el portátil esté encendido.
   4. ~~**Modo público HTTP opt-in**~~ **HECHO (2026-08-21), y adelantado a
      propósito**: el dueño lo pidió primero porque es autocontenido (no depende del
      anuncio ni del enjambre) y porque sin tarjeta un enlace compartido no se ve en
      ninguna red. Quedó **más estrecho** de lo que este documento proponía: solo
      **vistas previas** —imágenes comprobadas por sus bytes, con tope de tamaño,
      límite por IP y techo de egress persistido— más el permalink `/p/<cid>`. Ver
      §7.2 y §7.3. Falta el **sembrador 24/7** de la cuenta oficial, que es despliegue,
      no código.
5. **Fase 4 — integración** en la app piloto (**eco**, que es la que resuelve el
   `#fragment`) y registro en el catálogo.
6. **Fase 5 — diferidos** (miniaturas, GC avanzado, replicación).

## 12. Preguntas abiertas para el dueño

1. ~~**§7, el transporte**~~ — **CERRADO (2026-08-17)**, ver §7.
2. ~~**Hash**~~ — **CERRADO (Fase 1):** SHA-256 (`sha256-<hex>`). BLAKE3 pedía
   módulo nativo y el `.npmrc` bloquea build scripts; el prefijo de algoritmo deja
   la puerta abierta.
3. ~~**Índice de metadatos**~~ — **CERRADO (Fase 1):** SQLite propio
   (`node:sqlite`); el store queda para el índice sincronizable de fases futuras.
4. **¿MVP con cifrado desde el día 1** (recomendado) o público primero y cifrado
   después? Nota: lo de la cuenta oficial nace **público** por definición (§7.2),
   así que el camino corto es público primero **con la ACL puesta**, y cifrado en la
   Fase 3 junto al `content-client`.
5. **Cuota/retención por defecto** y política de GC (hoy configurable por CLI:
   `--max-gb`, `--max-blob-mb`, `--gc-min`).

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

### 13.1. El sembrador se alimenta de los otros nodes (para estar SIEMPRE en línea)

> Decidido por el dueño el 2026-08-17. Sale del §3.1: si los nodes de un mismo dueño
> no se replican, un enlace depende de que esté encendido el aparato donde se subió
> —el portátil— y eso hace inútil tener un sembrador 24/7.

**El objetivo, en una línea: que lo compartible esté disponible aunque solo quede
encendido el sembrador.**

**No es un subsistema nuevo: es el sembrador comportándose como un consumidor más del
enjambre** (§13). No hay un protocolo de replicación aparte, ni un "modo maestro", ni
sincronización bidireccional. El sembrador hace exactamente lo que haría cualquier
peer que quiere un `cid`:

1. **Se entera** de que existe algo nuevo. Por el **plano de control** (§Fase 2, ya
   hecho): el node que sube avisa `cid` + metadatos —un mensaje chico, que ahí sí cabe
   por el proxy— o el sembrador pregunta `list` a los otros nodes del dueño cuando los
   ve en línea (§3.1: la bóveda le dice cuáles son).
2. **Los pide** por el mismo transporte de datos del enjambre (WebRTC), como cualquier
   otro peer. **Los bytes nunca pasan por el proxy.**
3. **Los verifica solo**: el `cid` es el hash, y el blobstore ya hashea al vuelo al
   escribir. Un peer que mienta no cuela un byte.

**Qué se replica, y qué NO.** Replicar *todo* está mal: el portátil puede tener
gigas de cosas que no se comparten, y el sembrador es la máquina más expuesta y la que
cuesta dinero. Por defecto se replica lo **compartible**: lo marcado `public` y lo
**pineado** (que es como el dueño dice «esto quiero que dure»). El resto se queda donde
está. Es un default, y el dueño lo puede cambiar por blob.

**Que sea privado no lo impide.** El contenido privado viaja y se guarda **cifrado**:
el sembrador solo necesita los bytes y el `cid`, nunca la llave (que vive en el
`#fragment`). Es decir, **el nodo siempre encendido puede sostener tu contenido privado
sin poder leerlo**. Eso es exactamente lo que hace que esto no sea una concesión.

**La dirección importa: tira el sembrador, no empuja el portátil.** El que tiene
uptime, disco y política de cuota es el sembrador, así que es él quien decide qué se
trae y cuándo. El aparato efímero solo **avisa**; si se apaga a media descarga, el
sembrador reintenta cuando vuelva a verlo — un aviso perdido no rompe nada, porque el
`list` del paso 1 lo vuelve a descubrir.

**Cuota y GC no se saltan.** Lo replicado entra con el `ttl`/`pin` que traía del
origen y compite por la cuota del sembrador como cualquier otro blob (§Fase 1: los
pineados no se desalojan; si solo quedan pineados, `ENOSPC`). Un sembrador lleno **no
borra en silencio lo del dueño**: avisa. Marcar todo lo replicado como pineado sería
la forma cómoda de llenar el disco y quedarse sin salida.

**Autorización: nada nuevo.** Solo se acepta de aparatos de la **misma acta**, que es
lo que el plano de control ya comprueba con `verifyChain` (§5). Un tercero no puede
inyectarle contenido al sembrador de nadie.

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
