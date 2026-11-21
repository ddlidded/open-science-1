import { createHash, createHmac } from 'node:crypto'

// Minimal AWS Signature Version 4 signer for S3 REST calls (path-style addressing). Implemented
// locally so custom S3-compatible endpoints (MinIO, Cloudflare R2, Ceph, ...) work without pulling
// the full AWS SDK — the requests needed here are PUT object and a bounded ListObjectsV2 probe.

const sha256Hex = (data: string | Buffer): string =>
  createHash('sha256').update(data).digest('hex')

const hmacSha256 = (key: Buffer | string, data: string): Buffer =>
  createHmac('sha256', key).update(data).digest()

// RFC 3986 encoding as S3 requires: unreserved characters only, everything else percent-encoded.
const uriEncode = (value: string): string =>
  encodeURIComponent(value).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  )

// Encodes each object-key segment while preserving '/' separators.
const encodeS3Path = (key: string): string =>
  key
    .split('/')
    .map((segment) => uriEncode(segment))
    .join('/')

const buildCanonicalQueryString = (params: Record<string, string>): string =>
  Object.keys(params)
    .sort()
    .map((name) => `${uriEncode(name)}=${uriEncode(params[name]!)}`)
    .join('&')

export type SignedS3Request = {
  authorization: string
  amzDate: string
  payloadHash: string
  // Percent-encoded request-target components, ready to append to the endpoint origin. Signing and
  // sending the identical bytes is required — re-encoding through URL normalization can differ.
  canonicalUri: string
  canonicalQueryString: string
}

// Produces the Authorization header, x-amz-date and content hash for one request.
export const signS3Request = (input: {
  method: 'GET' | 'PUT' | 'HEAD' | 'DELETE'
  host: string
  // Absolute request path WITHOUT the leading-slash normalization applied here (e.g. 'bucket/key').
  path: string
  query?: Record<string, string>
  payloadHash?: string
  region: string
  accessKeyId: string
  secretAccessKey: string
  now?: Date
}): SignedS3Request => {
  const now = input.now ?? new Date()
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
  const dateStamp = amzDate.slice(0, 8)
  const payloadHash = input.payloadHash ?? sha256Hex('')

  const canonicalUri = `/${encodeS3Path(input.path.replace(/^\/+/, ''))}`
  const canonicalQueryString = buildCanonicalQueryString(input.query ?? {})

  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date'
  const canonicalHeaders =
    `host:${input.host}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${amzDate}\n`

  const canonicalRequest = [
    input.method,
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    payloadHash
  ].join('\n')

  const credentialScope = `${dateStamp}/${input.region}/s3/aws4_request`
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest)
  ].join('\n')

  const signingKey = hmacSha256(
    hmacSha256(hmacSha256(hmacSha256(`AWS4${input.secretAccessKey}`, dateStamp), input.region), 's3'),
    'aws4_request'
  )
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex')

  return {
    authorization:
      `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${credentialScope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    amzDate,
    payloadHash,
    canonicalUri,
    canonicalQueryString
  }
}

export { encodeS3Path, sha256Hex }
