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

**Añadido el 2026-08-21 (§15):** lo **público** sí puede salir por una **URL directa
del bucket del dueño** — es contenido en claro que él marcó público, y no toca esta
regla. Lo **privado** no tiene URL de ninguna clase: descansa cifrado y se entrega solo
por aquí.

### 7.1. El proxy NO transporta contenido (medido, no supuesto)

La cola offline del proxy es del **plano de control**, y sus topes lo dicen:
**24 h de TTL**, **200 mensajes / 1 MB por pubkey**, 64 MB globales con eviction
oldest-first, `maxPayload` de frame **1 MB**, y **single-drain** (el primer cliente
que se identifica la drena y se borra). Por ahí no pasa media, y lo que pasara lo
consumiría el primer lector.

> **La disponibilidad la sostiene el sembrador del dueño, no el proxy.** Las 24 h
> son la ventana de descubrimiento, no almacenamiento. Dotrino hospeda **su**
> contenido; quien quiera otro content node se lo monta y sostiene el suyo.

**Matiz añadido el 2026-08-21: `put`/`get` SÍ existen por el plano de control, con
un tope de 256 KB.** No contradice lo de arriba, lo delimita: por ahí pasa lo que
**es** un mensaje —un eco, una miniatura—, no contenido. Y por eso **no hay subida
por partes**: trocear un archivo para colarlo por el proxy sería exactamente lo que
esta sección prohíbe, solo que disfrazado. Lo que no cabe en un mensaje sube en local
o va por P2P. El tope se anuncia en `hello` (`maxBytes`) para que el cliente no lo
adivine.

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
   1. ~~**Anuncio y resolución (§3.1)**~~ **HECHO (2026-08-21):** `src/announce.js`.
      El node se publica en `<nodeId>/content_<ownerId>` —en el canal de **cada** proxio
      conocido, para que la lista no dependa de por dónde entró quien pregunta— y
      `findNodes()` contesta quién está vivo. Para el dueño, `listAgentsByLabel(id,
      'content')`, que es lo que usa `@dotrino/content-client`.
   2. **PARCIAL (2026-08-21):** `@dotrino/content-client` **publicado** (cifrado E2E,
      referencia por fragmento, comprobación de hash) y `put`/`get` por el plano de
      control con tope de 256 KB. **Falta el P2P/swarm por WebRTC** (§13), que es lo
      que desbloquea los archivos grandes y la lectura por terceros.
      **Dato despejado:** Node no trae `RTCPeerConnection`, pero **`@roamhq/wrtc`
      sirve** — distribuye binarios por `optionalDependencies` por plataforma, así que
      funciona con el `ignore-scripts=true` del ecosistema.
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
5. **Fase 4 — integración: ARRANCADA (2026-08-21).** **eco** ya guarda sus ecos en el
   node de su autor, con **durabilidad opt-in por eco** y lo efímero como default, tal
   como pedía §3.2. Falta que eco resuelva el `#fragment` **de otra persona**, que
   depende del P2P.
6. **Backend de bucket (§15) — DEFINIDO, sin implementar.** Interfaz `fs` | `s3` en
   `blobstore.js`, credenciales por el vault (`ns:content`), público a URL directa y
   privado cifrado sin URL. Es independiente del P2P: se puede hacer antes, después o
   en paralelo.
7. **Fase 5 — diferidos** (miniaturas, GC avanzado, replicación).

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

> **Y desde el §15 el sembrador ya no necesita disco:** sus bytes pueden descansar en
> un bucket del dueño (cifrados los privados), así que lo que sigue describe de dónde
> saca un `cid` que aún no tiene, no dónde lo guarda.

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

## 15. El bucket: el almacén barato del node — CERRADO (2026-08-21)

> Decidido por el dueño. Nace de una pregunta suya: *"quiero usar la capacidad de S3
> o dime otro almacén que podamos integrar de bajo costo y alta disponibilidad"*, y la
> cerró él mismo con el corte que ordena todo lo de abajo:
>
> > *"los públicos se podría dar la url directa de S3 o Cloudflare sin problema, el
> > privado sí debe obligadamente usar la red de Dotrino WebRTC/proxy"*
> > *"puede estar privado en el bucket por espacio más que nada, pero estaría cifrado"*

