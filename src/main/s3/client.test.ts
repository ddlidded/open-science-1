import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it, afterEach } from 'vitest'
import { SignatureV4 } from '@smithy/signature-v4'
import { Hash } from '@smithy/hash-node'

import { S3Client } from './client'

const CREDENTIALS = {
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY'
}

type ReceivedRequest = {
  method: string
  url: string
  headers: IncomingMessage['headers']
  body: Buffer
}

// An S3-shaped local server. The handler re-signs the received request with the AWS SDK reference
// signer and 401s on a mismatch — proving the bytes on the wire are exactly what was signed.
const startFakeS3 = (
  onRequest: (request: ReceivedRequest) => { status: number; body?: string } | Promise<{ status: number; body?: string }>
): Promise<{ server: Server; endpoint: string }> =>
  new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      const received: ReceivedRequest = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks)
      }
      try {
        const outcome = await onRequest(received)
        res.writeHead(outcome.status, { 'content-type': 'application/xml' })
        res.end(outcome.body ?? '')
      } catch (error) {
        res.writeHead(500, { 'content-type': 'application/xml' })
        res.end(`<Error><Message>${String(error)}</Message></Error>`)
      }
    })
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({ server, endpoint: `http://127.0.0.1:${port}` })
    })
  })

// Recomputes the expected Authorization header from the raw request the client actually sent.
const expectedAuthorization = async (received: ReceivedRequest, region: string): Promise<string> => {
  const parsed = new URL(received.url, 'http://placeholder')
  const decodedPath = parsed.pathname
    .split('/')
    .map((segment) => decodeURIComponent(segment))
    .join('/')
  const query: Record<string, string> = {}
  parsed.searchParams.forEach((value, name) => {
    query[name] = value
  })
  const host = String(received.headers.host)
  const [hostname, portText] = host.split(':')
  // Reconstruct the client's signing instant; smithy regenerates x-amz-date from it.
  const amzDate = String(received.headers['x-amz-date'])
  const signingDate = new Date(
    Date.UTC(
      Number(amzDate.slice(0, 4)),
      Number(amzDate.slice(4, 6)) - 1,
      Number(amzDate.slice(6, 8)),
      Number(amzDate.slice(9, 11)),
      Number(amzDate.slice(11, 13)),
      Number(amzDate.slice(13, 15))
    )
  )
  const signer = new SignatureV4({
    service: 's3',
    region,
    credentials: CREDENTIALS,
    sha256: Hash.bind(null, 'SHA256')
  })
  const signed = await signer.sign(
    {
      method: received.method,
      protocol: 'http:',
      hostname: hostname!,
      ...(portText ? { port: Number(portText) } : {}),
      path: decodedPath,
      query,
      headers: {
        host,
        'x-amz-content-sha256': String(received.headers['x-amz-content-sha256'])
      }
    },
    { signingDate }
  )
  return signed.headers.authorization as string
}

