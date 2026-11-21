import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { Project } from '../../shared/projects'
import type { ProjectFileItem } from '../../shared/project-files'
import type { S3Settings, S3SyncStatus } from '../../shared/s3-sync'
import { S3Client } from './client'
import { decryptKey } from '../settings/crypto'

type LedgerRecord = {
  objectKey: string
  sourceVersionId: string
  size: number
  uploadedAt: number
}

type LedgerFailure = {
  error: string
  attempts: number
  lastAt: number
}

// Persisted per project: which (sourceFileId) → object version has already been uploaded, plus the
// failure window for items still awaiting a successful attempt. This is what makes restarts and
// repeated scans idempotent.
type Ledger = {
  objects: Record<string, LedgerRecord>
  failures: Record<string, LedgerFailure>
}

type UploadCandidate = {
  fileKey: string
  item: ProjectFileItem
  // Manual uploads go to a user-chosen destination prefix instead of the auto-sync key layout and
  // skip the durable ledger — they are one-shot, explicitly requested copies.
  destinationPrefix?: string
}

export type S3UploadServiceDeps = {
  getS3Settings: () => Promise<S3Settings | undefined>
  getProject: (projectId: string) => Promise<Project | null | undefined>
  listProjects: () => Promise<Project[]>
  listFiles: (projectId: string, cursor?: string) => Promise<{
    items: ProjectFileItem[]
    nextCursor?: string
  }>
  // item.path is an opaque version reference, not a filesystem path — bytes come from the
  // managed-file version store keyed on source/file/version ids.
  readFileContent: (item: ProjectFileItem) => Promise<Buffer>
  publish: (status: S3SyncStatus) => void
  createClient?: (
    settings: S3Settings,
    secretAccessKey: string
  ) => Pick<S3Client, 'putObject' | 'listFolders'>
  now?: () => number
  scheduleRetry?: (callback: () => void, delayMs: number) => void
}

const MAX_ATTEMPTS = 5
const RETRY_DELAY_MS = 30_000

const sanitizeKeySegment = (value: string): string =>
  value
    // eslint-disable-next-line no-control-regex
    .replace(/[-/\\]/g, '_')
    .slice(0, 200) || 'file'

const emptyLedger = (): Ledger => ({ objects: {}, failures: {} })

// Serial project-file → S3 uploader. Exactly one object is in flight at any moment: scans expand
// into per-file tasks on a single FIFO queue driven by one worker loop.
export class S3UploadService {
  private readonly deps: S3UploadServiceDeps
  private readonly ledgerPath: string
  private ledger: Ledger | undefined
  private ledgerWrite: Promise<void> = Promise.resolve()
  private scanQueue: string[] = []
  private readonly queuedProjects = new Set<string>()
  private uploadQueue: UploadCandidate[] = []
  private readonly statuses = new Map<string, S3SyncStatus>()
  private working = false
  private readonly now: () => number
  private readonly scheduleRetry: (callback: () => void, delayMs: number) => void

  constructor(deps: S3UploadServiceDeps, ledgerPath: string) {
    this.deps = deps
    this.ledgerPath = ledgerPath
    this.now = deps.now ?? Date.now
    this.scheduleRetry =
      deps.scheduleRetry ?? ((callback, delayMs) => setTimeout(callback, delayMs).unref?.())
  }

  // Called on 'project-files:changed' — enqueue a reconciliation pass for that project.
  notifyProjectFilesChanged(projectId: string): void {
    this.enqueueScan(projectId)
  }

  // Called on 'project:created' / 'project:updated'. Disabling clears queued work for that project.
  notifyProjectChanged(project: Project): void {
    if (project.s3AutoUpload) {
      this.enqueueScan(project.id)
      return
    }
    this.queuedProjects.delete(project.id)
    this.uploadQueue = this.uploadQueue.filter((task) => task.item.projectId !== project.id)
    this.updateStatus(project.id, (status) => ({ ...status, pending: 0, active: undefined }))
  }

  // Startup reconciliation: every enabled project is re-scanned so missed events and crash
  // recoveries converge to a fully uploaded state.
  async reconcileAll(): Promise<void> {
    const projects = await this.deps.listProjects()
    for (const project of projects) {
      if (project.s3AutoUpload) this.enqueueScan(project.id)
    }
  }

