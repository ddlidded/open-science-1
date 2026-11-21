import { describe, expect, it, vi } from 'vitest'

import { composeAcpRuntimeBaseOwners } from './runtime-base-composition'
import {
  composeAcpRuntimePromptOwners,
  prepareNotebookTurnIntent,
  type AcpRuntimePromptHost,
  type AcpRuntimePromptOwners,
  type NotebookTurnIntentDeps
} from './runtime-prompt-composition'
import { composeAcpRuntimeSessionOwners } from './runtime-session-composition'
import type { AcpPromptRequest } from '../../shared/acp'
import {
  NotebookExecutionIntent,
  notebookExecutionIntent,
  withNotebookUserOperation
} from '../notebook/execution-intent'

describe('ACP Runtime Prompt composition', () => {
  it('builds a fresh frozen graph without invoking Plan or reload hosts', () => {
    const options = { appVersion: 'test', defaultCwd: '/workspace' }
    const create = (): AcpRuntimePromptOwners => {
      const base = composeAcpRuntimeBaseOwners(options)
      const session = composeAcpRuntimeSessionOwners(options, base)
      const host: AcpRuntimePromptHost = {
        plan: {
          preflight: vi.fn(() => ({})),
          admit: vi.fn((_request, _interaction, plan) => plan),
          providerAccepted: vi.fn(async () => undefined),
          beforeRelease: vi.fn(),
          afterRelease: vi.fn(async () => undefined)
        },
        reload: {
          prepareContinuationReplay: vi.fn(async () => undefined),
          disconnect: vi.fn(async () => undefined),
          resume: vi.fn(async () => ({}))
        }
      }
      const owners = composeAcpRuntimePromptOwners(options, base, session, host)

      expect(host.plan.preflight).not.toHaveBeenCalled()
      expect(host.plan.admit).not.toHaveBeenCalled()
      expect(host.plan.beforeRelease).not.toHaveBeenCalled()
      expect(host.plan.afterRelease).not.toHaveBeenCalled()
      expect(host.reload.prepareContinuationReplay).not.toHaveBeenCalled()
      expect(host.reload.disconnect).not.toHaveBeenCalled()
      expect(host.reload.resume).not.toHaveBeenCalled()
      return owners
    }

    const first = create()
    const second = create()

    expect(Object.isFrozen(first)).toBe(true)
    expect(first.contextCompactionWorkflow).not.toBe(second.contextCompactionWorkflow)
    expect(first.promptTurnWorkflow).not.toBe(second.promptTurnWorkflow)
  })
})

