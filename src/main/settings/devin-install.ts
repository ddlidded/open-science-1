import type { InstallTarget } from './claude-install'

export const DEVIN_VERSION = '3000.11.234'

export const DEVIN_INSTALL_TARGET: InstallTarget = {
  npmPackage: 'devin',
  // Devin exposes no supported shell installer; InstallDevinRequest cannot select this branch.
  scriptUnix: ''
}
