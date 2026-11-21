import { createServer, type IncomingMessage, type Server } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SignatureV4 } from '@smithy/signature-v4'
import { Hash } from '@smithy/hash-node'

import type { Project } from '../../shared/projects'
import type { ProjectFileItem } from '../../shared/project-files'
import type { S3SyncStatus } from '../../shared/s3-sync'
import { S3UploadService } from './upload-service'

vi.mock('../settings/crypto', () => ({
  decryptKey: (ref: string) => ref.replace('ref:', '')
}))

const CREDENTIALS = {
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY'
}
const BUCKET = 'e2e-bucket'
const REGION = 'us-east-1'

// A minimal S3-compatible object store: verifies the SigV4 signature on every request with the
// AWS SDK reference signer, then persists objects into a Map keyed by `bucket/key`.
const startSignatureCheckingS3 = () => {
  const objects = new Map<string, Buffer>()
  const inFlight = { current: 0, max: 0 }
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const body = Buffer.concat(chunks)
    const authorized = await signatureMatches(req, body)
    if (!authorized) {
      res.writeHead(403, { 'content-type': 'application/xml' })
      res.end('<Error><Code>SignatureDoesNotMatch</Code></Error>')
      return
    }
    if (req.method === 'PUT') {
      inFlight.current += 1
      inFlight.max = Math.max(inFlight.max, inFlight.current)
      await new Promise((resolve) => setTimeout(resolve, 10))
      inFlight.current -= 1
      objects.set(decodeURIComponent(req.url ?? ''), body)
      res.writeHead(200).end('')
      return
    }
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/xml' })
      res.end('<?xml version="1.0"?><ListBucketResult></ListBucketResult>')
      return
    }
    res.writeHead(400).end('<Error><Code>BadRequest</Code></Error>')
  })
  return new Promise<{
    server: Server
    endpoint: string
    objects: Map<string, Buffer>
    inFlight: { current: number; max: number }
  }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({ server, endpoint: `http://127.0.0.1:${port}`, objects, inFlight })
    })
  })
}

// Re-signs the received request with the AWS SDK signer; true when the client's Authorization
// header matches what AWS's own implementation would have produced for the same bytes.
const signatureMatches = async (
  req: IncomingMessage,
  _body: Buffer
): Promise<boolean> => {
  const parsed = new URL(req.url ?? '/', 'http://placeholder')
  const decodedPath = parsed.pathname
    .split('/')
    .map((segment) => decodeURIComponent(segment))
    .join('/')
  const query: Record<string, string> = {}
  parsed.searchParams.forEach((value, name) => {
    query[name] = value
  })
  const host = String(req.headers.host)
  const [hostname, portText] = host.split(':')
  const amzDate = String(req.headers['x-amz-date'])
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
    region: REGION,
    credentials: CREDENTIALS,
    sha256: Hash.bind(null, 'SHA256')
  })
  const signed = await signer.sign(
    {
      method: req.method ?? 'GET',
      protocol: 'http:',
      hostname: hostname!,
      ...(portText ? { port: Number(portText) } : {}),
      path: decodedPath,
      query,
      headers: {
        host,
        'x-amz-content-sha256': String(req.headers['x-amz-content-sha256'])
      }
    },
    { signingDate }
  )
  return req.headers.authorization === signed.headers.authorization
}

describe('S3UploadService end-to-end (real client + real signer, signature-verifying server)', () => {
  const roots: string[] = []
  const servers: Server[] = []
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
    for (const server of servers.splice(0)) server.close()
  })

  it('serially PUTs every project file to the custom endpoint under the configured prefix', async () => {
    const fake = await startSignatureCheckingS3()
    servers.push(fake.server)

    const root = mkdtempSync(join(tmpdir(), 's3-e2e-'))
    roots.push(root)
    const ledgerPath = join(root, 'ledger.json')
    const fileA = join(root, 'a report.csv')
    const fileB = join(root, 'b.txt')
    writeFileSync(fileA, 'col1,col2\n1,2')
    writeFileSync(fileB, 'second file')

    const project: Project = {
      id: 'proj-e2e',
      name: 'E2E',
      description: '',
      isExample: false,
      s3AutoUpload: true,
      createdAt: 1,
      updatedAt: 1
    }
    const items: ProjectFileItem[] = [
      {
        id: 'fa:v1',
        source: 'upload',
        sourceFileId: 'fa',
        sourceVersionId: 'v1',
        projectId: project.id,
        sessionId: 's1',
        name: 'a report.csv',
        path: fileA,
        size: 12,
        sortAtMs: 1
      },
      {
        id: 'fb:v1',
        source: 'artifact',
        sourceFileId: 'fb',
        sourceVersionId: 'v1',
        projectId: project.id,
        sessionId: 's1',
        name: 'b.txt',
        path: fileB,
        size: 11,
        sortAtMs: 2
      }
    ]
    const statuses: S3SyncStatus[] = []
    const endpoint = fake.endpoint
    const service = new S3UploadService(
      {
        getS3Settings: async () => ({
          endpoint,
          region: REGION,
          bucket: BUCKET,
          accessKeyId: CREDENTIALS.accessKeyId,
          secretKeyRef: `ref:${CREDENTIALS.secretAccessKey}`,
          pathPrefix: 'client-a/',
          enabled: true
        }),
        getProject: async () => project,
        listProjects: async () => [project],
        listFiles: async () => ({ items }),
        readFileContent: async (item) => readFileSync(item.path),
        publish: (status) => statuses.push(status)
        // no createClient override — exercises the real S3Client + signS3Request
      },
      ledgerPath
    )

    service.notifyProjectFilesChanged(project.id)
    await service.whenIdle()

    // One object in flight at any moment — serial uploads.
    expect(fake.inFlight.max).toBe(1)
    // Both files landed under the prefix with the deterministic key layout; the fake server
    // decodes the wire path, so `a%20report.csv` on the wire arrives as `a report.csv`.
    const keys = [...fake.objects.keys()].sort()
    expect(keys).toEqual([
      `/${BUCKET}/client-a/projects/E2E-proj-e2e/artifact/fb/v1/b.txt`,
      `/${BUCKET}/client-a/projects/E2E-proj-e2e/upload/fa/v1/a report.csv`
    ])
    expect(fake.objects.get(`/${BUCKET}/client-a/projects/E2E-proj-e2e/upload/fa/v1/a report.csv`)?.toString()).toBe(
      'col1,col2\n1,2'
    )
    // The durable ledger records the upload so a restart skips it.
    const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8')) as {
      objects: Record<string, { objectKey: string; sourceVersionId: string }>
    }
    expect(ledger.objects['upload/fa']?.objectKey).toBe(
      'client-a/projects/E2E-proj-e2e/upload/fa/v1/a report.csv'
    )
    // Final status is idle with a lastUploadedAt marker.
    expect(statuses.at(-1)).toMatchObject({ projectId: project.id, pending: 0 })
    expect(statuses.at(-1)?.lastUploadedAt).toBeDefined()
    expect(statuses.at(-1)?.lastError).toBeUndefined()
  })
})
