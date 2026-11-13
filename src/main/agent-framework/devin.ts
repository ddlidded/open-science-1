import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio
} from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
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
import {
  createSkillRuntimeAcpServerConfig,
  OPEN_SCIENCE_SKILL_RUNTIME_SESSION_OPTION
} from '../skills/runtime-mcp-server'
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

// Devin's ACP server ignores the CLI credential store by design, but accepts `meta.api_key` on
// the authenticate request. Reusing the `devin auth login` key avoids reopening the PKCE browser
// flow for every new connection.
const devinApiKey = (sourceEnv: NodeJS.ProcessEnv): string | undefined => {
  const fromEnv = sourceEnv.WINDSURF_API_KEY ?? sourceEnv.DEVIN_API_KEY
  if (fromEnv?.trim()) return fromEnv.trim()
  try {
    const credentials = readFileSync(
      join(homedir(), '.local', 'share', 'devin', 'credentials.toml'),
      'utf8'
    )
    const match = credentials.match(/^\s*windsurf_api_key\s*=\s*"([^"]+)"/m)
    return match?.[1]?.trim() || undefined
  } catch {
    return undefined
  }
}

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
      // authenticate each connection over ACP. Passing the stored API key as meta.api_key resolves
      // silently; without it `devin-browser` drives the PKCE browser sign-in.
      authentication: (() => {
        const apiKey = devinApiKey(sourceEnv)
        return apiKey
          ? { methodId: 'devin-browser', _meta: { api_key: apiKey } }
          : { methodId: 'devin-browser' }
      })(),
      env: {}
    }
  },

  buildSessionSetup(ctx: SessionSetupContext): SessionSetup {
    const runtime = ctx.sessionOptions?.[OPEN_SCIENCE_SKILL_RUNTIME_SESSION_OPTION] as
      | {
          command?: string
          entryPath?: string
          root?: string
          skillsDirectory?: string
          allowedNames?: string[]
        }
      | undefined
    const loaderAvailable =
      ctx.skillRuntimeScope !== undefined &&
      (ctx.skillRuntimeScope === 'all' || ctx.skillRuntimeScope.length > 0) &&
      typeof runtime?.command === 'string' &&
      typeof runtime.entryPath === 'string' &&
      typeof runtime.root === 'string' &&
      typeof runtime.skillsDirectory === 'string'
    const promptPrefix = [...ctx.systemPromptAppends, ...(ctx.turnPromptReminders ?? [])]
      .filter((append): append is string => Boolean(append))
      .map((append) => renderAppMcpToolReferences('devin', append))
      .join('\n\n')
    return {
      ...(loaderAvailable
        ? {
            mcpServers: [
              createSkillRuntimeAcpServerConfig({
                command: runtime!.command!,
                entryPath: runtime!.entryPath!,
                root: runtime!.root!,
                skillsDirectory: runtime!.skillsDirectory!,
                ...(ctx.skillRuntimeScope !== 'all' ? { allowedNames: ctx.skillRuntimeScope } : {})
              })
            ]
          }
        : {}),
      ...(promptPrefix ? { promptPrefix } : {})
    }
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
