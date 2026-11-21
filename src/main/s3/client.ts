import { sha256Hex, signS3Request } from './sigv4'

export type S3ClientConfig = {
  endpoint: string
  region?: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  // Injectable for tests; defaults to the platform fetch (undici in Electron main).
  fetchImpl?: typeof fetch
}

const DEFAULT_REGION = 'us-east-1'
const REQUEST_TIMEOUT_MS = 30_000

const decodeXmlEntities = (value: string): string =>
  value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')

// Captures the first `<inner>` inside every `<outer>` block; nested tags in the block are allowed.
const extractXmlBlocks = (xml: string, outer: string, inner: string): string[] => {
  const values: string[] = []
  const pattern = new RegExp(`<${outer}>[\\s\\S]*?<${inner}>([^<]*)</${inner}>`, 'g')
  let match = pattern.exec(xml)
  while (match) {
    values.push(decodeXmlEntities(match[1] ?? ''))
    match = pattern.exec(xml)
  }
  return values
}

const extractXmlValues = (xml: string, tag: string): string[] => {
  const values: string[] = []
  const pattern = new RegExp(`<${tag}>([^<]*)</${tag}>`, 'g')
  let match = pattern.exec(xml)
  while (match) {
    values.push(decodeXmlEntities(match[1] ?? ''))
    match = pattern.exec(xml)
  }
  return values
}

// Extracts S3's XML error fields when present; falls back to the raw status line.
const describeFailure = (status: number, body: string): string => {
  const code = body.match(/<Code>([^<]+)<\/Code>/)?.[1]
  const message = body.match(/<Message>([^<]+)<\/Message>/)?.[1]
  if (code && message) return `${code}: ${message}`
  if (code) return code
  return `HTTP ${status}`
}

// Small S3 REST client using path-style URLs so any S3-compatible endpoint works, including servers
// whose buckets have no virtual-host DNS records.
export class S3Client {
  private readonly endpoint: URL
  private readonly region: string
  private readonly bucket: string
  private readonly accessKeyId: string
  private readonly secretAccessKey: string
  private readonly fetchImpl: typeof fetch

  constructor(config: S3ClientConfig) {
    const endpoint = new URL(config.endpoint.trim())
    if (endpoint.protocol !== 'https:' && endpoint.protocol !== 'http:') {
      throw new Error('S3 endpoint must use http:// or https://.')
    }
    this.endpoint = endpoint
    this.region = config.region?.trim() || DEFAULT_REGION
    this.bucket = config.bucket.trim()
    this.accessKeyId = config.accessKeyId
    this.secretAccessKey = config.secretAccessKey
    this.fetchImpl = config.fetchImpl ?? fetch
  }

  private async request(input: {
    method: 'GET' | 'PUT' | 'HEAD' | 'DELETE'
    path: string
    query?: Record<string, string>
    body?: Buffer
  }): Promise<{ status: number; body: string }> {
    const payloadHash = sha256Hex(input.body ?? '')
    const host = this.endpoint.port
      ? `${this.endpoint.hostname}:${this.endpoint.port}`
      : this.endpoint.hostname
    const basePath = this.endpoint.pathname.replace(/\/+$/, '')
    const signed = signS3Request({
      method: input.method,
      host,
      path: `${basePath}/${input.path}`,
      query: input.query,
      payloadHash,
      region: this.region,
      accessKeyId: this.accessKeyId,
      secretAccessKey: this.secretAccessKey
    })

    // Send the identical request-target that was signed.
    const url =
      `${this.endpoint.origin}${signed.canonicalUri}` +
      (signed.canonicalQueryString ? `?${signed.canonicalQueryString}` : '')

    const response = await this.fetchImpl(url, {
      method: input.method,
      headers: {
        authorization: signed.authorization,
        'x-amz-content-sha256': signed.payloadHash,
        'x-amz-date': signed.amzDate
      },
      body: input.body ? new Uint8Array(input.body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
    const body = await response.text()
    return { status: response.status, body }
  }

  // Validates endpoint reachability, credentials and bucket access in one cheap call.
  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    try {
      const result = await this.request({
        method: 'GET',
        path: this.bucket,
        query: { 'list-type': '2', 'max-keys': '1' }
      })
      if (result.status >= 200 && result.status < 300) return { ok: true }
      return { ok: false, error: describeFailure(result.status, result.body) }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  // Lists one level of the bucket: sub-"folders" (CommonPrefixes) and object keys directly under
  // `prefix`. Uses delimiter='/' so servers return a directory-style view.
  async listFolders(
    prefix: string
  ): Promise<{ folders: string[]; files: string[]; truncated: boolean }> {
    const result = await this.request({
      method: 'GET',
      path: this.bucket,
      query: {
        'list-type': '2',
        delimiter: '/',
        prefix,
        'max-keys': '1000'
      }
    })
    if (result.status < 200 || result.status >= 300) {
      throw new Error(`S3 listing failed: ${describeFailure(result.status, result.body)}`)
    }
    const folders = extractXmlBlocks(result.body, 'CommonPrefixes', 'Prefix')
    const contents = extractXmlBlocks(result.body, 'Contents', 'Key')
    const truncated = extractXmlValues(result.body, 'IsTruncated')[0] === 'true'
    return { folders, files: contents, truncated }
  }

  async putObject(key: string, body: Buffer): Promise<void> {
    const result = await this.request({
      method: 'PUT',
      path: `${this.bucket}/${key}`,
      body
    })
    if (result.status < 200 || result.status >= 300) {
      throw new Error(`S3 upload failed: ${describeFailure(result.status, result.body)}`)
    }
  }
}
