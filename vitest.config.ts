import { defineConfig } from 'vitest/config'

// Many tests make throwaway folders in the temp directory (forge-orch-*, forge-git-*, remote-*, ...) and do not remove them; a few runs filled /tmp.
// After a run, everything with those prefixes that was created during the run is deleted.
export default defineConfig({ test: { globalSetup: ['./vitest.cleanup.ts'], exclude: ['**/node_modules/**', '**/out/**', '**/release/**', 'src/eval/**'] } })
