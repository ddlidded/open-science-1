import { ErrorNotice } from '@/components/error-notice'
import { Button } from '@/components/ui/button'
import { ProgressBar } from '@/components/ui/progress-bar'
import * as Dialog from '@/components/ui/dialog'
import {
  dialogBodyClassName,
  dialogCancelButtonClassName,
  dialogFooterClassName,
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogTitleClassName
} from '@/components/ui/dialog-chrome'
import { cn } from '@/lib/utils'
import {
  ArrowUp,
  File,
  Folder,
  FolderOpen,
  FolderPlus,
  Loader2,
  RefreshCw,
  Upload,
  X
} from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ProjectFileItem } from '../../../../shared/project-files'
import type { S3FolderListing, S3SyncStatus } from '../../../../shared/s3-sync'

const PAGE_LIMIT = 100

const formatSize = (size: number): string => {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

const parentPrefix = (prefix: string): string => {
  const trimmed = prefix.replace(/\/+$/, '')
  const index = trimmed.lastIndexOf('/')
  return index < 0 ? '' : `${trimmed.slice(0, index + 1)}`
}

export function S3UploadDialog({
  projectId,
  open,
  onOpenChange
}: {
  projectId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  const { t } = useTranslation()

  // Project file picker state.
  const [files, setFiles] = useState<ProjectFileItem[]>([])
  const [filesCursor, setFilesCursor] = useState<string | undefined>()
  const [filesLoading, setFilesLoading] = useState(false)
  const [filesError, setFilesError] = useState<string | null>(null)
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set())

  // S3 destination browser state. Prefix is relative to the configured pathPrefix, '' = root.
  const [prefix, setPrefix] = useState('')
  const [listing, setListing] = useState<S3FolderListing | null>(null)
  const [listingLoading, setListingLoading] = useState(false)
  const [listingError, setListingError] = useState<string | null>(null)
  const [creatingFolder, setCreatingFolder] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const [folderBusy, setFolderBusy] = useState(false)

  const [uploading, setUploading] = useState(false)
  const [uploadResult, setUploadResult] = useState<{ queued: number } | null>(null)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [syncStatus, setSyncStatus] = useState<S3SyncStatus | null>(null)

  const loadFiles = useCallback(
    async (cursor: string | undefined, reset: boolean) => {
      setFilesLoading(true)
      setFilesError(null)
      try {
        const page = await window.api.projectFiles.listFiles({
          projectId,
          collection: { kind: 'all' },
          cursor,
          limit: PAGE_LIMIT
        })
        setFiles((current) => (reset ? page.items : [...current, ...page.items]))
        setFilesCursor(page.nextCursor ?? undefined)
      } catch (error) {
        setFilesError(error instanceof Error ? error.message : String(error))
      } finally {
        setFilesLoading(false)
      }
    },
    [projectId]
  )

  const loadListing = useCallback(async (nextPrefix: string) => {
    setListingLoading(true)
    setListingError(null)
    try {
      const result = await window.api.settings.listS3Folders({ prefix: nextPrefix })
      setListing(result)
      setPrefix(result.prefix)
    } catch (error) {
      setListingError(error instanceof Error ? error.message : String(error))
      setListing(null)
    } finally {
      setListingLoading(false)
    }
  }, [])

  useEffect(() => {
    const subscribe = window.api.settings.onS3SyncChanged
    if (!subscribe) return
    return subscribe((status) => {
      if (status.projectId === projectId) setSyncStatus(status)
    })
  }, [projectId])

  useEffect(() => {
    if (!open) return
    setFiles([])
    setFilesCursor(undefined)
    setSelectedIds(new Set())
    setUploadResult(null)
    setUploadError(null)
    setSyncStatus(null)
    void loadFiles(undefined, true)
    void loadListing('')
  }, [open, loadFiles, loadListing])

  const toggleFile = (id: string): void => {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const createFolder = async (): Promise<void> => {
    const name = newFolderName.trim().replace(/^\/+|\/+$/g, '')
    if (!name) return
    setFolderBusy(true)
    setListingError(null)
    try {
      const folder = `${prefix}${name}/`
      await window.api.settings.createS3Folder({ prefix: folder })
      setCreatingFolder(false)
      setNewFolderName('')
      await loadListing(folder)
    } catch (error) {
      setListingError(error instanceof Error ? error.message : String(error))
    } finally {
      setFolderBusy(false)
    }
  }

  const upload = async (): Promise<void> => {
    setUploading(true)
    setUploadError(null)
    setUploadResult(null)
    try {
      const result = await window.api.settings.uploadProjectFilesToS3({
        projectId,
        fileIds: [...selectedIds],
        prefix
      })
      setUploadResult(result)
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : String(error))
    } finally {
      setUploading(false)
    }
  }

  const rowClass =
    'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50'

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={dialogOverlayClassName} />
        <Dialog.Content
          data-testid="s3-upload-dialog"
          className={dialogPanelClassName('max-w-2xl')}
          onInteractOutside={(event) => event.preventDefault()}
        >
          <div className="flex items-start justify-between gap-3 px-5 pt-4">
            <div>
              <Dialog.Title className={dialogTitleClassName}>
                {t('Upload files to S3 storage')}
              </Dialog.Title>
              <Dialog.Description className="mt-1 text-[12px] text-text-300">
                {t('Select project files and choose the destination folder in the S3 bucket.')}
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button
                type="button"
                aria-label={t('Close dialog')}
                className="rounded-md p-1 text-text-300 outline-none hover:bg-muted hover:text-text-000 focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                <X className="size-4" aria-hidden="true" />
              </button>
            </Dialog.Close>
          </div>

          <div className={cn(dialogBodyClassName, 'grid min-h-0 grid-cols-2 gap-4 px-5 py-4')}>
            {/* Project file picker */}
            <div className="flex min-h-0 flex-col">
              <div className="mb-1.5 text-[11px] font-medium uppercase tracking-normal text-text-300">
                {t('Files')}
              </div>
              <div
                data-testid="s3-upload-file-list"
                className="min-h-[280px] flex-1 overflow-y-auto rounded-md border border-border-300/60"
              >
                {files.map((file) => (
                  <label
                    key={file.id}
                    className={cn(rowClass, 'cursor-pointer')}
                    data-testid={`s3-upload-file-${file.id}`}
                  >
                    <input
                      type="checkbox"
                      className="size-3.5 shrink-0 accent-current"
                      checked={selectedIds.has(file.id)}
                      onChange={() => toggleFile(file.id)}
                    />
                    <File className="size-3.5 shrink-0 text-text-300" aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate" title={file.name}>
                      {file.name}
                    </span>
                    <span className="shrink-0 text-[11px] tabular-nums text-text-300">
                      {formatSize(file.size)}
                    </span>
                  </label>
                ))}
                {!filesLoading && files.length === 0 && !filesError ? (
                  <div className="px-3 py-6 text-center text-[12px] text-text-300">
                    {t('No files in this project yet.')}
                  </div>
                ) : null}
                {filesError ? (
                  <div className="p-3">
                    <ErrorNotice
                      inline
                      tone="red"
                      title={t('Could not load project files')}
                      description={filesError}
                      primaryButton={{
                        label: t('Retry'),
                        onClick: () => void loadFiles(undefined, true)
                      }}
                    />
                  </div>
                ) : null}
                {filesLoading ? (
                  <div className="flex items-center justify-center gap-2 px-3 py-4 text-[12px] text-text-300">
                    <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                    {t('Loading…')}
                  </div>
                ) : null}
                {filesCursor && !filesLoading ? (
                  <div className="p-2">
                    <Button
                      type="button"
                      variant="ghost"
                      className="w-full text-[12px]"
                      onClick={() => void loadFiles(filesCursor, false)}
                    >
                      {t('Load more')}
                    </Button>
                  </div>
                ) : null}
              </div>
            </div>

            {/* S3 destination browser */}
            <div className="flex min-h-0 flex-col">
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <div className="text-[11px] font-medium uppercase tracking-normal text-text-300">
                  {t('Destination folder')}
                </div>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    aria-label={t('New folder')}
                    disabled={listingLoading || folderBusy}
                    onClick={() => {
                      setCreatingFolder((current) => !current)
                      setNewFolderName('')
                    }}
                    className="rounded p-1 text-text-200 outline-none hover:bg-muted hover:text-text-000 focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-40"
                  >
                    <FolderPlus className="size-3.5" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    aria-label={t('Go up one folder')}
                    disabled={!prefix || listingLoading}
                    onClick={() => void loadListing(parentPrefix(prefix))}
                    className="rounded p-1 text-text-200 outline-none hover:bg-muted hover:text-text-000 focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-40"
                  >
                    <ArrowUp className="size-3.5" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    aria-label={t('Refresh folder listing')}
                    disabled={listingLoading}
                    onClick={() => void loadListing(prefix)}
                    className="rounded p-1 text-text-200 outline-none hover:bg-muted hover:text-text-000 focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-40"
                  >
                    <RefreshCw className="size-3.5" aria-hidden="true" />
                  </button>
                </div>
              </div>
              <div
                data-testid="s3-upload-prefix"
                className="mb-1 truncate rounded bg-bg-200 px-2 py-1 font-mono text-[11px] text-text-200"
                title={`/${prefix}`}
              >
                /{prefix}
              </div>
              {creatingFolder ? (
                <form
                  className="mb-1 flex items-center gap-1.5"
                  onSubmit={(event) => {
                    event.preventDefault()
                    void createFolder()
                  }}
                >
                  <input
                    type="text"
                    autoFocus
                    value={newFolderName}
                    onChange={(event) => setNewFolderName(event.target.value)}
                    placeholder={t('Folder name')}
                    data-testid="s3-new-folder-input"
                    className="min-w-0 flex-1 rounded border border-border-300/60 bg-transparent px-2 py-1 text-[12px] outline-none placeholder:text-text-300 focus-visible:ring-2 focus-visible:ring-ring/50"
                  />
                  <Button
                    type="submit"
                    size="sm"
                    disabled={folderBusy || !newFolderName.trim()}
                    data-testid="s3-new-folder-create"
                  >
                    {folderBusy ? (
                      <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                    ) : null}
                    {t('Create')}
                  </Button>
                </form>
              ) : null}
              <div
                data-testid="s3-upload-folder-list"
                className="min-h-[252px] flex-1 overflow-y-auto rounded-md border border-border-300/60"
              >
                {(listing?.folders ?? []).map((folder) => (
                  <button
                    key={folder}
                    type="button"
                    data-testid={`s3-folder-${folder}`}
                    className={rowClass}
                    onClick={() => void loadListing(folder)}
                  >
                    <Folder className="size-3.5 shrink-0 text-text-300" aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate">
                      {folder.slice(prefix.length).replace(/\/+$/, '')}
                    </span>
                  </button>
                ))}
                {(listing?.files ?? []).map((key) => (
                  <div key={key} className={cn(rowClass, 'cursor-default text-text-300')}>
                    <File className="size-3.5 shrink-0" aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate">{key.slice(prefix.length)}</span>
                  </div>
                ))}
                {listingLoading ? (
                  <div className="flex items-center justify-center gap-2 px-3 py-4 text-[12px] text-text-300">
                    <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                    {t('Loading…')}
                  </div>
                ) : null}
                {!listingLoading && listing && listing.folders.length === 0 && listing.files.length === 0 ? (
                  <div className="flex flex-col items-center gap-1 px-3 py-6 text-center text-[12px] text-text-300">
                    <FolderOpen className="size-5" aria-hidden="true" />
                    {t('This folder is empty.')}
                  </div>
                ) : null}
                {listing?.truncated ? (
                  <div className="px-3 py-1.5 text-[11px] text-text-300">
                    {t('Showing the first entries only.')}
                  </div>
                ) : null}
                {listingError ? (
                  <div className="p-3">
                    <ErrorNotice
                      inline
                      tone="red"
                      title={t('Could not list S3 folders')}
                      description={listingError}
                      primaryButton={{
                        label: t('Retry'),
                        onClick: () => void loadListing(prefix)
                      }}
                    />
                  </div>
                ) : null}
              </div>
            </div>
          </div>

          {uploadError ? (
            <div className="px-5 pb-2">
              <ErrorNotice
                inline
                tone="red"
                title={t('Upload failed')}
                description={uploadError}
              />
            </div>
          ) : null}
          {uploadResult && !syncStatus ? (
            <div className="px-5 pb-2">
              <ErrorNotice
                inline
                level="success"
                title={t('Upload queued')}
                description={t('{{count}} files queued for upload.', {
                  count: uploadResult.queued,
                  defaultValue_one: '{{count}} file queued for upload.'
                })}
              />
            </div>
          ) : null}
          {uploadResult && syncStatus
            ? (() => {
                const total = Math.max(uploadResult.queued, 1)
                const inFlight = syncStatus.active ? 1 : 0
                const completed = Math.max(
                  0,
                  Math.min(total, total - syncStatus.pending - inFlight)
                )
                const finished = syncStatus.pending === 0 && !syncStatus.active
                return (
                  <div className="px-5 pb-2">
                    <div className="mb-1.5 flex items-center justify-between gap-2 text-[12px] text-text-200">
                      <span className="min-w-0 truncate">
                        {finished
                          ? syncStatus.lastError
                            ? t('Upload finished with errors')
                            : t('Upload complete')
                          : syncStatus.active
                            ? t('Uploading {{name}}', { name: syncStatus.active })
                            : t('Uploading…')}
                      </span>
                      <span className="shrink-0 tabular-nums text-text-300">
                        {t('{{completed}} of {{total}} files', {
                          completed,
                          total
                        })}
                      </span>
                    </div>
                    <ProgressBar
                      label={t('Upload progress')}
                      value={(completed / total) * 100}
                    />
                    {syncStatus.lastError ? (
                      <div className="mt-2">
                        <ErrorNotice
                          inline
                          tone="red"
                          title={t('Upload failed')}
                          description={syncStatus.lastError}
                        />
                      </div>
                    ) : null}
                  </div>
                )
              })()
            : null}

          <div className={cn(dialogFooterClassName, 'px-5 pb-4')}>
            <span className="mr-auto text-[11px] tabular-nums text-text-300">
              {t('{{count}} files selected', {
                count: selectedIds.size,
                defaultValue_one: '{{count}} file selected'
              })}
            </span>
            <Dialog.Close asChild>
              <Button type="button" variant="ghost" className={dialogCancelButtonClassName}>
                {t('Close')}
              </Button>
            </Dialog.Close>
            <Button
              type="button"
              data-testid="s3-upload-submit"
              disabled={uploading || selectedIds.size === 0}
              onClick={() => void upload()}
            >
              {uploading ? (
                <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <Upload className="size-3.5" aria-hidden="true" />
              )}
              {t('Upload to S3')}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
