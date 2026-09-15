import { defineConfig } from 'tsdown'

/** Keep the service and checker self-contained; their shared validators have no mutable state. */
export default defineConfig(({ env }) => env?.DSH_BUILD_FACE === 'client' ? [] : [
  'lib/types/index.js', 'lib/types/invariant.js',
].map(entry => ({
  entry: [entry],
  outDir: 'lib',
  format: ['esm' as const],
  platform: 'node' as const,
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})))
