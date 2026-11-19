import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    // A scenario runs hundreds of jj and git processes, and the full suite
    // runs many scenarios at once, so one can take minutes
    testTimeout: 180_000,
    hookTimeout: 60_000,
  },
})