  getStatus(projectId: string): S3SyncStatus | undefined {
    const status = this.statuses.get(projectId)
    return status ? { ...status } : undefined
  }

  listStatuses(): S3SyncStatus[] {
    return [...this.statuses.values()].map((status) => ({ ...status }))
  }

  // Folder-style listing inside the configured bucket/pathPrefix for the destination picker.
  // `prefix` is relative to pathPrefix; returned folder names are relative to it as well.
  async listDestinationFolders(prefix: string): Promise<{
    prefix: string
    folders: string[]
    files: string[]
    truncated: boolean
  }> {
    const resolved = await this.resolveSettings()
    if (!resolved) {
      throw new Error('S3 storage is not configured.')
    }
    const base = normalizePrefix(resolved.settings.pathPrefix)
    const inside = `${base}${normalizePrefix(prefix)}`
    const client = this.createClient(resolved.settings, resolved.secretAccessKey)
    const listing = await client.listFolders(inside)
    const folders = listing.folders
      .filter((folder) => folder.startsWith(base))
      .map((folder) => folder.slice(base.length))
    const files = listing.files
      .filter((key) => key.startsWith(base))
      .map((key) => key.slice(base.length))
    return { prefix: normalizePrefix(prefix), folders, files, truncated: listing.truncated }
  }

  // Creates a folder marker object (`prefix/` with an empty body) inside the configured
  // bucket/pathPrefix so the destination picker can show folders before any file lands in them.
  async createDestinationFolder(prefix: string): Promise<void> {
    const resolved = await this.resolveSettings()
    if (!resolved) {
      throw new Error('S3 storage is not configured.')
    }
    const normalized = normalizePrefix(prefix)
    if (!normalized) {
      throw new Error('Folder name is required.')
    }
    const client = this.createClient(resolved.settings, resolved.secretAccessKey)
    await client.putObject(
      `${normalizePrefix(resolved.settings.pathPrefix)}${normalized}`,
      Buffer.alloc(0)
    )
  }

  // Enqueue an explicit, one-off upload of the given project files into `destinationPrefix`
  // (relative to the configured pathPrefix). Unlike auto-upload this does not require
  // s3AutoUpload on the project, does not consult the ledger, and does not retry — outcomes are
  // reported through the same s3-sync:changed status stream. Returns the number of requested
  // ids that resolved to indexed files.
  async uploadFilesManually(request: {
    projectId: string
    fileIds: string[]
    destinationPrefix: string
  }): Promise<{ queued: number }> {
    const wanted = new Set(request.fileIds)
    const destinationPrefix = normalizePrefix(request.destinationPrefix)
    const matched: UploadCandidate[] = []
    let cursor: string | undefined
    do {
      const page = await this.deps.listFiles(request.projectId, cursor)
      for (const item of page.items) {
        if (!wanted.has(item.id) || !item.path) continue
        matched.push({ fileKey: `manual/${item.id}`, item, destinationPrefix })
      }
      cursor = page.nextCursor
    } while (cursor && matched.length < wanted.size)
    if (matched.length === 0) return { queued: 0 }
    // Replace any still-queued manual task for the same file so repeated clicks don't duplicate.
    const manualKeys = new Set(matched.map((candidate) => candidate.fileKey))
    this.uploadQueue = this.uploadQueue.filter((task) => !manualKeys.has(task.fileKey))
    this.uploadQueue.push(...matched)
    this.updateStatus(request.projectId, (status) => ({
      ...status,
      pending: this.uploadQueue.filter((task) => task.item.projectId === request.projectId).length
    }))
    void this.pump()
    return { queued: matched.length }
  }

  // Exposed for tests/diagnostics: drains until the worker is idle.
  async whenIdle(): Promise<void> {
    while (this.working) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    await this.ledgerWrite
  }

  private enqueueScan(projectId: string): void {
    if (this.queuedProjects.has(projectId)) return
    this.queuedProjects.add(projectId)
    this.scanQueue.push(projectId)
    void this.pump()
  }

