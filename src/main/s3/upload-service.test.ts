import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Project } from '../../shared/projects'
import type { ProjectFileItem, ProjectFileSource } from '../../shared/project-files'
import type { S3Settings, S3SyncStatus } from '../../shared/s3-sync'
import { S3UploadService, S3_UPLOAD_MAX_ATTEMPTS } from './upload-service'

// The service decrypts the stored key ref in production; tests substitute the raw secret value.
vi.mock('../settings/crypto', () => ({
  decryptKey: (ref: string) => ref.replace('ref:', '')
}))

const SETTINGS: S3Settings = {
  endpoint: 'http://s3.test',
  bucket: 'bucket-1',
  accessKeyId: 'ak',
  secretKeyRef: 'ref:secret',
  enabled: true
}

const project = (id: string, s3AutoUpload = true): Project => ({
  id,
  name: `P-${id}`,
  description: '',
  isExample: false,
  ...(s3AutoUpload ? { s3AutoUpload: true } : {}),
  createdAt: 1,
  updatedAt: 1
})

type PutCall = { key: string; body: string }

const item = (
  projectId: string,
  path: string,
  sourceFileId: string,
  sourceVersionId: string,
  name = 'file.txt',
  source: ProjectFileSource = 'upload'
): ProjectFileItem => ({
  id: `${sourceFileId}:${sourceVersionId}`,
  source,
  sourceFileId,
  sourceVersionId,
  projectId,
  sessionId: 'session-1',
  name,
  path,
  size: 1,
  sortAtMs: 1
})

type Harness = {
  service: S3UploadService
  puts: PutCall[]
  maxInFlight: { value: number }
  statuses: S3SyncStatus[]
  retries: { callback: () => void; delayMs: number }[]
  failKeys: Set<string>
  ledgerPath: string
  root: string
  // Writes a real file inside the harness root and returns an item pointing at it.
  file: (
    projectId: string,
    name: string,
    sourceFileId: string,
    sourceVersionId: string,
    content?: string,
    source?: ProjectFileSource
  ) => ProjectFileItem
}

const makeHarness = (overrides: {
  projects?: Record<string, Project>
  files?: Record<string, ProjectFileItem[]>
  settings?: S3Settings | undefined
  failKeys?: Set<string>
  ledgerPath?: string
  listing?: { folders: string[]; files: string[]; truncated: boolean }
}): Harness => {
  const root = mkdtempSync(join(tmpdir(), 's3-svc-'))
  const ledgerPath = overrides.ledgerPath ?? join(root, 'ledger.json')
  const puts: PutCall[] = []
  const statuses: S3SyncStatus[] = []
  const retries: { callback: () => void; delayMs: number }[] = []
  const failKeys = overrides.failKeys ?? new Set<string>()
  const maxInFlight = { value: 0 }
  let inFlight = 0
  let tick = 0

  const service = new S3UploadService(
    {
      getS3Settings: async () =>
        'settings' in overrides ? overrides.settings : SETTINGS,
      getProject: async (id) => overrides.projects?.[id] ?? null,
      listProjects: async () => Object.values(overrides.projects ?? {}),
      listFiles: async (projectId) => ({ items: overrides.files?.[projectId] ?? [] }),
      readFileContent: async (item) => readFileSync(item.path),
      publish: (status) => {
        statuses.push(status)
      },
      createClient: () => ({
        putObject: async (key: string, body: Buffer) => {
          inFlight += 1
          maxInFlight.value = Math.max(maxInFlight.value, inFlight)
          await new Promise((resolve) => setTimeout(resolve, 5))
          inFlight -= 1
          if (failKeys.has(key)) throw new Error('boom')
          puts.push({ key, body: body.toString() })
        },
        listFolders: async () => overrides.listing ?? { folders: [], files: [], truncated: false }
      }),
      now: () => ++tick,
      scheduleRetry: (callback, delayMs) => {
        retries.push({ callback, delayMs })
      }
    },
    ledgerPath
  )
  return {
    service,
    puts,
    maxInFlight,
    statuses,
    retries,
    failKeys,
    ledgerPath,
    root,
    file: (projectId, name, sourceFileId, sourceVersionId, content = name, source = 'upload') => {
      const path = join(root, `${sourceFileId}-${name}`)
      writeFileSync(path, content)
      return item(projectId, path, sourceFileId, sourceVersionId, name, source)
    }
  }
}

