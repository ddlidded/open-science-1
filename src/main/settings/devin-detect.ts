import path from 'node:path'

import {
  collectCandidateDirs,
  createDefaultDetectDeps,
  type OpencodeDetectDeps
} from './opencode-detect'

export type DevinDetectDeps = OpencodeDetectDeps
export type DevinDetectResult = { resolvedPath: string; version?: string }

// `devin acp` ships on every released CLI build, so any binary that reports a version is usable.
const binaryNames = (platform: NodeJS.Platform): string[] =>
  platform === 'win32' ? ['devin.cmd', 'devin.exe', 'devin.bat', 'devin'] : ['devin']

export const detectDevin = async (
  deps: DevinDetectDeps = createDefaultDetectDeps(),
  signal?: AbortSignal
): Promise<DevinDetectResult | undefined> => {
  signal?.throwIfAborted()
  const pathApi = deps.platform === 'win32' ? path.win32 : path.posix
  for (const dir of await collectCandidateDirs(deps, signal)) {
    for (const name of binaryNames(deps.platform)) {
      const candidate = pathApi.join(dir, name)
      const executable = await deps.isExecutable(candidate)
      signal?.throwIfAborted()
      if (!executable) continue
      const version = await deps.getVersion(candidate, signal)
      signal?.throwIfAborted()
      if (version === undefined) continue
      return { resolvedPath: candidate, version }
    }
  }
  return undefined
}
