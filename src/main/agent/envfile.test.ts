import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { missingEnvFile } from './envfile'

const proj = (files: Record<string, string>) => {
  const d = mkdtempSync(join(tmpdir(), 'forge-env-'))
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(join(d, f, '..'), { recursive: true })
    writeFileSync(join(d, f), c)
  }
  return d
}

describe('missingEnvFile', () => {
  it('asks for .env.example when secrets are read from the environment', () => {
    expect(missingEnvFile(proj({ 'bot.js': 'const t = process.env.BOT_TOKEN' }))).toContain('BOT_TOKEN')
    expect(missingEnvFile(proj({ 'src/app.py': 'import os\nk = os.environ["API_KEY"]' }))).toContain('API_KEY')
  })
  it('stays quiet with an env file, for ordinary settings, and inside node_modules', () => {
    expect(missingEnvFile(proj({ 'bot.js': 'process.env.BOT_TOKEN', '.env.example': 'BOT_TOKEN=' }))).toBeNull()
    expect(missingEnvFile(proj({ 'a.js': 'process.env.PORT || 3000' }))).toBeNull()
    expect(missingEnvFile(proj({ 'node_modules/x/i.js': 'process.env.SECRET_KEY' }))).toBeNull()
  })
})
