# dotrino-content

Nodo de contenido del ecosistema **Dotrino**: guarda y sirve **media pesada**
(video/imagen/audio/archivos) direccionada por **hash de contenido** (`cid`),
autohospedado por el usuario. Diseño completo en
[`docs/DISENO.md`](./docs/DISENO.md); estado/continuación en
[`docs/HANDOFF.md`](./docs/HANDOFF.md).

> **Estado: Fase 2 (aparato del vault) + vistas previas públicas.** Al core local se
> le suma la identidad: el node se enrola a tu bóveda y se puede administrar desde tus
> apps por el proxy, sin abrir puertos. El HTTP de administración sigue escuchando
> **solo en `127.0.0.1`**; con `--public` se abre, aparte, un puerto que sirve
> **únicamente vistas previas** para que un enlace compartido tenga tarjeta en las
> redes. El transporte P2P entre aparatos es lo que queda de la Fase 3.

## Uso

```sh
# una vez: enlazar este node a tu bóveda (saca el código de `dotrino-vault pair`)
npx dotrino-content enroll <código>

npx dotrino-content start [--port 3777] [--dir ~/.dotrino-content] \
  [--max-gb 50] [--max-blob-mb 512] [--gc-min 60] [--no-agent]

# con vistas previas públicas (ver más abajo antes de encenderlo)
npx dotrino-content start --public --public-port 3778 --public-egress-gb 5 \
  --public-url https://content.tudominio.com
```

Al enrolar, el node genera **su propia llave** y muestra un código que tienes que
tipear en la bóveda para aprobarlo: ese código no viaja por la red, así que aprobar
exige tener delante esta máquina. La **clave maestra nunca llega aquí** — solo un
certificado con caducidad, que el node renueva solo y que puedes revocar
(`dotrino-vault revoke <deviceId>`) sin tocar el resto de tus aparatos.

Env: `DOTRINO_CONTENT_DIR` (datos), `DOTRINO_CONTENT_LINK_DIR` (enlace), `PORT`.
Requiere **Node ≥ 22.5**. El core usa solo `node:crypto` y `node:sqlite`; la
identidad viene de los pilares del ecosistema (`@dotrino/remote-agent`,
`@dotrino/identity`).

## Plano de control (Fase 2, por el proxy, cifrado)

Con el node enlazado, tus propias apps —cualquier aparato con un certificado de **la
misma** bóveda— pueden administrarlo a distancia dentro de una sesión cifrada:

```
hello                    quién es el node (owner, versión, uso de disco)
list · stat <cid> · stats  qué guarda
pin <cid> · unpin <cid>  retener / soltar
remove <cid>             borrar
acl <cid> public|private abrir o cerrar un blob (público es opt-in explícito)
meta <cid> {…}           nombre/título/descripción para la tarjeta de la vista previa
thumb <cid> <thumbCid>   enlazar la miniatura (otro blob, público por su cuenta)
gc                       recolectar vencidos ahora
```

**No hay `put` por aquí, y no es un olvido:** los bytes no viajan por el proxy (su
trama es de 1 MB y su cola es de mensajes, no un almacén), y meter contenido por ahí
sería usar la infraestructura del ecosistema como transporte. Subir es local por
HTTP; entre aparatos, P2P desde la Fase 3.

## Vistas previas públicas (`--public`, apagado por defecto)

**Para qué es: para que un enlace que compartes tenga TARJETA** en X, LinkedIn,
WhatsApp o Telegram. No es para servir tu contenido — eso se sigue abriendo en la app,
con la referencia en el `#fragment`, que nunca llega a ningún servidor. Lo que sale por
este puerto es la **miniatura** que tú marcaste pública, no el archivo.

```
GET|HEAD /c/<cid>   los bytes, si pasan TODOS los cerrojos de abajo
GET      /p/<cid>   permalink: tarjeta (og:*) + botón "Abrir" hacia la app
GET      /robots.txt · /health
```

Cinco cerrojos, y ninguno se puede saltar desde fuera:

| | |
|---|---|
| **Solo lo público y en claro** | lo cifrado no sale ni marcado público a mano en el índice |
| **Solo imágenes de mapa de bits** | JPEG, PNG, GIF, WebP, AVIF. **SVG no**: es un documento que ejecuta scripts |
| **El tipo se comprueba en los bytes** | el `Content-Type` lo declara quien sube, así que no se cree: un HTML subido como `image/png` responde 404 |
| **Tope de tamaño** (`--public-max-kb`, 512) | es lo que hace que esto sea un servidor de miniaturas y no un CDN. `0` lo quita y entonces sirve originales: el ancho de banda lo pagas tú |
| **Límite por IP + techo diario** | `--public-rate` (60/min) y `--public-egress-gb`, que se **persiste** y corta antes de mandar una respuesta que no quepa |

Lo privado responde **404, nunca 403**: un 403 confirmaría que ese `cid` está aquí. Y
`robots.txt` prohíbe todo (las tarjetas funcionan igual: los rastreadores de las redes
piden la página cuando alguien pega el enlace, no indexan). `--public-index` lo levanta.

**La miniatura la genera tu app al subir** (con un canvas) y se sube como **otro
blob**, que se enlaza con la op `thumb`. El node no decodifica imágenes: así no
arrastra dependencias nativas. Enlazar una miniatura **no** la publica — se marca
pública por su cuenta.

## API HTTP (localhost)

```
POST   /c?ttl=<ms>&enc=1   subir (streaming; Content-Type = mime) → { cid, size, mime, existed }
GET    /c/<cid>            descargar/streamear (Range → 206; ETag = cid, immutable)
HEAD   /c/<cid>            size/mime/etag sin cuerpo
DELETE /c/<cid>            borrar
GET    /list               índice de blobs
POST   /pin/<cid>          retención (excluye del GC)     POST /unpin/<cid>
GET    /stats              nº de blobs, bytes usados, cuota
```

- `cid = sha256-<hex>` (prefijo de algoritmo → extensible a BLAKE3 después; se
  usa SHA-256 de `node:crypto` porque no exige dependencias nativas y el
  `.npmrc` del ecosistema bloquea build scripts de npm).
- Disco: `blobs/<aa>/<bb>/<cid>` (sharding); índice en SQLite (`index.db`).
- Dedup por contenido: re-subir el mismo archivo devuelve `existed: true`.
- **Cuota** (`--max-gb`): al no caber, el GC desaloja no-pineados más viejos;
  los **pineados jamás se borran** (si solo quedan pineados → `507`).
- **TTL** opcional por blob (`?ttl=<ms>`): vencido = candidato a GC.
- El cifrado E2E es **del lado del cliente** (el node solo ve ciphertext si
  subes cifrado y marcas `enc=1`); la llave viaja en el `#fragment` del enlace.
- **`owner` y `acl`:** con el node enlazado, todo lo que se sube queda estampado con
  el `ownerId` de tu bóveda (la mitad izquierda de la referencia compartible
  `ownerId + cid`). El `acl` nace privado: lo que no se marca `public` a mano no sale
  del node cuando llegue el modo público, y un blob cifrado no puede marcarse
  público (nadie sin la llave podría leerlo).

## Tests

```sh
npm test
```

## Fases

1. ✅ **Core local**: blobs por `cid`, Range/206, índice, cuota+GC.
2. ✅ **Aparato del vault** (este estado): enrolamiento, plano de control cifrado,
   `owner` + `acl`.
3. Exposición: P2P/swarm por WebRTC + modo público HTTP opt-in + sembrador 24/7.
4. Integración con **eco** (la app que resuelve el `#fragment`) + catálogo.

Licencia MIT.