describe('S3Client', () => {
  const servers: Server[] = []
  afterEach(() => {
    for (const server of servers.splice(0)) server.close()
  })

  it('PUTs an object to the path-style bucket URL with a valid SigV4 signature', async () => {
    const received: ReceivedRequest[] = []
    const { server, endpoint } = await startFakeS3(async (request) => {
      received.push(request)
      const expected = await expectedAuthorization(request, 'eu-west-1')
      if (request.headers.authorization !== expected) {
        return { status: 401, body: '<Error><Code>SignatureDoesNotMatch</Code></Error>' }
      }
      return { status: 200, body: '' }
    })
    servers.push(server)

    const client = new S3Client({
      endpoint,
      region: 'eu-west-1',
      bucket: 'data-bucket',
      ...CREDENTIALS
    })
    await client.putObject('proj-1/upload/file-1/v1/report final.csv', Buffer.from('payload-bytes'))

    expect(received).toHaveLength(1)
    const request = received[0]!
    expect(request.method).toBe('PUT')
    expect(request.url).toBe('/data-bucket/proj-1/upload/file-1/v1/report%20final.csv')
    expect(request.body.toString()).toBe('payload-bytes')
    expect(request.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 /)
  })

  it('testConnection lists the bucket with max-keys=1 and reports failures', async () => {
    const urls: string[] = []
    const { server, endpoint } = await startFakeS3(async (request) => {
      urls.push(request.url)
      const expected = await expectedAuthorization(request, 'us-east-1')
      if (request.headers.authorization !== expected) {
        return { status: 403, body: '<Error><Code>SignatureDoesNotMatch</Code></Error>' }
      }
      return {
        status: 200,
        body: '<?xml version="1.0"?><ListBucketResult></ListBucketResult>'
      }
    })
    servers.push(server)

    const client = new S3Client({ endpoint, bucket: 'check-me', ...CREDENTIALS })
    const ok = await client.testConnection()
    expect(ok).toEqual({ ok: true })
    expect(urls).toEqual(['/check-me?list-type=2&max-keys=1'])

    const failing = await startFakeS3(async () => ({
      status: 403,
      body: '<Error><Code>AccessDenied</Code><Message>nope</Message></Error>'
    }))
    servers.push(failing.server)
    const denied = new S3Client({
      endpoint: failing.endpoint,
      bucket: 'check-me',
      ...CREDENTIALS
    })
    const result = await denied.testConnection()
    expect(result.ok).toBe(false)
    expect(result.error).toContain('AccessDenied')
  })

  it('surfaces a descriptive error when the server rejects the upload', async () => {
    const { server, endpoint } = await startFakeS3(() => ({
      status: 403,
      body: '<Error><Code>AccessDenied</Code><Message>denied by policy</Message></Error>'
    }))
    servers.push(server)
    const client = new S3Client({ endpoint, bucket: 'b', ...CREDENTIALS })
    await expect(client.putObject('k', Buffer.from('x'))).rejects.toThrow(
      /AccessDenied: denied by policy/
    )
  })

  it('listFolders sends prefix + delimiter and parses folders, files, and truncation', async () => {
    const received: ReceivedRequest[] = []
    const { server, endpoint } = await startFakeS3(async (request) => {
      received.push(request)
      const expected = await expectedAuthorization(request, 'us-east-1')
      if (request.headers.authorization !== expected) {
        return { status: 401, body: '<Error><Code>SignatureDoesNotMatch</Code></Error>' }
      }
      return {
        status: 200,
        body: [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<ListBucketResult>',
          '<IsTruncated>true</IsTruncated>',
          '<CommonPrefixes><Prefix>base/reports/</Prefix></CommonPrefixes>',
          '<CommonPrefixes><Prefix>base/data &amp; figures/</Prefix></CommonPrefixes>',
          '<Contents><Key>base/read me.txt</Key></Contents>',
          '<Contents><Key>base/run&amp;2.csv</Key></Contents>',
          '</ListBucketResult>'
        ].join('')
      }
    })
    servers.push(server)

    const client = new S3Client({
      endpoint,
      region: 'us-east-1',
      bucket: 'data-bucket',
      ...CREDENTIALS
    })
    const listing = await client.listFolders('base/')

    expect(received).toHaveLength(1)
    const request = received[0]!
    expect(request.method).toBe('GET')
    expect(request.url).toContain('/data-bucket?')
    expect(request.url).toContain('list-type=2')
    expect(request.url).toContain('delimiter=%2F')
    expect(request.url).toContain('prefix=base%2F')
    expect(request.url).toContain('max-keys=1000')
    expect(listing).toEqual({
      folders: ['base/reports/', 'base/data & figures/'],
      files: ['base/read me.txt', 'base/run&2.csv'],
      truncated: true
    })
  })

  it('listFolders handles an empty bucket listing', async () => {
    const { server, endpoint } = await startFakeS3(() => ({
      status: 200,
      body: '<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>'
    }))
    servers.push(server)
    const client = new S3Client({ endpoint, bucket: 'b', ...CREDENTIALS })
    await expect(client.listFolders('')).resolves.toEqual({
      folders: [],
      files: [],
      truncated: false
    })
  })

  it('listFolders surfaces a descriptive error on rejection', async () => {
    const { server, endpoint } = await startFakeS3(() => ({
      status: 404,
      body: '<Error><Code>NoSuchBucket</Code><Message>gone</Message></Error>'
    }))
    servers.push(server)
    const client = new S3Client({ endpoint, bucket: 'b', ...CREDENTIALS })
    await expect(client.listFolders('x/')).rejects.toThrow(/NoSuchBucket: gone/)
  })
})