describe('prepareNotebookTurnIntent', () => {
  const scope = {
    projectId: 'project-1',
    sessionId: 'app-1',
    promptMessageId: 'prompt-1'
  }

  const buildRequest = (
    init: Partial<AcpPromptRequest> = {},
    operation?: Parameters<typeof withNotebookUserOperation>[1]
  ): AcpPromptRequest => {
    const request: AcpPromptRequest = {
      sessionId: 'app-1',
      text: 'hello',
      provenanceContext: {
        messageBranchId: 'branch-1',
        promptMessageId: 'prompt-1'
      },
      ...init
    } as AcpPromptRequest
    return operation ? withNotebookUserOperation(request, operation) : request
  }

  const buildDeps = (input: {
    rebindable?: boolean
    current?: NotebookExecutionIntent
    created?: NotebookExecutionIntent
    resolved?: NotebookExecutionIntent
    withNotebook?: boolean
  }): NotebookTurnIntentDeps => {
    const created =
      input.created ?? new NotebookExecutionIntent({ ...scope, messageBranchId: 'branch-1' })
    return {
      notebook:
        input.withNotebook === false
          ? undefined
          : {
              projectId: 'project-1',
              mcpEntryPath: '/tmp/notebook-mcp.js',
              createExecutionIntent: vi.fn(() => created),
              currentExecutionIntent: vi.fn(() => input.current),
              rememberExecutionIntent: vi.fn(),
              resolveExecutionIntent: vi.fn(() => input.resolved)
            },
      projectId: () => 'project-1',
      boundIntentFor: () => input.current,
      authorityRebindable: () => input.rebindable !== false
    }
  }

  it('reuses the provision-bound intent on connections that cannot rebind (Devin)', () => {
    const bound = new NotebookExecutionIntent({ ...scope, messageBranchId: 'branch-1' })
    const deps = buildDeps({ rebindable: false, current: bound })
    const assertCurrent = vi.fn()
    const request = buildRequest({}, { assertCurrent })

    prepareNotebookTurnIntent(request, { kind: 'user' }, deps)

    expect(assertCurrent).toHaveBeenCalled()
    expect(deps.notebook?.createExecutionIntent).not.toHaveBeenCalled()
    expect(notebookExecutionIntent(request)).toBe(bound)
    expect(deps.notebook?.rememberExecutionIntent).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'app-1' }),
      'prompt-1',
      bound
    )
  })

  it('leaves the turn unmarked when the bound intent was refused and cannot be replaced', () => {
    const bound = new NotebookExecutionIntent({ ...scope, messageBranchId: 'branch-1' })
    bound.block('memory-pressure')
    const deps = buildDeps({ rebindable: false, current: bound })
    const request = buildRequest({}, { assertCurrent: vi.fn() })

    prepareNotebookTurnIntent(request, { kind: 'user' }, deps)

    expect(deps.notebook?.createExecutionIntent).not.toHaveBeenCalled()
    expect(notebookExecutionIntent(request)).toBeUndefined()
    expect(deps.notebook?.rememberExecutionIntent).not.toHaveBeenCalled()
  })

  it('leaves the turn unmarked when no bound authority exists on a fixed session', () => {
    const deps = buildDeps({ rebindable: false })
    const request = buildRequest({}, { assertCurrent: vi.fn() })

    prepareNotebookTurnIntent(request, { kind: 'user' }, deps)

    expect(notebookExecutionIntent(request)).toBeUndefined()
  })

  it('does not synthesize a refused intent for unmarked turns on fixed sessions', () => {
    const deps = buildDeps({ rebindable: false })
    const request = buildRequest()

    prepareNotebookTurnIntent(request, { kind: 'user' }, deps)

    expect(notebookExecutionIntent(request)).toBeUndefined()
  })

  it('keeps the provision-bound intent for scheduled wakes on fixed sessions', () => {
    const bound = new NotebookExecutionIntent({ ...scope, messageBranchId: 'branch-1' })
    const deps = buildDeps({ rebindable: false, current: bound })
    const request = buildRequest({
      provenanceContext: {
        messageBranchId: 'branch-1',
        promptMessageId: 'wake-1'
      } as AcpPromptRequest['provenanceContext']
    })

    prepareNotebookTurnIntent(
      request,
      {
        kind: 'application',
        attribution: {
          kind: 'application',
          feature: 'schedule',
          purpose: 'scheduled-wake',
          scheduleId: 'sched-1',
          occurrenceId: 'occ-1',
          scheduledAt: 1
        }
      },
      deps
    )

    expect(notebookExecutionIntent(request)).toBe(bound)
    expect(deps.notebook?.createExecutionIntent).not.toHaveBeenCalled()
  })

  it('mints a fresh per-turn intent on rebindable connections', () => {
    const bound = new NotebookExecutionIntent({ ...scope, messageBranchId: 'branch-1' })
    const created = new NotebookExecutionIntent({ ...scope, messageBranchId: 'branch-1' })
    const deps = buildDeps({ rebindable: true, current: bound, created })
    const request = buildRequest({}, { assertCurrent: vi.fn() })

    prepareNotebookTurnIntent(request, { kind: 'user' }, deps)

    expect(deps.notebook?.createExecutionIntent).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'app-1', promptMessageId: 'prompt-1' })
    )
    expect(notebookExecutionIntent(request)).toBe(created)
  })

  it('keeps the refused current intent for ordinary explanation turns on rebindable connections', () => {
    const bound = new NotebookExecutionIntent({ ...scope, messageBranchId: 'branch-1' })
    bound.block('memory-pressure')
    const deps = buildDeps({ rebindable: true, current: bound })
    const request = buildRequest({}, { assertCurrent: vi.fn() })

    prepareNotebookTurnIntent(request, { kind: 'user' }, deps)

    expect(deps.notebook?.createExecutionIntent).not.toHaveBeenCalled()
    expect(notebookExecutionIntent(request)).toBe(bound)
  })

  it('synthesizes a refused intent for unmarked turns on rebindable connections', () => {
    const deps = buildDeps({ rebindable: true })
    const request = buildRequest()

    prepareNotebookTurnIntent(request, { kind: 'user' }, deps)

    const intent = notebookExecutionIntent(request)
    expect(intent).toBeInstanceOf(NotebookExecutionIntent)
    expect(intent?.refusalId).toBeDefined()
  })

  it('returns early when the Notebook authority port is absent', () => {
    const deps = buildDeps({ rebindable: false, withNotebook: false })
    const request = buildRequest({}, { assertCurrent: vi.fn() })

    prepareNotebookTurnIntent(request, { kind: 'user' }, deps)

    expect(notebookExecutionIntent(request)).toBeUndefined()
  })
})
