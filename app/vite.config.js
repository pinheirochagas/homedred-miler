import { defineConfig } from 'vite'

export default defineConfig({
  // .env lives at repo root. Expose ONLY the public pk token to the client —
  // MAPBOX_SECRET must never match this prefix.
  envDir: '..',
  envPrefix: ['VITE_', 'MAPBOX_TOKEN'],
})
