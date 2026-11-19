// What every command works with: the repository, GitHub, the configuration,
// and where output goes.

import { loadConfig, loadLocalConfig, type Flags } from "./config.ts"
import { GitHub } from "./github.ts"
import type { Config } from "./model.ts"
import { consoleOut, type Out } from "./output.ts"
import { Repo } from "./repo.ts"

/** What a command that needs no GitHub works with */
export interface LocalCtx {
  repo: Repo
  config: Pick<Config, "main" | "remote">
}

export interface Ctx extends LocalCtx {
  gh: GitHub
  config: Config
  out: Out
  /** Tests pass a no-op */
  sleep(ms: number): Promise<void>
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** A context for a directory in a jj workspace: its repository, its config
 * and token, and a GitHub client. */
export async function openContext(
  cwd: string,
  options: {
    flags?: Flags
    env?: Record<string, string>
    fetch?: typeof fetch
    out?: Out
    sleep?: Ctx["sleep"]
  } = {},
): Promise<Ctx> {
  const flags = options.flags ?? {}
  const repo = await Repo.open(cwd, options.env)
  const { config, token } = await loadConfig(repo, flags, options.env)
  repo.remote = config.remote
  return {
    repo,
    gh: new GitHub({ config, token, fetch: options.fetch }),
    config,
    out: options.out ?? consoleOut,
    sleep: options.sleep ?? sleep,
  }
}

/** A context for a directory in a jj workspace without GitHub: its
 * repository and the main branch and remote. Unlike `openContext`, it needs
 * no token, branch prefix, or GitHub repository. */
export async function openLocalContext(
  cwd: string,
  options: { env?: Record<string, string> } = {},
): Promise<LocalCtx> {
  const repo = (await Repo.open(cwd, options.env)).reading()
  const config = await loadLocalConfig(repo)
  repo.remote = config.remote
  return { repo, config }
}

/** Snapshot the working copy, as any jj command does, so that the reads
 * after it see the files as they are */
export const snapshot = async (ctx: LocalCtx): Promise<void> => {
  await ctx.repo.snapshot()
}

/** `ctx` for a command that only reads: its jj calls take no snapshot of the
 * working copy (`Repo.reading`). `status`, `resolveStack`, and dry runs use it. */
export const reading = <C extends LocalCtx>(ctx: C): C => ({
  ...ctx,
  repo: ctx.repo.reading(),
})
