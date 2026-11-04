import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseNvidiaSmi, systemInfo } from './system'

describe('system', () => {
  it('picks the GPU with the most free memory and tolerates odd lines', () => {
    expect(parseNvidiaSmi('A, 8192, 1024\nB, 24576, 20480\r\n')).toMatchObject({ name: 'B', freeGB: 20 })
    expect(parseNvidiaSmi('NVIDIA RTX, Inc X, 24576, 20480')).toMatchObject({ name: 'NVIDIA RTX, Inc X', vramGB: 24 })
    expect(parseNvidiaSmi('GPU, [N/A], [N/A]')).toBeNull()
    expect(parseNvidiaSmi('GPU, , ')).toBeNull()
  })
  it('gives up on an nvidia-smi that ignores SIGTERM instead of hanging', async () => {
    const bin = mkdtempSync(join(tmpdir(), 'forge-smi-'))
    writeFileSync(join(bin, 'nvidia-smi'), '#!/bin/sh\ntrap "" TERM\nexec sleep 30\n')
    chmodSync(join(bin, 'nvidia-smi'), 0o755)
    const path = process.env.PATH
    process.env.PATH = `${bin}:${path}`
    try {
      const t = Date.now()
      expect((await systemInfo(bin)).gpu).toBeNull()
      expect(Date.now() - t).toBeLessThan(10_000)
    } finally {
      process.env.PATH = path
    }
  }, 20_000)
})
