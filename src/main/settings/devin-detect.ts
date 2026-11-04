import path from 'node:path'

import {
  collectCandidateDirs,
  createDefaultDetectDeps,
  type OpencodeDetectDeps
} from './opencode-detect'

export type DevinDetectDeps = OpencodeDetectDeps
export type DevinDetectResult = { resolvedPath: string; version?: string }

export const isSupportedDevinVersion = (
  version: string | undefined | null
): version is string => version !== undefined && version !== null

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
      if (isSupportedDevinVersion(version)) return { resolvedPath: candidate, version }
    }
  }
  return undefined
}
