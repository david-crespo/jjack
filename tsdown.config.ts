import { defineConfig } from "tsdown"

export default defineConfig({
  entry: ["jjack.ts"],
  outDir: "dist",
  clean: false,
  dts: false,
  outExtensions: () => ({ js: ".js" }),
  // commander is the only dependency, a dev dependency bundled in
  deps: { onlyBundle: false },
})
