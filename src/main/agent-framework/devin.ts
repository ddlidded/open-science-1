import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio
} from 'node:child_process'
import type { SessionModeState } from '@agentclientprotocol/sdk'

import type { PermissionProfileId } from '../../shared/permission-profiles'
import {
  resolvePermissionProfileApplication,
  type PermissionProfileApplication
} from '../acp/permission-profile-controller'
import type { ResolvedProvider } from '../settings/provider-env'
import { augmentedPathEnv } from '../settings/shell-path'
import { isProductionDelegatedWorkFramework } from '../delegation/production-readiness'
import { renderAppMcpToolReferences } from './app-mcp-names'
import type {
  AgentFramework,
  AgentModelConfig,
  AgentSpawnInput,
  ModelConfigContext,
  SessionSetup,
  SessionSetupContext
} from './types'

type SpawnProcess = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio & { stdio: 'pipe' }
) => ChildProcessWithoutNullStreams

type DevinFrameworkDeps = {
  platform?: NodeJS.Platform
  sourceEnv?: NodeJS.ProcessEnv
  spawnProcess?: SpawnProcess
}

// The provider's own account default: selecting it leaves `devin acp` on its configured/enterprise
// model instead of pinning one with --model. Devin's live model catalog is negotiated over ACP.
export const DEVIN_DEFAULT_MODEL = 'default'

// Devin is a self-contained agent: it authenticates against Cognition's service through
// `devin auth login` (or an inherited WINDSURF_API_KEY) and advertises its own model, thinking
// effort, and session controls over ACP. No app provider endpoint, key, or transport applies, so
// the framework keeps supportedApiTypes empty — the only usable provider is the builtin Devin
// account record, which isProviderUsableByFramework short-circuits to this framework.
export const createDevinFramework = ({
  platform = process.platform,
  sourceEnv = process.env,
  spawnProcess = spawn as SpawnProcess
}: DevinFrameworkDeps = {}): AgentFramework => ({
  id: 'devin',
  displayName: 'Devin',
  commandShellDialect: platform === 'win32' ? 'powershell' : 'posix',
  contextCompaction: { kind: 'native-command', command: '/compact' },
  supportsSkills: true,
  supportsDelegatedWork: isProductionDelegatedWorkFramework('devin'),
  acceptsStdioMcp: true,
  supportsLiveEffortChange: true,
  // Devin's effort configOption advertises the same low/medium/high/xhigh/max vocabulary the app's
  // standard preset emits, so the adapter is a pass-through; resolveSessionEffortOption still gates
  // every value against the live advertised list.
  adaptSessionEffort: (effort) => effort,
  supportedApiTypes: [],

  spawn(input: AgentSpawnInput): ChildProcessWithoutNullStreams {
    const needsShell = platform === 'win32' && /\.(cmd|bat)$/i.test(input.executablePath)
    const args = ['acp', ...input.args].map((arg) => (needsShell && arg === '' ? '""' : arg))
    return (input.spawnProcess ?? spawnProcess)(
      needsShell ? `"${input.executablePath}"` : input.executablePath,
      args,
      {
        env: { ...augmentedPathEnv(sourceEnv), ...input.env },
        stdio: 'pipe',
        windowsHide: true,
        shell: needsShell
      }
    )
  },

  prepareModelConfig(provider: ResolvedProvider, _ctx: ModelConfigContext): AgentModelConfig {
    const model = provider.model
    return {
      ...(model && model !== DEVIN_DEFAULT_MODEL ? { args: ['--model', model] } : {}),
      // Devin's ACP server deliberately ignores the CLI's local credential store — the host must
      // authenticate each connection over ACP. `devin-browser` is the advertised method and drives
      // the PKCE browser sign-in; the request resolves once that flow completes.
      authentication: { methodId: 'devin-browser' },
      env: {}
    }
  },

  buildSessionSetup(ctx: SessionSetupContext): SessionSetup {
    const promptPrefix = [...ctx.systemPromptAppends, ...(ctx.turnPromptReminders ?? [])]
      .filter((append): append is string => Boolean(append))
      .map((append) => renderAppMcpToolReferences('devin', append))
      .join('\n\n')
    return { ...(promptPrefix ? { promptPrefix } : {}) }
  },

  mapPermissionProfile(
    profile: PermissionProfileId,
    modes: SessionModeState | null | undefined
  ): PermissionProfileApplication {
    return resolvePermissionProfileApplication(profile, modes, {
      brokerEnforcesFullAccess: true
    })
  }
})
