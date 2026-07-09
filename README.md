# dotrino-content

Nodo de contenido del ecosistema **Dotrino**: guarda y sirve **media pesada**
(video/imagen/audio/archivos) direccionada por **hash de contenido** (`cid`),
autohospedado por el usuario. Diseño completo en
[`docs/DISENO.md`](./docs/DISENO.md); estado/continuación en
[`docs/HANDOFF.md`](./docs/HANDOFF.md).

> **Estado: Fase 1 (core local).** Daemon con blobstore + índice + cuota/GC,
> escuchando **solo en `127.0.0.1`**, sin identidad ni exposición a la red
> todavía (eso es Fase 2/3).

## Uso

```sh
npx dotrino-content start [--port 3777] [--dir ~/.dotrino-content] \
  [--max-gb 50] [--max-blob-mb 512] [--gc-min 60]
```

Env: `DOTRINO_CONTENT_DIR`, `PORT`. Sin dependencias: usa `node:crypto` y
`node:sqlite` (requiere **Node ≥ 22.5**).

## API (Fase 1, localhost, sin auth)

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

## Tests

```sh
npm test
```

## Fases

1. ✅ **Core local** (este estado): blobs por `cid`, Range/206, índice, cuota+GC.
2. Auth por vault (enrolamiento tipo `dotrino-terminal`, caps `content:*`).
3. Exposición: P2P/swarm (tier PWA) + tier standalone.
4. Integración app piloto + landing `content.dotrino.com` + catálogo.

Licencia MIT.
