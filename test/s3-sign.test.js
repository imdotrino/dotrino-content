/**
 * La firma SigV4, contra los VECTORES PUBLICADOS por AWS.
 *
 * Esto no es un S3 de mentira: son las respuestas conocidas de la especificación
 * —clave, fecha y petición fijas → una firma exacta—, que es como se comprueba una
 * función criptográfica. Si la firma no cuadra, un servidor real contesta
 * «SignatureDoesNotMatch» y nada más; aquí se ve en qué paso se torció.
 *
 * Vectores: la suite `aws-sig-v4-test-suite` (get-vanilla) y los tres ejemplos
 * trabajados de la documentación de S3 (GET con Range, PUT y listado con query).
 * El bucket de verdad se prueba aparte, en la prueba de integración.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { signRequest, uriEncode, amzDate } from '../src/s3.js'

const firma = (auth) => /Signature=([0-9a-f]+)/.exec(auth)[1]

const SUITE = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' }
const S3DOC = { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' }

test('get-vanilla, el vector base de la suite de AWS', () => {
  const h = signRequest({
    method: 'GET',
    url: 'https://example.amazonaws.com/',
    region: 'us-east-1',
    service: 'service', // la suite no firma para s3, así que no lleva x-amz-content-sha256
    now: new Date('2015-08-30T12:36:00Z'),
    ...SUITE
  })
  assert.equal(firma(h.authorization),
    '5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31')
  assert.match(h.authorization, /Credential=AKIDEXAMPLE\/20150830\/us-east-1\/service\/aws4_request/)
})

test('GET de un objeto con Range (ejemplo de la documentación de S3)', () => {
  const h = signRequest({
    method: 'GET',
    url: 'https://examplebucket.s3.amazonaws.com/test.txt',
    headers: { range: 'bytes=0-9' },
    region: 'us-east-1',
    now: new Date('2013-05-24T00:00:00Z'),
    ...S3DOC
  })
  assert.equal(firma(h.authorization),
    'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41')
  // La petición canónica, tal cual la publica AWS: si esto se tuerce, la firma
  // también, y es donde se ve por qué.
  assert.equal(h._canonicalRequest, [
    'GET',
    '/test.txt',
    '',
    'host:examplebucket.s3.amazonaws.com',
    'range:bytes=0-9',
    'x-amz-content-sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    'x-amz-date:20130524T000000Z',
    '',
    'host;range;x-amz-content-sha256;x-amz-date',
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
  ].join('\n'))
})

test('PUT de un objeto: el hash del cuerpo entra en la firma', () => {
  const h = signRequest({
    method: 'PUT',
    url: 'https://examplebucket.s3.amazonaws.com/test$file.text',
    headers: { date: 'Fri, 24 May 2013 00:00:00 GMT', 'x-amz-storage-class': 'REDUCED_REDUNDANCY' },
    payloadHash: '44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072',
    region: 'us-east-1',
    now: new Date('2013-05-24T00:00:00Z'),
    ...S3DOC
  })
  assert.equal(firma(h.authorization),
    '98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd')
  assert.equal(h._canonicalRequest.split('\n')[1], '/test%24file.text', 'el `$` va escapado en la ruta')
})

test('la query se ordena y se escapa antes de firmar', () => {
  const h = signRequest({
    method: 'GET',
    url: 'https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J',
    region: 'us-east-1',
    now: new Date('2013-05-24T00:00:00Z'),
    ...S3DOC
  })
  assert.equal(firma(h.authorization),
    '34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7')
})

test('uriEncode es la de AWS, no la de encodeURIComponent', () => {
  // `encodeURIComponent` deja pasar estos cinco, y AWS los quiere escapados. Una
  // sola diferencia y el servidor contesta «SignatureDoesNotMatch» sin decir por qué.
  assert.equal(uriEncode("!'()*"), '%21%27%28%29%2A')
  assert.equal(uriEncode('a b'), 'a%20b', 'el espacio es %20, nunca +')
  assert.equal(uriEncode('a-b_c.d~e'), 'a-b_c.d~e', 'los no reservados no se tocan')
  assert.equal(uriEncode('a/b'), 'a%2Fb')
  assert.equal(uriEncode('a/b', false), 'a/b', 'en la ruta, la barra se queda')
  assert.equal(uriEncode('ñ'), '%C3%B1', 'y se codifica UTF-8, no el code point')
})

test('la fecha va en los dos formatos que pide la firma', () => {
  assert.deepEqual(amzDate(new Date('2015-08-30T12:36:00Z')),
    { amz: '20150830T123600Z', day: '20150830' })
})
