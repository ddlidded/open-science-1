import { z } from 'zod'

// S3 (S3-compatible object storage) auto-upload contracts shared by main, preload, and renderer.
//
// Settings live in settings.json under `s3`. The secret access key is stored as an encrypted ref
// (same convention as provider keyRef); the renderer only ever sees `hasSecretKey` and sends the
// plaintext `secretAccessKey` in a draft only while the user is actively typing a new one.

export const s3SettingsSchema = z
  .object({
    // Any S3-compatible endpoint, e.g. https://s3.us-east-1.amazonaws.com or a self-hosted MinIO
    // URL. Path-style addressing is used so self-hosted servers and buckets without DNS records work.
    endpoint: z.string().trim().min(1),
    // Signature region; most S3-compatible servers ignore it but AWS requires a real one.
    region: z.string().trim().min(1).optional(),
    bucket: z.string().trim().min(1),
    accessKeyId: z.string().trim().min(1),
    secretKeyRef: z.string().optional(),
    // Optional key prefix (e.g. "backups/"). Objects land at
    // <prefix><projectId>/<source>/<fileId>/<versionId>/<filename>.
    pathPrefix: z.string().optional(),
    enabled: z.boolean().optional()
  })
  .strict()

// Renderer-facing projection: the secret is reduced to a presence flag.
export const s3SettingsViewSchema = z
  .object({
    endpoint: z.string(),
    region: z.string().optional(),
    bucket: z.string(),
    accessKeyId: z.string(),
    hasSecretKey: z.boolean(),
    pathPrefix: z.string().optional(),
    enabled: z.boolean().optional()
  })
  .strict()

// Draft as entered in the settings form. A missing secretAccessKey keeps the stored key.
export const s3SettingsDraftSchema = z
  .object({
    endpoint: z.string().trim().optional(),
    region: z.string().trim().optional(),
    bucket: z.string().trim().optional(),
    accessKeyId: z.string().trim().optional(),
    secretAccessKey: z.string().optional(),
    pathPrefix: z.string().optional(),
    enabled: z.boolean().optional(),
    // Clears the configured endpoint/bucket/keys entirely.
    reset: z.boolean().optional()
  })
  .strict()

export const s3TestConnectionResultSchema = z
  .object({
    ok: z.boolean(),
    error: z.string().optional()
  })
  .strict()

// Progress projection for the per-project serial uploader, broadcast on 's3-sync:changed'.
export const s3SyncStatusSchema = z
  .object({
    projectId: z.string(),
    pending: z.number().int().nonnegative(),
    active: z.string().optional(),
    lastError: z.string().optional(),
    lastUploadedAt: z.number().finite().optional()
  })
  .strict()

// One level of "folders" inside the configured bucket, listed with ListObjectsV2 + delimiter '/'.
// Returned prefixes are full key prefixes ending in '/', relative to the configured pathPrefix —
// e.g. browsing '' returns 'reports/' when the bucket holds reports/… objects.
export const s3FolderListingSchema = z
  .object({
    // The prefix that was browsed (normalized, '' for the root).
    prefix: z.string(),
    folders: z.array(z.string()),
    // Object keys directly inside this prefix (files, not folders), capped server-side.
    files: z.array(z.string()),
    truncated: z.boolean().optional()
  })
  .strict()

// Manual upload of selected project files into a user-chosen destination prefix.
export const s3UploadFilesRequestSchema = z
  .object({
    projectId: z.string().trim().min(1),
    fileIds: z.array(z.string().min(1)).min(1),
    // Destination folder inside the bucket, appended to the configured pathPrefix.
    // '' means the prefix root; a trailing '/' is implied.
    prefix: z.string().max(900)
  })
  .strict()

export const s3UploadFilesResultSchema = z
  .object({
    queued: z.number().int().nonnegative()
  })
  .strict()

// Create a folder marker inside the bucket, appended to the configured pathPrefix.
// '..' segments are rejected so the marker always lands inside pathPrefix.
export const s3CreateFolderRequestSchema = z
  .object({
    prefix: z
      .string()
      .trim()
      .min(1)
      .max(900)
      .refine((value) => !/(^|\/)\.\.(\/|$)/.test(value), { message: 'Invalid folder path.' })
  })
  .strict()

export type S3Settings = z.infer<typeof s3SettingsSchema>
export type S3SettingsView = z.infer<typeof s3SettingsViewSchema>
export type S3SettingsDraft = z.infer<typeof s3SettingsDraftSchema>
export type S3TestConnectionResult = z.infer<typeof s3TestConnectionResultSchema>
export type S3SyncStatus = z.infer<typeof s3SyncStatusSchema>
export type S3FolderListing = z.infer<typeof s3FolderListingSchema>
export type S3UploadFilesRequest = z.infer<typeof s3UploadFilesRequestSchema>
export type S3UploadFilesResult = z.infer<typeof s3UploadFilesResultSchema>
export type S3CreateFolderRequest = z.infer<typeof s3CreateFolderRequestSchema>