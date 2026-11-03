import { defineConfig } from 'vitest/config'

// Real model calls: slow, needs Ollama or API keys. Not part of `npm test`.
export default defineConfig({ test: { include: ['src/eval/**/*.eval.ts'], testTimeout: 3_600_000 } })
