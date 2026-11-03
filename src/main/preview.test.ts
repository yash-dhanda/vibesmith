import { describe, expect, it } from 'vitest'
import { isPage, isPreviewable } from './preview'

describe('isPreviewable', () => {
  it('allows viewer file types, in any letter case', () => {
    for (const f of ['index.html', 'a/b/page.HTM', 'logo.svg', 'photo.JPG', 'notes.md', 'data.json', 'style.css', 'doc.pdf']) expect(isPreviewable(f), f).toBe(true)
  })
  it('refuses anything that could run or has no extension', () => {
    for (const f of ['run.sh', 'x.desktop', 'Forge.AppImage', 'setup.exe', 'a.bat', 'a.cmd', 'tool.jar', 'x.py', 'x.js', 'x.ps1', 'script', 'index.html.exe', '.bashrc', 'a.html.sh']) expect(isPreviewable(f), f).toBe(false)
  })
})

describe('isPage', () => {
  it('only html pages', () => {
    expect(isPage('site/index.html')).toBe(true)
    expect(isPage('a.HTM')).toBe(true)
    expect(isPage('a.svg')).toBe(false)
  })
})