  private async loadLedger(): Promise<Ledger> {
    if (this.ledger) return this.ledger
    try {
      const parsed = JSON.parse(await readFile(this.ledgerPath, 'utf8')) as Partial<Ledger>
      this.ledger = {
        objects: parsed.objects ?? {},
        failures: parsed.failures ?? {}
      }
    } catch {
      this.ledger = emptyLedger()
    }
    return this.ledger
  }

  private saveLedger(): void {
    const snapshot = JSON.stringify(this.ledger ?? emptyLedger(), null, 2)
    this.ledgerWrite = this.ledgerWrite.then(async () => {
      await mkdir(dirname(this.ledgerPath), { recursive: true })
      const tmp = `${this.ledgerPath}.tmp`
      await writeFile(tmp, snapshot, 'utf8')
      await rename(tmp, this.ledgerPath)
    })
    void this.ledgerWrite.catch(() => undefined)
  }

  private updateStatus(
    projectId: string,
    update: (status: S3SyncStatus) => S3SyncStatus
  ): void {
    const current =
      this.statuses.get(projectId) ?? { projectId, pending: 0 }
    const next = update(current)
    this.statuses.set(projectId, next)
    this.deps.publish({ ...next })
  }

  private async resolveSettings(): Promise<
    { settings: S3Settings; secretAccessKey: string } | undefined
  > {
    const settings = await this.deps.getS3Settings()
    if (!settings || settings.enabled === false) return undefined
    if (!settings.endpoint || !settings.bucket || !settings.accessKeyId || !settings.secretKeyRef) {
      return undefined
    }
    let secretAccessKey: string
    try {
      secretAccessKey = decryptKey(settings.secretKeyRef)
    } catch {
      return undefined
    }
    if (!secretAccessKey) return undefined
    return { settings, secretAccessKey }
  }

  private async collectCandidates(projectId: string): Promise<UploadCandidate[]> {
    const ledger = await this.loadLedger()
    const candidates: UploadCandidate[] = []
    const seen = new Set<string>()
    let cursor: string | undefined
    do {
      const page = await this.deps.listFiles(projectId, cursor)
      for (const item of page.items) {
        if (!item.path || !item.sourceFileId || !item.sourceVersionId) continue
        const fileKey = `${item.source}/${item.sourceFileId}`
        if (seen.has(fileKey)) continue
        seen.add(fileKey)
        const recorded = ledger.objects[fileKey]
        if (recorded?.sourceVersionId === item.sourceVersionId) continue
        const failure = ledger.failures[fileKey]
        if (failure && failure.attempts >= MAX_ATTEMPTS) continue
        candidates.push({ fileKey, item })
      }
      cursor = page.nextCursor
    } while (cursor)
    return candidates
  }

  private objectKey(item: ProjectFileItem, prefix: string, project: Project): string {
    return (
      `${prefix}projects/${sanitizeKeySegment(project.name)}-${project.id}/` +
      `${sanitizeKeySegment(item.source)}/${sanitizeKeySegment(item.sourceFileId)}/` +
      `${sanitizeKeySegment(item.sourceVersionId)}/${sanitizeKeySegment(item.name)}`
    )
  }

  private async pump(): Promise<void> {
    if (this.working) return
    this.working = true
    try {
      for (;;) {
        // Expand pending scans first so the upload queue reflects the newest catalog state.
        const projectId = this.scanQueue.shift()
        if (projectId !== undefined) {
          this.queuedProjects.delete(projectId)
          await this.scanProject(projectId)
          continue
        }
        const task = this.uploadQueue.shift()
        if (!task) break
        await this.uploadOne(task)
      }
    } finally {
      this.working = false
      // A scan could have been enqueued while the finally ran; drain it.
      if (this.scanQueue.length > 0 || this.uploadQueue.length > 0) void this.pump()
    }
  }

