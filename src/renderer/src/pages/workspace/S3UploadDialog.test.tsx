// @vitest-environment jsdom
import { waitFor } from '@testing-library/react'
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ProjectFileItem } from '../../../../shared/project-files'
import { S3UploadDialog } from './S3UploadDialog'

const fileItem = (id: string, name: string): ProjectFileItem => ({
  id,
  source: 'upload',
  sourceFileId: id,
  sourceVersionId: 'v1',
  projectId: 'p1',
  sessionId: 's1',
  name,
  path: `/tmp/${name}`,
  size: 128,
  sortAtMs: 1
})

const filePage = (items: ProjectFileItem[], nextCursor?: string) => ({
  items,
  nextCursor
})

const LISTING = {
  prefix: '',
  folders: ['reports/'],
  files: ['existing.txt'],
  truncated: false
}

describe('S3UploadDialog', () => {
  let container: HTMLDivElement
  let root: Root

  const render = async (element: ReactElement): Promise<void> => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => root.render(element))
  }

  beforeEach(() => {
    window.api = {
      projectFiles: {
        listFiles: vi.fn(async () => filePage([fileItem('id-a', 'a.csv'), fileItem('id-b', 'b.csv')]))
      },
      settings: {
        listS3Folders: vi.fn(async (request?: { prefix?: string }) => ({
          ...LISTING,
          prefix: request?.prefix ?? ''
        })),
        createS3Folder: vi.fn(async () => {}),
        uploadProjectFilesToS3: vi.fn(async () => ({ queued: 2 })),
        onS3SyncChanged: vi.fn(() => () => {})
      }
    } as unknown as typeof window.api
  })

  afterEach(async () => {
    if (root) await act(async () => root.unmount())
    container?.remove()
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('lists project files and S3 folders, then uploads the selection', async () => {
    await render(<S3UploadDialog projectId="p1" open onOpenChange={() => {}} />)

    await waitFor(() => {
      expect(document.body.querySelector('[data-testid="s3-upload-file-id-a"]')).not.toBeNull()
      expect(document.body.querySelector('[data-testid="s3-folder-reports/"]')).not.toBeNull()
    })
    expect(window.api.projectFiles.listFiles).toHaveBeenCalledWith({
      projectId: 'p1',
      collection: { kind: 'all' },
      cursor: undefined,
      limit: 100
    })
    expect(window.api.settings.listS3Folders).toHaveBeenCalledWith({ prefix: '' })

    // Select one file.
    const checkbox = document.body.querySelector<HTMLInputElement>(
      '[data-testid="s3-upload-file-id-a"] input[type="checkbox"]'
    )!
    await act(async () => checkbox.click())
    expect(checkbox.checked).toBe(true)

    // Upload with the root prefix.
    const submit = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="s3-upload-submit"]'
    )!
    await act(async () => submit.click())
    await waitFor(() => {
      expect(window.api.settings.uploadProjectFilesToS3).toHaveBeenCalledWith({
        projectId: 'p1',
        fileIds: ['id-a'],
        prefix: ''
      })
    })
  })

  it('navigates into an S3 folder and uploads under that prefix', async () => {
    const listS3Folders = vi.mocked(window.api.settings.listS3Folders)
    listS3Folders.mockImplementation(async (request) => ({
      prefix: request?.prefix ?? '',
      folders: request?.prefix === 'reports/' ? [] : ['reports/'],
      files: [],
      truncated: false
    }))

    await render(<S3UploadDialog projectId="p1" open onOpenChange={() => {}} />)
    await waitFor(() => {
      expect(document.body.querySelector('[data-testid="s3-folder-reports/"]')).not.toBeNull()
    })

    await act(async () => {
      document.body.querySelector<HTMLButtonElement>('[data-testid="s3-folder-reports/"]')!.click()
    })
    await waitFor(() => {
      expect(listS3Folders).toHaveBeenLastCalledWith({ prefix: 'reports/' })
    })
    expect(document.body.querySelector('[data-testid="s3-upload-prefix"]')?.textContent).toBe(
      '/reports/'
    )

    // Select a file and confirm the upload lands under reports/.
    await waitFor(() => {
      expect(
        document.body.querySelector('[data-testid="s3-upload-file-id-b"] input[type="checkbox"]')
      ).not.toBeNull()
    })
    await act(async () => {
      document.body
        .querySelector<HTMLInputElement>(
          '[data-testid="s3-upload-file-id-b"] input[type="checkbox"]'
        )!
        .click()
    })
    await act(async () => {
      document.body.querySelector<HTMLButtonElement>('[data-testid="s3-upload-submit"]')!.click()
    })
    await waitFor(() => {
      expect(window.api.settings.uploadProjectFilesToS3).toHaveBeenCalledWith({
        projectId: 'p1',
        fileIds: ['id-b'],
        prefix: 'reports/'
      })
    })
  })

  it('creates a new folder inside the current prefix and navigates into it', async () => {
    const listS3Folders = vi.mocked(window.api.settings.listS3Folders)
    const createS3Folder = vi.mocked(window.api.settings.createS3Folder)

    await render(<S3UploadDialog projectId="p1" open onOpenChange={() => {}} />)
    await waitFor(() => {
      expect(document.body.querySelector('[data-testid="s3-upload-folder-list"]')).not.toBeNull()
    })

    await act(async () => {
      document.body.querySelector<HTMLButtonElement>('[aria-label="New folder"]')!.click()
    })
    const input = document.body.querySelector<HTMLInputElement>(
      '[data-testid="s3-new-folder-input"]'
    )!
    expect(input).not.toBeNull()
    await act(async () => {
      // Native setter so React sees the change.
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, 'drafts')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      document.body
        .querySelector<HTMLButtonElement>('[data-testid="s3-new-folder-create"]')!
        .click()
    })

    await waitFor(() => {
      expect(createS3Folder).toHaveBeenCalledWith({ prefix: 'drafts/' })
    })
    await waitFor(() => {
      expect(listS3Folders).toHaveBeenLastCalledWith({ prefix: 'drafts/' })
    })
    expect(document.body.querySelector('[data-testid="s3-upload-prefix"]')?.textContent).toBe(
      '/drafts/'
    )
  })

  it('shows an inline error when the S3 listing fails', async () => {
    vi.mocked(window.api.settings.listS3Folders).mockRejectedValue(new Error('AccessDenied'))
    await render(<S3UploadDialog projectId="p1" open onOpenChange={() => {}} />)
    await waitFor(() => {
      expect(document.body.textContent).toContain('AccessDenied')
    })
  })
})
