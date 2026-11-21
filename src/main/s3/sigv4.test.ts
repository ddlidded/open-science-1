import { describe, expect, it } from 'vitest'
import { SignatureV4 } from '@smithy/signature-v4'
import { Hash } from '@smithy/hash-node'

import { encodeS3Path, sha256Hex, signS3Request } from './sigv4'

const CREDENTIALS = {
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY'
}
const FIXED_NOW = new Date('2024-01-15T10:30:45.000Z')

// Independently signs the same request with the AWS SDK's reference signer and compares the
// Authorization header byte-for-byte — catches canonicalization bugs a self-check cannot.
const smithySign = async (input: {
  method: 'GET' | 'PUT'
  hostname: string
  port?: number
  path: string
  query?: Record<string, string>
  payloadHash: string
}) => {
  const signer = new SignatureV4({
    service: 's3',
    region: 'us-east-1',
    credentials: CREDENTIALS,
    sha256: Hash.bind(null, 'SHA256')
  })
  const host = input.port ? `${input.hostname}:${input.port}` : input.hostname
  const signed = await signer.sign(
    {
      method: input.method,
      protocol: 'https:',
      hostname: input.hostname,
      ...(input.port ? { port: input.port } : {}),
      path: input.path,
      query: input.query,
      headers: {
        host,
        'x-amz-content-sha256': input.payloadHash
      }
    },
    { signingDate: FIXED_NOW }
  )
  return signed.headers.authorization
}

describe('signS3Request', () => {
  it('matches the AWS SDK signature for a simple PUT', async () => {
    const payloadHash = sha256Hex('hello world')
    const signed = signS3Request({
      method: 'PUT',
      host: 's3.example.com',
      path: 'my-bucket/dir/object.txt',
      payloadHash,
      region: 'us-east-1',
      ...CREDENTIALS,
      now: FIXED_NOW
    })
    const reference = await smithySign({
      method: 'PUT',
      hostname: 's3.example.com',
      path: '/my-bucket/dir/object.txt',
      payloadHash
    })
    expect(signed.authorization).toBe(reference)
    expect(signed.authorization).toContain('Credential=AKIDEXAMPLE/20240115/us-east-1/s3/aws4_request')
    expect(signed.authorization).toContain('SignedHeaders=host;x-amz-content-sha256;x-amz-date')
    expect(signed.amzDate).toBe('20240115T103045Z')
  })

  it('matches the AWS SDK signature with a custom port and query string', async () => {
    const signed = signS3Request({
      method: 'GET',
      host: 'localhost:9000',
      path: 'my-bucket',
      query: { 'list-type': '2', 'max-keys': '1' },
      region: 'us-east-1',
      ...CREDENTIALS,
      now: FIXED_NOW
    })
    const reference = await smithySign({
      method: 'GET',
      hostname: 'localhost',
      port: 9000,
      path: '/my-bucket',
      query: { 'list-type': '2', 'max-keys': '1' },
      payloadHash: sha256Hex('')
    })
    expect(signed.authorization).toBe(reference)
  })

  it('matches the AWS SDK signature for keys needing percent-encoding', async () => {
    const signed = signS3Request({
      method: 'PUT',
      host: 'minio.local:9000',
      path: 'bucket/prefix/a file (v2) [final].csv',
      payloadHash: sha256Hex('x'),
      region: 'eu-west-1',
      ...CREDENTIALS,
      now: FIXED_NOW
    })
    const signer = new SignatureV4({
      service: 's3',
      region: 'eu-west-1',
      credentials: CREDENTIALS,
      sha256: Hash.bind(null, 'SHA256')
    })
    const reference = await signer.sign(
      {
        method: 'PUT',
        protocol: 'https:',
        hostname: 'minio.local',
        port: 9000,
        path: '/bucket/prefix/a file (v2) [final].csv',
        headers: {
          host: 'minio.local:9000',
          'x-amz-content-sha256': sha256Hex('x')
        }
      },
      { signingDate: FIXED_NOW }
    )
    expect(signed.authorization).toBe(reference.headers.authorization)
  })
})

describe('encodeS3Path', () => {
  it('preserves separators and encodes reserved characters', () => {
    expect(encodeS3Path('a/b c/(d).txt')).toBe('a/b%20c/%28d%29.txt')
    expect(encodeS3Path("o'k!.txt")).toBe('o%27k%21.txt')
    expect(encodeS3Path('plain-name_1.2~3')).toBe('plain-name_1.2~3')
  })
})
