import { defineConfig } from 'electron-vite'

export default defineConfig({
  // team-mcp is the small server each agent CLI launches (as a separate node process), so it is its own file
  main: { build: { rollupOptions: { input: { index: 'src/main/index.ts', 'team-mcp': 'src/main/team/mcpMain.ts' } } } },
  preload: { build: { rollupOptions: { input: 'src/preload/index.ts' } } },
  renderer: {
    root: 'src/renderer',
    build: { rollupOptions: { input: 'src/renderer/index.html' } },
  },
})
