import { extname } from 'node:path'

// "Open page" hands a file to the system's default app. Only types that open in a viewer: never anything that could run
// (.sh, .desktop, .AppImage, .exe, .bat, .jar ...), because the file name comes from what the agent wrote.
const SAFE = new Set(['html', 'htm', 'svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf', 'md', 'txt', 'json', 'css', 'csv'])

export const isPreviewable = (path: string): boolean => SAFE.has(extname(path).slice(1).toLowerCase())
export const isPage = (path: string): boolean => /\.html?$/i.test(path)
