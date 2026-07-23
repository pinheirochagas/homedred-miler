import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { defineConfig } from 'vite'

const FONT_URL = 'https://st.1001fonts.net/download/font/monster-blood.regular.ttf'
const FONT_SHA256 = '6292b24d4e20b84e29e0c8551a4ad79060aec029604aebf2617b4570dff8f487'
const fontDir = new URL('./src/assets/fonts/', import.meta.url)
const fontFile = new URL('./src/assets/fonts/monster-blood.ttf', import.meta.url)
const sha256 = data => createHash('sha256').update(data).digest('hex')

async function ensureMonsterBloodFont() {
  try {
    const localFont = await readFile(fontFile)
    if (sha256(localFont) === FONT_SHA256) return
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }

  const response = await fetch(FONT_URL)
  if (!response.ok) {
    throw new Error(`Could not download Monster Blood font (${response.status})`)
  }

  const downloadedFont = Buffer.from(await response.arrayBuffer())
  if (sha256(downloadedFont) !== FONT_SHA256) {
    throw new Error('Downloaded Monster Blood font failed its integrity check')
  }

  await mkdir(fontDir, { recursive: true })
  await writeFile(fontFile, downloadedFont)
}

export default defineConfig(async () => {
  await ensureMonsterBloodFont()

  return {
    // .env lives at repo root. Expose ONLY the public pk token to the client —
    // MAPBOX_SECRET must never match this prefix.
    envDir: '..',
    envPrefix: ['VITE_', 'MAPBOX_TOKEN'],
  }
})