**El bucket es el DISCO del node, no una puerta de salida.** Esa frase es toda la
sección; lo demás son sus consecuencias. (Con un matiz que añadió el dueño y que vive
en el §15.11: el disco local no desaparece, se convierte en la **caché** — no siempre
se jala del bucket.)

| | Público | Privado |
|---|---|---|
| Cómo se guarda | en claro | **cifrado** (AES-GCM, llave por blob, §4) |
| Dónde | bucket público del dueño | bucket privado del dueño |
| **Cómo se entrega, CON bucket** | **URL directa** del bucket/CDN | **solo por la red Dotrino** |
| **Cómo se entrega, SIN bucket** | **también por la red Dotrino** | igual, por la red Dotrino |
| Quién paga | el dueño | el dueño |

**El puerto HTTP del node NO es el camino de lo público** (precisión del dueño,
2026-08-21: *"el HTTP sería solo para imágenes, y el contenido público debe ir por la
red de Dotrino en caso de no tener bucket"*). Ese puerto es y sigue siendo el de las
**vistas previas** del §7.2 — imágenes, comprobadas por sus bytes. Un PDF, un vídeo o
un archivo comprimido públicos **no salen por ahí**: van por la red Dotrino, o por una
URL del bucket si lo hay.

**El invariante, que se puede probar:** *lo que sale por una URL está en claro y
marcado `public`; lo cifrado no tiene URL.* Es el mismo cerrojo que ya vive en
`node.publicStat` (*"lo cifrado no sale ni aunque alguien le ponga `public` a mano en
el índice"*), llevado al almacenamiento.

**Esto NO es el "bucket cifrado (D)" que descartó el §7.** Aquel era un bucket **de
Dotrino** con el contenido de todos, y sigue descartado. Aquí la cuenta es **del
usuario**: el bucket es su disco, igual que hoy lo es `blobs/aa/bb/<cid>`. La regla
dura del §13 se cumple literal — el contenido no está en un server de Dotrino y la
transferencia la paga su dueño.

### 15.1. Dos buckets, no dos carpetas

No es purismo, es que **un bucket no puede ser las dos cosas**: el público necesita el
acceso público **encendido** y un dominio conectado; el privado necesita que **no lo
esté**. Eso se configura por bucket, así que una carpeta "privada" dentro del bucket
público hereda su superficie de exposición. Cuestan lo mismo (se paga por byte).

- **Credenciales distintas para cada uno.** Las del público acaban en más sitios
  (configuración, un despliegue, una nota); que esas no puedan leer lo privado es
  gratis y evita el peor accidente posible.
- Ambas viven en el **vault**, en `ns:content`, y llegan al node **selladas** por el
  mismo camino por el que los proxios reciben sus llaves de TURN. No se escriben en un
  `.env` ni pasan por ninguna app.

### 15.2. Los cuatro flujos

**Subir algo público**

1. La app tiene los bytes **en claro** y genera la miniatura en el navegador (§7.2).
2. Los manda al node del dueño (local si es la PWA; plano de control si ≤256 KB; P2P
   cuando exista).
3. El node calcula `cid = sha256(claro)`, lo guarda y lo marca `public`.
4. El node **comprueba el tipo real por los bytes mágicos** (§15.5) y sube el objeto:
   clave `<cid>`, `Content-Type` el real, `Cache-Control: public, max-age=31536000,
   immutable` (es direccionado por contenido: nunca cambia, no hay que invalidar nada).
5. La URL pública es directa y permanente: `https://<dominio-del-bucket>/<cid>`.

**Leer algo público — dos caminos, según haya bucket o no**

- **Con bucket:** un `GET` a la URL directa. Sin nada del ecosistema en medio, y eso es
  una ventaja de privacidad, no un descuido: **quien lee no se identifica ante nada
  nuestro**. Además es lo único que sigue disponible con la máquina del dueño apagada.
- **Sin bucket:** exactamente el mismo camino que lo privado — referencia, `findNodes`,
  WebRTC — solo que los bytes van en claro y no hace falta llave en el fragmento. El
  puerto HTTP del node **no** es una alternativa aquí: ese sirve imágenes de vista
  previa (§7.2), no contenido.

**Subir algo privado**

1. La app **cifra antes de subir** (llave por blob) y `cid = sha256(ciphertext)`.
2. El node recibe ciphertext, lo guarda y lo sube al **bucket privado**.
3. El enlace es `app/#<ownerId>/<cid>/<llave>`: la llave en el fragmento, que no llega
   a ningún servidor (§7).

**Leer algo privado (un tercero con el enlace)**

1. La app lee la referencia y pregunta por los proxios qué nodes del dueño están vivos
   (`announce.js` / `findNodes`).
2. Señalización por el proxy → canal WebRTC con uno de ellos.
3. El node comprueba la ACL, **lee del bucket privado con `Range` y empuja los trozos
   por el canal**; el receptor verifica el hash y descifra con la llave del fragmento.
4. Si son ≤256 KB, puede ir por `get` del plano de control, que ya existe.
5. Si no hay ningún node encendido, **no está disponible** (§13, sin atajo).

El paso 3 es la clave de por qué esto no viola nada: **los bytes privados salen del
bucket hacia el node, y del node hacia el peer por WebRTC.** Nadie de fuera recibe
jamás una URL del bucket privado, ni firmada ni de ningún tipo. *No hay `presigned
GET` para lo privado, y no se añade después: sería una segunda puerta, fuera de la
identidad, que no se revoca y no sabe a quién sirve.*

### 15.3. Qué gana esto, y qué NO arregla

Gana **espacio**, que era el motivo: el sembrador 24/7 deja de necesitar disco (el VPS
del proxio tiene 8,6 GB en total) y deja de ser el sitio donde se pierden los bytes si
se muere la máquina.

Y gana una cosa más, que se ve al juntarlo con el §15.12. **El bucket compra dos cosas
distintas según de qué contenido hablemos:**

| | Sin bucket | Con bucket | O sea, el bucket da… |
|---|---|---|---|
| **Público** | red Dotrino → necesita un node encendido | URL directa, siempre arriba | **disponibilidad** |
| **Privado** | red Dotrino, bytes en el disco del node | red Dotrino, bytes en el bucket | **durabilidad** |

**A lo privado NO le da disponibilidad, y es a propósito.** Como la entrega sigue siendo
por WebRTC, un enlace privado sigue necesitando **un node encendido**: el bucket no es
alcanzable por sí solo para lo privado, que es exactamente lo que queremos. El caveat
honesto del §13 sigue en pie tal cual.

Dicho al revés, que es como se explica solo: **lo público con bucket es lo único de
todo esto que sigue en pie con la máquina del dueño apagada.**

### 15.4. Quién puede tener bucket: solo el node standalone

**La PWA-node no lleva credenciales de bucket. Nunca.** Son credenciales de escritura
en un navegador; ahí no van. La PWA sigue con OPFS/IndexedDB, y el bucket es un backend
del **daemon**, que es quien está enrolado al vault y puede recibirlas selladas.

Consecuencia: el bucket refuerza el tier standalone, que es justo donde duele el disco.
El tier PWA no cambia en nada, y **sin bucket todo sigue funcionando igual** — disco
local es el default, y el patrón del ecosistema (`CLAUDE.md`) manda: el aparato cumple
el rol, lo dedicado solo añade.

### 15.5. Los dos cerrojos del §7.2 que se quedan

Con el egress a cero, los cerrojos que existían **por costo** (tope de 512 KB, techo de
egress, límite por IP) dejan de hacer falta en el camino del bucket. Los que existían
**por seguridad** no, y se quedan:

- **El tipo se comprueba por los bytes, no por lo que declara quien sube** (`sniffImage`).
  **El SVG y el HTML no se publican**: son documentos que ejecutan scripts.
- **El dominio público del bucket no comparte origen con ninguna app** del ecosistema.
  Da igual lo bien que filtres: si algún día se cuela algo activo, que no aterrice en
  un origen donde haya sesiones o `localStorage` de nadie.

### 15.6. Publicar no es un interruptor

Como el `cid` privado es el hash del **ciphertext** y el público el del **claro**,
publicar algo que era privado es **subirlo otra vez**, y sale con otro `cid`. No es un
defecto del diseño, es lo que ya dice `lib/crypto.js`: el `cid` público identifica **el
archivo** (dos personas que suban el mismo meme coinciden y deduplican), el privado
identifica **una copia**, a propósito, para que el node no pueda correlacionar dos
subidas del mismo original.

Y al revés, con todas las letras: **despublicar borra el objeto y purga la caché, pero
no recoge las copias que ya salieron.** Es la línea de `CLAUDE.md`: ninguna app cuida
lo que su dueño decide mostrar.

### 15.7. El índice es lo único que no es direccionable por contenido

Los blobs se reconstruyen solos: el `cid` **es** su comprobante. El **índice** (owner,
ACL, mime, miniaturas, pins) no — es el único estado del node que, si se pierde, deja
un bucket lleno de bytes anónimos. Así que se respalda **cifrado, al bucket privado**,
con una llave del vault. Es pequeño y comprimible; no es un subsistema, es un objeto más.

(No se confunde con el pilar `@dotrino/store`, §3.2: allí vive **el puntero del
usuario** —cuál es el `cid` vigente de algo—, que debe estar siempre disponible. Esto
es el inventario operativo del node.)

### 15.8. Qué ve el proveedor del bucket privado

Se dice, no se disimula: **ciphertext, tamaños, cantidad de objetos y cuándo se
tocaron.** No ve nombres ni estructura (la clave es un hash), ni puede leer nada (la
llave viaja en el fragmento y nunca pasa por ahí).

**No se rellena a tamaños fijos** para ocultar el peso: multiplicaría el gasto del
usuario por un metadato que, para el volumen del que hablamos, aporta poco. Si algún
día importa, la respuesta correcta no es el relleno: es no usar bucket para eso.

### 15.9. Proveedor: cualquiera que hable S3, y R2 de referencia

El backend se escribe contra la **API S3**, así que sirve para los cuatro. Precios a
2026-08-21, con un ejemplo de 100 GB guardados y 500 GB leídos al mes:

| | Guardar | Egress | Ejemplo/mes | |
|---|---|---|---|---|
| **Cloudflare R2** ⭐ | $0,015/GB | **$0** | **$1,50** | 10 GB gratis; ya usamos Cloudflare |
| **Backblaze B2** | $0,00695/GB | 3× lo guardado gratis, y **gratis vía CDN** | $2,70 (o $0,70 con CDN) | el más barato por GB |
| **Hetzner Object Storage** | €4,99 fijos: 1 TB + 1 TB de tráfico | incluido | $5,99 | precio plano, datos en la UE |
| **Storj** | $4/TB | $7/TB | $3,90 | descentralizado; leer se paga |

**R2 de referencia**, y con el corte de esta sección el egress a cero pesa **dos veces**:
en lo público, porque una URL directa es gasto que no puedes predecir; y en lo privado,
porque cada lectura **sale del bucket hacia el node** antes de ir al peer. Con egress
cobrado, ese salto se paga en cada descarga.

### 15.10. Cómo entra en el código

`src/blobstore.js` (107 líneas: `put` / `read` / `sizeOf` / `remove`) pasa a ser una
interfaz con dos implementaciones: **`fs`** (la de hoy, que sigue siendo el default) y
**`s3`**. `read` con rango ya mapea al header `Range` —el 206 está resuelto desde la
Fase 1— y `put` sigue hasheando en local antes de subir, así que el `cid` se calcula
igual y el dedup sale gratis con un `HEAD`.

**Sin SDK:** firma SigV4 con `node:crypto` y `fetch`, ~120 líneas. La Fase 1 se hizo
con cero dependencias a propósito y el `.npmrc` del ecosistema bloquea los scripts de
instalación; `@aws-sdk` traería decenas de paquetes para hacer un `PUT`.

**Sin simulacros** (pedido del dueño, 2026-08-21): la interfaz se prueba entera contra
el backend `fs`, que es una implementación real, y el backend `s3` se prueba contra un
**bucket de verdad** bajo un prefijo de pruebas, saltándose la prueba si no hay
credenciales. No se escribe un S3 de mentira para que la suite se sienta verde.

### 15.11. La caché local: el disco deja de ser el almacén y pasa a ser la caché

> Añadido por el dueño el 2026-08-21: *"va a tener un pequeño caché en el server de
> contenido actual, así que no siempre se jala del S3 u otro bucket"*.

Es el mismo árbol `blobs/aa/bb/<cid>` de hoy, con otro significado: deja de ser *"esto
es todo lo que tengo"* y pasa a ser *"esto es lo que tengo a mano"*. Casi no hay código
nuevo — la cuota (`--max-gb`), el GC y los pins ya existen y se convierten en la
política de desalojo. Lo que sí cambia es una cosa peligrosa, y por eso está escrita:

**El GC deja de ser borrar y pasa a ser desalojar… pero solo cuando puede.**

| | Sin bucket (hoy) | Con bucket |
|---|---|---|
| Qué hace el GC | **destruye** el blob | **desaloja** una copia caliente |
| Se puede deshacer | no | sí, se vuelve a jalar |
| Cerrojo | avisar por consola de que borra de verdad | **jamás desalojar un blob que no esté confirmado en el bucket** |

Ese cerrojo es un campo en el índice (`remote`, 0/1) que **solo se pone a 1 cuando el
bucket confirma la subida**, no cuando se lanza. Sin él, una subida a medias más un GC
oportuno pierden contenido de un usuario en silencio, que es el peor fallo posible aquí.

**Cómo se comporta**

- **Escribir:** se guarda en local, se responde, y la subida al bucket va **detrás**.
  Rápido para quien sube, pero **no se miente sobre la durabilidad**: hasta que el
  bucket confirma, ese blob es "solo local" y el GC no lo toca. Un pendiente que no
  logra subir se reintenta y se **reporta**; no se olvida.
- **Leer:** si está local, sale de local. Si no, se **jala del bucket mientras se
  sirve**, guardando de paso la copia. Con una excepción: **una lectura parcial
  (`Range`) no puebla la caché** — cachear trozos sueltos deja agujeros que luego
  parecen un blob completo.
- **Qué se queda:** LRU por **último acceso**, no por antigüedad. Hoy `gcCandidates`
  ordena por `createdAt ASC`, que para un almacén está bien y para una caché está mal:
  lo viejo y muy pedido es justo lo que hay que conservar. Hace falta un `lastRead`.
- **Los pins mandan sobre todo lo demás:** un pin es *"esto lo quiero a mano siempre"*,
  y ya está implementado. Las **miniaturas se quedan siempre**: pesan poco y son lo que
  más se pide.

**Una caché de contenido direccionado por hash no se invalida nunca.** El `cid` es el
hash: si el objeto existe, es el correcto, para siempre. No hay coherencia que
mantener, ni versiones, ni `ETag` que comparar. El único evento que la toca es un
**borrado** (despublicar, `remove`), y ese sí tiene que ir a los dos sitios: local y
bucket.

**Para qué sirve de verdad, con R2 detrás:** no para ahorrar egress —es cero—, sino
para la **latencia** y para el **tráfico del propio VPS**, que sí es finito. Con un
proveedor que cobre salida, además, ahorra dinero en cada lectura repetida.

### 15.12. Sin bucket no cambia nada: las tres puertas del node

> Precisión del dueño el 2026-08-21: *"todo lo que hablamos es cuando se integra con un
> bucket, pero el content server puede servir contenido público y privado de forma local
> usando la red de Dotrino y el puerto HTTP"*. Correcto, y ya está implementado.

**Todo el §15 es un backend, no un requisito.** El node sirve exactamente lo mismo con
bucket que sin él; lo único que cambia es de dónde salen los bytes. Es el patrón del
ecosistema otra vez (`CLAUDE.md`): el aparato cumple el rol, y lo dedicado solo añade.

Las puertas son tres y conviene no confundirlas, porque sirven cosas distintas:

| Puerta | Qué sirve | A quién | Dónde escucha |
|---|---|---|---|
| **API local** (`server.js`) | **todo**: público y privado (lo privado, cifrado — descifra quien tenga la llave) | a las herramientas del propio dueño | **`127.0.0.1` y punto** |
| **Red Dotrino** (WebRTC + plano de control ≤256 KB) | todo, con ACL y dentro de sesión cifrada y autorizada | a quien tenga la referencia y pase la ACL | por el proxy |
| **Puerto público** (`public.js`, `--public`) | **solo imágenes** marcadas `public` y en claro — es el puerto de las vistas previas, no el de lo público | a internet | `0.0.0.0`, **apagado por defecto** |

Tres cosas que se derivan de esa tabla y que no hay que perder:

- **La API local sirve todo porque está atada a `127.0.0.1`, y por eso NO tiene
  autenticación ni se puede exponer.** El bind está fijo en `bin/cli.js` a propósito:
  no hay `--host` para ella, y no debe haberlo. Si algún día hace falta llegar desde
  otra máquina, la respuesta no es abrir ese puerto — es la red Dotrino, que ya trae
  identidad, ACL y cifrado.
- **El puerto público es el de las vistas previas, no el de lo público** (§7.2):
  imágenes de mapa de bits comprobadas por sus bytes, ≤512 KB. `--public-max-kb 0`
  levanta el tope, pero **el cerrojo de "solo imágenes" no se levanta con nada**: sirve
  fotos grandes, nunca un PDF ni un vídeo. Lo público que no sea imagen viaja por la
  red Dotrino o por una URL del bucket. Y lo privado no sale por ahí jamás, con bucket
  o sin él: es el primer cerrojo.
- **El bucket va POR DEBAJO de las tres.** La interfaz vive en `blobstore.js`, así que
  ninguna de las tres puertas se entera del cambio: el mismo `GET /c/<cid>` responde
  igual saque los bytes del disco, de la caché (§15.11) o del bucket.

### 15.13. La URL del bucket es un ATAJO, nunca el enlace

> Cerrado con el dueño el 2026-08-21: *"las cuentas que incluyen un bucket tendrán esa
> opción de mostrar contenido público; si no, el contenido simplemente vive dentro de la
> red de Dotrino, y eso está bien"*.

Tener bucket es una **capacidad de la cuenta**, así que la app no puede darla por
supuesta. La forma correcta de que no importe:

**El enlace compartible sigue siendo `app/#<ownerId>/<cid>` — jamás la URL del bucket.**
Si el enlace fuera la URL, cambiar de proveedor, apagar el bucket o despublicar rompería
todo lo repartido hasta entonces. El direccionamiento por contenido existe justo para
que **el enlace sobreviva al sitio donde viven los bytes**; meter el sitio dentro del
enlace tira esa propiedad a la basura.

- **La URL, si existe, la anuncia el node** para ese `cid` (una capacidad más, junto a
  lo que ya contesta `stat`). La app **intenta el atajo y, si no hay, va por la red**.
  Ni pregunta antes ni se rompe si desaparece.
- **Se verifica igual, venga de donde venga.** El receptor comprueba el `cid` de los
  bytes que recibió, así que el atajo **no es una concesión de confianza**: un bucket
  comprometido no puede colar otros bytes, solo dejar de responder. Es la misma razón
  por la que da igual quién siembre un `cid` en el enjambre (§13).
- **Y por eso el atajo se puede quitar y poner sin avisar a nadie**: cambiar de
  proveedor, apagar el bucket o volver a encenderlo no invalida un solo enlace.

### 15.14. La configuración: una variable pública dice qué backend hay

> Pedido por el dueño el 2026-08-21: *"debe haber una variable pública que defina la
> integración, y las variables necesarias para cada caso de existir"*.

Toda la configuración del node llega por el **vault** (`ns:content`), como la de
cualquier servicio del ecosistema. La que manda es una sola, y es **pública** —se ve
desde la consola y el TUI sin destapar nada— porque saber *qué backend usa un node* es
estado de operación, no un secreto:

| Variable | Valor | |
|---|---|---|
| **`CONTENT_STORAGE`** | `local` (por defecto) · **`r2`** · `b2` · `hetzner` · `storj` · `s3` | **pública**. Sin ella, disco y nada más |

**El valor nombra al PROVEEDOR, no al protocolo** (decisión del dueño, 2026-08-21:
*"ponme `CONTENT_STORAGE=r2` explícitamente, si no es confuso"*). Y tenía razón: leer
`s3` al lado de un endpoint de Cloudflare hace dudar de si aquello es AWS. Todos los
valores menos `local` usan **el mismo backend** —hablan el mismo protocolo—, así que
esto no multiplica el código: dice quién está detrás, que es lo que quiere saber quien
mira la consola. `s3` queda para «un S3 cualquiera», incluido el de Amazon.

De paso, saber el proveedor deja poner los valores por omisión que él pide: con `r2`,
`CONTENT_S3_REGION` vale `auto` sola.

> Las demás siguen llamándose `CONTENT_S3_*` a propósito: no dicen quién hospeda, dicen
> **en qué idioma se le habla**. Es también la pista de que esas mismas variables sirven
> tal cual para Backblaze o Hetzner.

Con un proveedor puesto, y solo entonces, hacen falta las demás. **Públicas** (son direcciones y
nombres, no llaves):

| Variable | Ejemplo |
|---|---|
| `CONTENT_S3_ENDPOINT` | `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` |
| `CONTENT_S3_REGION` | con `r2` no hace falta ponerla: vale `auto` |
| `CONTENT_S3_BUCKET_PRIVATE` | el bucket sin acceso público |
| `CONTENT_S3_BUCKET_PUBLIC` | el bucket con dominio conectado (opcional: sin él, lo público viaja por la red) |
| `CONTENT_PUBLIC_BASE_URL` | `https://<dominio del bucket público>` |

Y **privadas** (nunca salen de la máquina): `CONTENT_S3_KEY_ID` + `CONTENT_S3_SECRET`
para el bucket privado, y `CONTENT_S3_PUBLIC_KEY_ID` + `CONTENT_S3_PUBLIC_SECRET` para
el público. **Dos tokens, cada uno acotado a su bucket** (§15.1).

- **Un proveedor sin las demás no arranca a medias:** el node se queda en
  `local` y lo **dice** por consola, con la lista de lo que falta. Un backend a medio
  configurar que parece funcionar es peor que uno apagado.
- **Cambiar de proveedor es cambiar el endpoint y las llaves.** R2, Backblaze, Hetzner,
  Storj y el propio S3 hablan el mismo protocolo: no hay una integración por proveedor.
- **`CONTENT_S3_BUCKET_PUBLIC` es opcional a propósito**: un node puede tener bucket
  solo para lo privado (durabilidad) y seguir sirviendo lo público por la red (§15.3).

### 15.15. Los buckets los crea el DUEÑO; el node los comprueba

> Pregunta del dueño, 2026-08-21: *"¿los creo yo o lo hace el content server?"*.

**Los crea él.** El node nunca crea buckets, y la razón es de permisos: **crear cuesta
mucho más poder que usar**. `CreateBucket` es una operación de cuenta, y un token capaz
de crear normalmente también puede listar y borrar *todos* los demás. Dárselo a un
servicio que corre en un VPS —para ahorrar un clic que se hace una vez— tira por la
borda el §15.1, donde cada token está acotado a **su** bucket.

Y aunque quisiéramos, no podría: **conectar el dominio y abrir el acceso público del
bucket público no son operaciones de S3**, son del proveedor. Quedaría una automatización
a medias que igual te manda al panel, que es peor que ninguna.

**Lo que sí hace el node es comprobar, al arrancar**, las tres cosas que se rompen sin
dar error:

| Comprobación | Por qué |
|---|---|
| Los dos nombres de bucket **no son el mismo** | el accidente más tonto y más grave: lo privado acabaría en el bucket con dominio |
| El bucket privado **no responde sin credenciales** (401/403, nunca 200) | si está abierto, el ciphertext y sus metadatos son públicos y nadie se entera |
| Lo que sube al público **se ve en `CONTENT_PUBLIC_BASE_URL`** | un dominio mal conectado no da error: simplemente no sirve nunca |

Si la primera o la segunda fallan, **el node no arranca con bucket**: se queda en `local`
y lo dice (§15.14). Un almacén mal configurado que parece funcionar es la peor de las
tres opciones.

**Lo que hay que hacer una vez, en el panel** (R2 como referencia; en otro proveedor son
los mismos cuatro pasos con otros nombres):

1. Activar R2 en la cuenta.
2. Crear el bucket **privado**: sin dominio y sin acceso público.
3. Crear el bucket **público**: con **dominio propio** conectado (el `r2.dev` está
   limitado y no es para producción).
4. Dos tokens *Object Read & Write*, **cada uno acotado a un solo bucket**, y guardarlos
   en el vault (`ns:content`, §15.14). El secreto se enseña una sola vez.

## 16. Leer lo PÚBLICO de otro: el mensaje suelto por el proxio — CERRADO (2026-08-22)

> Hasta aquí un tercero con tu enlace solo tenía la vista previa HTTP (§7.2) y, si
> había bucket, la URL. **Eso dejaba la promesa a medias**: el enlace
> `app/#ownerId/cid` nombra a un dueño, y lo mínimo es que su node conteste cuando
> alguien llama. Esta sección es ese mínimo, y con él **eco se consume por la red de
> Dotrino** sin que nadie necesite bucket.

**La regla de entrada no cambia.** Las sesiones (`ops.js`) son de los aparatos del
acta y lo siguen siendo. Lo que se añade es **otro mostrador, más pobre a propósito**:
un mensaje suelto por el proxio, `content.fetch { cid }`, sin sesión, al que el node
contesta **solo lo marcado `public` y en claro**. Un `not-found` no distingue «no
existe» de «no es público» (mismo motivo que en §7.2: no confirmar qué guarda el
node). Límite por remitente en el node, además del del proxio.

**Cómo llega el tercero al node.** Por la guía de teléfonos de §3.1: lista el canal
`content_<ownerId>` en cada proxio de la malla, toma los tokens y pregunta. El node
no es autoridad de nada: **los bytes se verifican contra el `cid`** al llegar, así que
un node equivocado, malicioso o de otro dueño solo puede fallar, no engañar. Eso está
en la lib (`fetchPublic`), para que ninguna app lo reimplemente.

**La URL es un atajo, y el node la reparte (§15.13).** La respuesta lleva `url` cuando
el node tiene bucket público **y el bucket ya confirmó esos bytes** (`remote`): una
URL que todavía da 404 no ayuda a nadie. Con `head: true` la app pide solo eso y
decide: `<img src=url>` si hay atajo, bytes por la red si no. **Lo que no cabe en un
mensaje (256 KB) se sirve solo por URL**; sin bucket, `too-large` — lo grande sigue
siendo P2P (§13).

**Lo que esto NO es.** No es un CDN por el proxio (de ahí el tope y el límite por
remitente) y no cambia la frontera con el store (§3.2): la app sigue arrancando con el
store solo, y lo público del content es lo que **otros** ven cuando el node está
encendido —o siempre, si hay bucket—. Eco es el ejemplo trabajado: el eco y su imagen
van públicos al node **con el mismo TTL de 24 h que el beacon** (lo efímero sigue
siendo efímero), el pin geo lleva solo la referencia, y quien lo lee resuelve la
imagen por URL o por la red. Sin node, eco publica texto, igual que antes.
