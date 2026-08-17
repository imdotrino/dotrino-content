# dotrino-content

Nodo de contenido del ecosistema **Dotrino**: guarda y sirve **media pesada**
(video/imagen/audio/archivos) direccionada por **hash de contenido** (`cid`),
autohospedado por el usuario. Diseño completo en
[`docs/DISENO.md`](./docs/DISENO.md); estado/continuación en
[`docs/HANDOFF.md`](./docs/HANDOFF.md).

> **Estado: Fase 2 (aparato del vault).** Al core local se le suma la identidad:
> el node se enrola a tu bóveda y se puede administrar desde tus apps por el proxy,
> sin abrir puertos. El HTTP sigue escuchando **solo en `127.0.0.1`**; exponerlo al
> mundo es la Fase 3.

## Uso

```sh
# una vez: enlazar este node a tu bóveda (saca el código de `dotrino-vault pair`)
npx dotrino-content enroll <código>

npx dotrino-content start [--port 3777] [--dir ~/.dotrino-content] \
  [--max-gb 50] [--max-blob-mb 512] [--gc-min 60] [--no-agent]
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
gc                       recolectar vencidos ahora
```

**No hay `put` por aquí, y no es un olvido:** los bytes no viajan por el proxy (su
trama es de 1 MB y su cola es de mensajes, no un almacén), y meter contenido por ahí
sería usar la infraestructura del ecosistema como transporte. Subir es local por
HTTP; entre aparatos, P2P desde la Fase 3.

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