  private async scanProject(projectId: string): Promise<void> {
    const resolved = await this.resolveSettings()
    if (!resolved) {
      this.updateStatus(projectId, (status) => ({ ...status, pending: 0, active: undefined }))
      return
    }
    const project = await this.deps.getProject(projectId)
    if (!project || !project.s3AutoUpload) {
      this.uploadQueue = this.uploadQueue.filter((task) => task.item.projectId !== projectId)
      this.updateStatus(projectId, (status) => ({ ...status, pending: 0, active: undefined }))
      return
    }
    const candidates = await this.collectCandidates(projectId)
    // Keep only one pending task per fileKey — newer scans replace older queued versions.
    const freshKeys = new Set(candidates.map((candidate) => candidate.fileKey))
    this.uploadQueue = this.uploadQueue.filter(
      (task) => task.item.projectId !== projectId || !freshKeys.has(task.fileKey)
    )
    this.uploadQueue.push(...candidates)
    this.updateStatus(projectId, (status) => ({
      ...status,
      pending: this.uploadQueue.filter((task) => task.item.projectId === projectId).length
    }))
  }

  private createClient(settings: S3Settings, secretAccessKey: string) {
    const factory =
      this.deps.createClient ??
      ((config, secret) =>
        new S3Client({
          endpoint: config.endpoint,
          region: config.region,
          bucket: config.bucket,
          accessKeyId: config.accessKeyId,
          secretAccessKey: secret
        }))
    return factory(settings, secretAccessKey)
  }

  private async uploadOne(task: UploadCandidate): Promise<void> {
    const { fileKey, item } = task
    const manual = task.destinationPrefix !== undefined
    const projectId = item.projectId
    this.updateStatus(projectId, (status) => ({
      ...status,
      active: item.name,
      pending: this.uploadQueue.filter((other) => other.item.projectId === projectId).length
    }))
    const ledger = manual ? undefined : await this.loadLedger()
    try {
      const resolved = await this.resolveSettings()
      const project = await this.deps.getProject(projectId)
      if (!resolved || !project || (!manual && !project.s3AutoUpload)) return
      // Skip files whose content became unavailable before the worker reached them.
      let body: Buffer
      try {
        body = await this.deps.readFileContent(item)
      } catch {
        if (ledger) {
          ledger.failures[fileKey] = {
            error: 'File is no longer available on disk.',
            attempts: (ledger.failures[fileKey]?.attempts ?? 0) + 1,
            lastAt: this.now()
          }
          this.saveLedger()
          this.updateStatus(projectId, (status) => ({
            ...status,
            lastError: ledger.failures[fileKey]!.error
          }))
        } else {
          this.updateStatus(projectId, (status) => ({
            ...status,
            active: undefined,
            lastError: 'File is no longer available on disk.'
          }))
        }
        return
      }
      const client = this.createClient(resolved.settings, resolved.secretAccessKey)
      const objectKey = manual
        ? `${normalizePrefix(resolved.settings.pathPrefix)}${task.destinationPrefix}${sanitizeKeySegment(item.name)}`
        : this.objectKey(item, normalizePrefix(resolved.settings.pathPrefix), project)
      await client.putObject(objectKey, body)
      if (ledger) {
        ledger.objects[fileKey] = {
          objectKey,
          sourceVersionId: item.sourceVersionId,
          size: body.length,
          uploadedAt: this.now()
        }
        delete ledger.failures[fileKey]
        this.saveLedger()
      }
      this.updateStatus(projectId, (status) => ({
        ...status,
        active: undefined,
        lastUploadedAt: this.now(),
        pending: this.uploadQueue.filter((other) => other.item.projectId === projectId).length
      }))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (ledger) {
        const previous = ledger.failures[fileKey]
        const attempts = (previous?.attempts ?? 0) + 1
        ledger.failures[fileKey] = { error: message, attempts, lastAt: this.now() }
        this.saveLedger()
        if (attempts < MAX_ATTEMPTS) {
          this.scheduleRetry(() => this.enqueueScan(projectId), RETRY_DELAY_MS)
        }
      }
      this.updateStatus(projectId, (status) => ({ ...status, active: undefined, lastError: message }))
    }
  }
}

const normalizePrefix = (prefix: string | undefined): string => {
  const trimmed = prefix?.trim().replace(/^\/+|\/+$/g, '') ?? ''
  return trimmed ? `${trimmed}/` : ''
}

export { MAX_ATTEMPTS as S3_UPLOAD_MAX_ATTEMPTS, normalizePrefix as normalizeS3Prefix }