describe('S3UploadService', () => {
  const roots: string[] = []
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })
  const track = (harness: Harness): Harness => {
    roots.push(harness.root)
    return harness
  }

  it('uploads every indexed project file strictly one at a time', async () => {
    const harness = track(makeHarness({}))
    const files = [
      harness.file('p1', 'f0.txt', 'f0', 'v1'),
      harness.file('p1', 'f1.txt', 'f1', 'v1'),
      harness.file('p1', 'f2.txt', 'f2', 'v1')
    ]
    const h2 = track(
      makeHarness({
        projects: { p1: project('p1') },
        files: { p1: files },
        ledgerPath: harness.ledgerPath
      })
    )
    h2.service.notifyProjectFilesChanged('p1')
    await h2.service.whenIdle()

    expect(h2.maxInFlight.value).toBe(1)
    expect(h2.puts.map((put) => put.key)).toEqual([
      'projects/P_p1-p1/upload/f0/v1/f0.txt',
      'projects/P_p1-p1/upload/f1/v1/f1.txt',
      'projects/P_p1-p1/upload/f2/v1/f2.txt'
    ])
    expect(h2.puts[0]!.body).toBe('f0.txt')
  })

  it('applies the configured path prefix to object keys', async () => {
    const seed = track(makeHarness({}))
    const files = [seed.file('p1', 'n.txt', 'f', 'v', 'data')]
    const harness = track(
      makeHarness({
        projects: { p1: project('p1') },
        settings: { ...SETTINGS, pathPrefix: '/backups/' },
        files: { p1: files },
        ledgerPath: seed.ledgerPath
      })
    )
    harness.service.notifyProjectFilesChanged('p1')
    await harness.service.whenIdle()
    expect(harness.puts[0]?.key).toBe('backups/projects/P_p1-p1/upload/f/v/n.txt')
  })

  it('does not upload when the project opt-in is off', async () => {
    const seed = track(makeHarness({}))
    const files = [seed.file('p1', 'n.txt', 'f', 'v')]
    const harness = track(
      makeHarness({
        projects: { p1: project('p1', false) },
        files: { p1: files },
        ledgerPath: seed.ledgerPath
      })
    )
    harness.service.notifyProjectFilesChanged('p1')
    await harness.service.whenIdle()
    expect(harness.puts).toHaveLength(0)
  })

  it('does not upload when S3 settings are missing or disabled', async () => {
    for (const settings of [
      undefined,
      { ...SETTINGS, enabled: false },
      { ...SETTINGS, bucket: '' }
    ]) {
      const seed = track(makeHarness({}))
      const files = [seed.file('p1', 'n.txt', 'f', 'v')]
      const harness = track(
        makeHarness({
          projects: { p1: project('p1') },
          settings,
          files: { p1: files },
          ledgerPath: seed.ledgerPath
        })
      )
      harness.service.notifyProjectFilesChanged('p1')
      await harness.service.whenIdle()
      expect(harness.puts).toHaveLength(0)
    }
  })

  it('skips files already recorded for the same version (restart-safe idempotency)', async () => {
    const seed = track(makeHarness({}))
    const files = [seed.file('p1', 'n.txt', 'f1', 'v1', 'content')]
    const harness = track(
      makeHarness({
        projects: { p1: project('p1') },
        files: { p1: files },
        ledgerPath: seed.ledgerPath
      })
    )
    harness.service.notifyProjectFilesChanged('p1')
    await harness.service.whenIdle()
    expect(harness.puts).toHaveLength(1)

    // A second service over the same ledger simulates an app restart.
    const restarted = track(
      makeHarness({
        projects: { p1: project('p1') },
        files: { p1: files },
        ledgerPath: harness.ledgerPath
      })
    )
    restarted.service.notifyProjectFilesChanged('p1')
    await restarted.service.whenIdle()
    expect(restarted.puts).toHaveLength(0)
  })

  it('re-uploads when the file version changes', async () => {
    const seed = track(makeHarness({}))
    const files = [seed.file('p1', 'n.txt', 'f1', 'v1', 'v1-content')]
    const harness = track(
      makeHarness({
        projects: { p1: project('p1') },
        files: { p1: files },
        ledgerPath: seed.ledgerPath
      })
    )
    harness.service.notifyProjectFilesChanged('p1')
    await harness.service.whenIdle()

    const filesV2 = [seed.file('p1', 'n.txt', 'f1', 'v2', 'v2-content')]
    const second = track(
      makeHarness({
        projects: { p1: project('p1') },
        files: { p1: filesV2 },
        ledgerPath: harness.ledgerPath
      })
    )
    second.service.notifyProjectFilesChanged('p1')
    await second.service.whenIdle()
    expect(second.puts.map((put) => put.key)).toEqual(['projects/P_p1-p1/upload/f1/v2/n.txt'])
  })

  it('a failed file does not block later files and is retried via the scheduled retry', async () => {
    const seed = track(makeHarness({}))
    const files = [
      seed.file('p1', 'bad.txt', 'bad', 'v1'),
      seed.file('p1', 'good.txt', 'good', 'v1')
    ]
    const harness = track(
      makeHarness({
        projects: { p1: project('p1') },
        failKeys: new Set(['projects/P_p1-p1/upload/bad/v1/bad.txt']),
        files: { p1: files },
        ledgerPath: seed.ledgerPath
      })
    )
    harness.service.notifyProjectFilesChanged('p1')
    await harness.service.whenIdle()

    // The failure is queued for retry and later files still landed.
    expect(harness.puts.map((put) => put.key)).toEqual(['projects/P_p1-p1/upload/good/v1/good.txt'])
    expect(harness.retries).toHaveLength(1)
    expect(harness.statuses.at(-1)?.lastError).toContain('boom')

    // Retry clears the failure once the server accepts the object.
    harness.failKeys.clear()
    harness.retries[0]!.callback()
    await harness.service.whenIdle()
    expect(harness.puts.map((put) => put.key)).toEqual([
      'projects/P_p1-p1/upload/good/v1/good.txt',
      'projects/P_p1-p1/upload/bad/v1/bad.txt'
    ])
  })

  it('stops retrying after the attempt cap', async () => {
    const seed = track(makeHarness({}))
    const files = [seed.file('p1', 'n.txt', 'f', 'v')]
    const harness = track(
      makeHarness({
        projects: { p1: project('p1') },
        failKeys: new Set(['projects/P_p1-p1/upload/f/v/n.txt']),
        files: { p1: files },
        ledgerPath: seed.ledgerPath
      })
    )
    for (let i = 0; i < S3_UPLOAD_MAX_ATTEMPTS + 2; i++) {
      harness.service.notifyProjectFilesChanged('p1')
      await harness.service.whenIdle()
      harness.retries.shift()?.callback()
    }
    await harness.service.whenIdle()
    // After MAX_ATTEMPTS the file is no longer queued and no retry is scheduled.
    expect(harness.retries).toHaveLength(0)
    expect(harness.puts).toHaveLength(0)
    const ledger = JSON.parse(readFileSync(harness.ledgerPath, 'utf8')) as {
      failures: Record<string, { attempts: number }>
    }
    expect(ledger.failures['upload/f']?.attempts).toBeGreaterThanOrEqual(S3_UPLOAD_MAX_ATTEMPTS)
  })

  it('reconcileAll scans only opted-in projects', async () => {
    const seed = track(makeHarness({}))
    const onFiles = [seed.file('on', 'a.txt', 'fa', 'v1')]
    const offFiles = [seed.file('off', 'b.txt', 'fb', 'v1')]
    const harness = track(
      makeHarness({
        projects: { on: project('on'), off: project('off', false) },
        files: { on: onFiles, off: offFiles },
        ledgerPath: seed.ledgerPath
      })
    )
    await harness.service.reconcileAll()
    await harness.service.whenIdle()
    expect(harness.puts.map((put) => put.key)).toEqual(['projects/P_on-on/upload/fa/v1/a.txt'])
  })

  it('disabling the project drops queued work and publishes an idle status', async () => {
    const seed = track(makeHarness({}))
    const files = [seed.file('p1', 'n.txt', 'f', 'v')]
    const harness = track(
      makeHarness({
        projects: { p1: project('p1') },
        files: { p1: files },
        ledgerPath: seed.ledgerPath
      })
    )
    harness.service.notifyProjectChanged(project('p1', false))
    await harness.service.whenIdle()
    expect(harness.puts).toHaveLength(0)
    const last = harness.statuses.at(-1)
    expect(last?.pending).toBe(0)
  })

  it('uploads selected files manually under the chosen destination prefix without auto-upload', async () => {
    const seed = track(makeHarness({}))
    // Project does NOT have s3AutoUpload — manual uploads must still work.
    const files = [
      seed.file('p1', 'first report.csv', 'f1', 'v1', 'one'),
      seed.file('p2', 'other.txt', 'f2', 'v1', 'two'),
      seed.file('p1', 'skipped.txt', 'f3', 'v1', 'three')
    ]
    const harness = track(
      makeHarness({
        projects: { p1: project('p1', false), p2: project('p2') },
        files: { p1: [files[0]!, files[2]!], p2: [files[1]!] },
        settings: { ...SETTINGS, pathPrefix: 'backups' },
        ledgerPath: seed.ledgerPath
      })
    )

    const result = await harness.service.uploadFilesManually({
      projectId: 'p1',
      fileIds: [files[0]!.id, files[2]!.id],
      destinationPrefix: 'targets/nested'
    })
    expect(result).toEqual({ queued: 2 })
    await harness.service.whenIdle()

    expect(harness.puts.map((put) => put.key)).toEqual([
      'backups/targets/nested/first report.csv',
      'backups/targets/nested/skipped.txt'
    ])
    // Manual uploads are one-off: the durable ledger is never created.
    expect(existsSync(harness.ledgerPath)).toBe(false)
  })

  it('creates a folder marker object under the configured prefix', async () => {
    const harness = track(
      makeHarness({ settings: { ...SETTINGS, pathPrefix: 'backups' } })
    )

    await harness.service.createDestinationFolder('reports/2026')

    expect(harness.puts).toEqual([{ key: 'backups/reports/2026/', body: '' }])
  })

  it('rejects folder creation when S3 is not configured or the name is empty', async () => {
    const unconfigured = track(makeHarness({ settings: undefined }))
    await expect(unconfigured.service.createDestinationFolder('x')).rejects.toThrow(
      'S3 storage is not configured.'
    )

    const harness = track(makeHarness({}))
    await expect(harness.service.createDestinationFolder('  ')).rejects.toThrow(
      'Folder name is required.'
    )
    expect(harness.puts).toEqual([])
  })

  it('manual upload reports missing files without retrying', async () => {
    const seed = track(makeHarness({}))
    const ghost = { ...seed.file('p1', 'gone.txt', 'f1', 'v1'), path: join(seed.root, 'missing') }
    const harness = track(
      makeHarness({
        projects: { p1: project('p1') },
        files: { p1: [ghost] },
        ledgerPath: seed.ledgerPath
      })
    )
    await harness.service.uploadFilesManually({
      projectId: 'p1',
      fileIds: [ghost.id],
      destinationPrefix: ''
    })
    await harness.service.whenIdle()
    expect(harness.puts).toHaveLength(0)
    expect(harness.retries).toHaveLength(0)
    expect(harness.statuses.at(-1)?.lastError).toContain('no longer available')
  })

  it('listDestinationFolders strips the configured pathPrefix', async () => {
    const harness = track(
      makeHarness({
        settings: { ...SETTINGS, pathPrefix: 'root' },
        listing: {
          folders: ['root/a/', 'root/b/'],
          files: ['root/top.txt'],
          truncated: true
        }
      })
    )
    await expect(harness.service.listDestinationFolders('')).resolves.toEqual({
      prefix: '',
      folders: ['a/', 'b/'],
      files: ['top.txt'],
      truncated: true
    })
  })
})
