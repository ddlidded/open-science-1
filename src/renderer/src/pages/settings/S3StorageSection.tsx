import { CheckCircle2, LoaderCircle, RefreshCw, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { InlineNotice } from '@/components/ui/inline-notice'
import { Input } from '@/components/ui/input'
import { useSettingsStore } from '@/stores/settings-store'
import type { S3SettingsDraft, S3TestConnectionResult } from '../../../../shared/s3-sync'
import { SettingsSection } from './SettingsLayout'

const inputClassName =
  'h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm text-foreground'
const labelClassName = 'text-xs font-medium text-muted-foreground'

// Custom S3-compatible destination for per-project auto-upload. The secret key field only carries
// plaintext while the user types a replacement — saving without touching it keeps the stored key.
const S3StorageSection = (): React.JSX.Element => {
  const { t } = useTranslation()
  const s3 = useSettingsStore((state) => state.s3)

  const [endpoint, setEndpoint] = useState('')
  const [region, setRegion] = useState('')
  const [bucket, setBucket] = useState('')
  const [accessKeyId, setAccessKeyId] = useState('')
  const [secretAccessKey, setSecretAccessKey] = useState('')
  const [pathPrefix, setPathPrefix] = useState('')
  const [enabled, setEnabled] = useState(true)
  const [dirty, setDirty] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [isTesting, setIsTesting] = useState(false)
  const [testResult, setTestResult] = useState<S3TestConnectionResult>()
  const [saveError, setSaveError] = useState<string>()
  const [pendingUploads, setPendingUploads] = useState(0)
  const [activeUpload, setActiveUpload] = useState<string>()
  const [statuses, setStatuses] = useState<
    Record<string, { pending: number; active?: string }>
  >({})
  const hydrated = useRef(false)

  // Populate the form once from the snapshot; later edits must not clobber an in-progress draft.
  useEffect(() => {
    if (hydrated.current) return
    hydrated.current = true
    setEndpoint(s3?.endpoint ?? '')
    setRegion(s3?.region ?? '')
    setBucket(s3?.bucket ?? '')
    setAccessKeyId(s3?.accessKeyId ?? '')
    setPathPrefix(s3?.pathPrefix ?? '')
    setEnabled(s3?.enabled !== false)
  }, [s3])

  useEffect(() => {
    const subscribe = window.api.settings.onS3SyncChanged
    if (!subscribe) return
    return subscribe((status) => {
      setStatuses((map) => ({ ...map, [status.projectId]: status }))
    })
  }, [])

  useEffect(() => {
    const pending = Object.values(statuses).reduce((sum, status) => sum + status.pending, 0)
    setPendingUploads(pending)
    setActiveUpload(Object.values(statuses).find((status) => status.active)?.active)
  }, [statuses])

  const draft = (): S3SettingsDraft => ({
    endpoint: endpoint.trim() || undefined,
    region: region.trim() || undefined,
    bucket: bucket.trim() || undefined,
    accessKeyId: accessKeyId.trim() || undefined,
    secretAccessKey: secretAccessKey || undefined,
    pathPrefix: pathPrefix.trim() || undefined,
    enabled
  })

  const handleSave = async (): Promise<void> => {
    setIsSaving(true)
    setSaveError(undefined)
    try {
      await window.api.settings.setS3Settings(draft())
      setSecretAccessKey('')
      setDirty(false)
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error))
    } finally {
      setIsSaving(false)
    }
  }

  const handleRemove = async (): Promise<void> => {
    setIsSaving(true)
    setSaveError(undefined)
    try {
      await window.api.settings.setS3Settings({ reset: true })
      setEndpoint('')
      setRegion('')
      setBucket('')
      setAccessKeyId('')
      setSecretAccessKey('')
      setPathPrefix('')
      setDirty(false)
      setTestResult(undefined)
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error))
    } finally {
      setIsSaving(false)
    }
  }

  const handleTest = async (): Promise<void> => {
    setIsTesting(true)
    setTestResult(undefined)
    try {
      setTestResult(await window.api.settings.testS3Connection(draft()))
    } catch (error) {
      setTestResult({ ok: false, error: error instanceof Error ? error.message : String(error) })
    } finally {
      setIsTesting(false)
    }
  }

  const markDirty = (setter: (value: string) => void) => (value: string) => {
    setter(value)
    setDirty(true)
    setTestResult(undefined)
  }

  return (
    <SettingsSection
      title={t('S3 storage')}
      description={t('Automatically upload project files to an S3-compatible server.')}
      aria-label={t('S3 storage')}
    >
      <div className="space-y-3 rounded-lg border border-border p-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="space-y-1">
            <span className={labelClassName}>{t('Endpoint')}</span>
            <Input
              className={inputClassName}
              placeholder={t('https://s3.us-east-1.amazonaws.com')}
              value={endpoint}
              onChange={(event) => markDirty(setEndpoint)(event.target.value)}
              spellCheck={false}
            />
          </label>
          <label className="space-y-1">
            <span className={labelClassName}>{t('Region (optional)')}</span>
            <Input
              className={inputClassName}
              placeholder={t('us-east-1')}
              value={region}
              onChange={(event) => markDirty(setRegion)(event.target.value)}
              spellCheck={false}
            />
          </label>
          <label className="space-y-1">
            <span className={labelClassName}>{t('Bucket')}</span>
            <Input
              className={inputClassName}
              value={bucket}
              onChange={(event) => markDirty(setBucket)(event.target.value)}
              spellCheck={false}
            />
          </label>
          <label className="space-y-1">
            <span className={labelClassName}>{t('Path prefix (optional)')}</span>
            <Input
              className={inputClassName}
              placeholder={t('backups/')}
              value={pathPrefix}
              onChange={(event) => markDirty(setPathPrefix)(event.target.value)}
              spellCheck={false}
            />
          </label>
          <label className="space-y-1">
            <span className={labelClassName}>{t('Access key ID')}</span>
            <Input
              className={inputClassName}
              value={accessKeyId}
              onChange={(event) => markDirty(setAccessKeyId)(event.target.value)}
              spellCheck={false}
              autoComplete="off"
            />
          </label>
          <label className="space-y-1">
            <span className={labelClassName}>{t('Secret access key')}</span>
            <Input
              className={inputClassName}
              type="password"
              placeholder={s3?.hasSecretKey ? t('Saved — enter a new key to replace') : ''}
              value={secretAccessKey}
              onChange={(event) => markDirty(setSecretAccessKey)(event.target.value)}
              autoComplete="off"
            />
          </label>
        </div>

        <label className="flex items-center gap-2 text-sm text-foreground">
          <input
            type="checkbox"
            className="size-4 accent-primary"
            checked={enabled}
            onChange={(event) => {
              setEnabled(event.target.checked)
              setDirty(true)
            }}
          />
          {t('Enable S3 uploads')}
        </label>

        {pendingUploads > 0 ? (
          <p className="text-xs text-muted-foreground">
            {activeUpload
              ? t('Uploading {{name}}…', { name: activeUpload })
              : t('{{count}} files waiting to upload', {
                  count: pendingUploads,
                  defaultValue_one: '{{count}} file waiting to upload'
                })}
          </p>
        ) : null}

        {testResult ? (
          <InlineNotice level={testResult.ok ? 'success' : 'error'} role="status">
            {testResult.ok ? t('Connection successful.') : testResult.error}
          </InlineNotice>
        ) : null}
        {saveError ? (
          <InlineNotice level="error" role="alert">
            {saveError}
          </InlineNotice>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={isTesting}
            onClick={() => void handleTest()}
          >
            {isTesting ? (
              <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <CheckCircle2 className="size-4" aria-hidden="true" />
            )}
            {isTesting ? t('Testing…') : t('Test connection')}
          </Button>
          <Button
            type="button"
            disabled={isSaving || (!dirty && !secretAccessKey)}
            onClick={() => void handleSave()}
          >
            {isSaving ? (
              <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
            ) : null}
            {t('Save')}
          </Button>
          {s3 ? (
            <Button
              type="button"
              variant="outline"
              disabled={isSaving}
              onClick={() => void handleRemove()}
            >
              <Trash2 className="size-4" aria-hidden="true" />
              {t('Remove')}
            </Button>
          ) : null}
          {s3 && !dirty ? (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <RefreshCw className="size-3" aria-hidden="true" />
              {t('Configured')}
            </span>
          ) : null}
        </div>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        {t(
          'Files upload one at a time when “Auto upload all files to S3 storage automatically” is enabled in a project.'
        )}
      </p>
    </SettingsSection>
  )
}

export { S3StorageSection }
