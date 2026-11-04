import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio
} from 'node:child_process'
import { join } from 'node:path'

import type { PermissionProfileId } from '../../shared/permission-profiles'
import {
  resolvePermissionProfileApplication,
  type PermissionProfileApplication
} from '../acp/permission-profile-controller'
import type { SessionModeState } from '@agentclientprotocol/sdk'
import type { ResolvedProvider } from '../settings/provider-env'
import { augmentedPathEnv } from '../settings/shell-path'
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

export const devinStorageDir = (storageRoot: string): string => join(storageRoot, 'devin')

// Devin runs its own ACP server (`devin acp`). Authentication and model selection live in Devin
// Cloud: the agent reads `WINDSURF_API_KEY` first, then the credentials stored by
// `devin auth login`, and also accepts a runtime ACP `authenticate` request or the `/login` slash
// command. No app provider endpoint is translated for it, so supportedApiTypes stays empty and the
// devin-subscription provider type is the only usable pairing.
export const createDevinFramework = ({
  platform = process.platform,
  sourceEnv = process.env,
  spawnProcess = spawn as SpawnProcess
}: DevinFrameworkDeps = {}): AgentFramework => ({
  id: 'devin',
  displayName: 'Devin',
  contextCompaction: { kind: 'native-command', command: '/compact', triggerAtPercent: 90 },
  supportsSkills: false,
  supportsDelegatedWork: false,
  acceptsStdioMcp: true,
  // Effort is a Devin-server concept; no ACP thought_level option is advertised.
  supportsLiveEffortChange: false,
  supportedApiTypes: [],
  // The ACP server tracks its own workspace/session state; keep dispatches serialized.
  serializesProviderPrompts: true,

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
    // The Devin subscription provider may carry an API key (WINDSURF_API_KEY) and/or a preferred
    // model; when absent the CLI falls back to `devin auth login` credentials and account defaults.
    const env: Record<string, string> = { NO_BROWSER: '1' }
    if (provider.key) env.WINDSURF_API_KEY = provider.key
    return {
      env,
      ...(provider.model
        ? { args: ['--model', provider.model], sessionModel: provider.model }
        : {})
    }
  },

  buildSessionSetup(ctx: SessionSetupContext): SessionSetup {
    const promptPrefix = [...ctx.systemPromptAppends, ...(ctx.turnPromptReminders ?? [])]
      .filter((append): append is string => Boolean(append))
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

export const devinFramework = createDevinFramework()
