// The command line. Each command opens a context and calls the library
// function that does the work. The log goes to stdout, or to stderr with
// --json, which prints the result or the error as one JSON document on stdout.

import { Command, CommanderError } from "@commander-js/extra-typings"

import pkg from "../package.json" with { type: "json" }

import { adopt } from "./commands/adopt.ts"
import { close } from "./commands/close.ts"
import { init } from "./commands/init.ts"
import { land } from "./commands/land.ts"
import { printStatus, status } from "./commands/status.ts"
import { submit } from "./commands/submit.ts"
import { sync } from "./sync.ts"
import type { Flags } from "./config.ts"
import { openContext, snapshot, type Ctx } from "./context.ts"
import { JjackError, toJjackError, type Source } from "./model.ts"
import { captureOut, printError } from "./output.ts"
import { Repo } from "./repo.ts"

export interface Deps {
  cwd?: string
  env?: Record<string, string>
  fetch?: typeof fetch
  /** Takes one line or block of text at a time, like console.log */
  stdout?: (text: string) => void
  stderr?: (text: string) => void
  sleep?: Ctx["sleep"]
}

/** The stack file or the revision of a command that takes either */
function source(path: string | undefined, revision: string | undefined): Source {
  if ((path === undefined) === (revision === undefined)) {
    throw new JjackError(
      "usage",
      "Pass a stack file, or -r <revision> for changes with `Pull Request:` lines.",
    )
  }
  return path !== undefined ? { file: path } : { revision: revision! }
}

/** Run jjack with `argv` (without the node and script paths). Returns the exit
 * code: 0 when the command did what it was asked, 1 when it refused or
 * failed, and 2 for a usage error. */
export async function main(argv: string[], deps: Deps = {}): Promise<number> {
  const stdout = deps.stdout ?? console.log
  const stderr = deps.stderr ?? console.error
  const cwd = deps.cwd ?? process.cwd()
  const program = new Command("jjack")
    .description("Stacks of GitHub pull requests from jj changes")
    .version(pkg.version)
    .option("--token <token>", "GitHub token (default: jjack.token, then `gh auth token`)")
    .option(
      "--repository <owner/repo>",
      "GitHub repository (default: jjack.repository, then the remote's URL)",
    )
    .option(
      "--branch-prefix <prefix>",
      "prefix for new branch names (default: jjack.branchPrefix)",
    )
    .option("--json", "print the result or the error as JSON, and the log on stderr")
    .exitOverride()
    .configureOutput({
      writeOut: (text) => stdout(text.replace(/\n$/, "")),
      writeErr: (text) => stderr(text.replace(/\n$/, "")),
    })
  const json = () => !!program.opts().json
  // Options are parsed before a command logs anything
  const out = captureOut((text) => (json() ? stderr : stdout)(text))
  let command: string | null = null
  let result: unknown
  program.hook("preSubcommand", (_program, subcommand) => {
    command = subcommand.name()
  })

  // The library's reads take no snapshot of the working copy. A person
  // running a command expects it to see the files as they are, so the command
  // line takes one first.
  const context = async () => {
    const { json: _, ...flags }: Flags & { json?: true } = program.opts()
    const ctx = await openContext(cwd, {
      flags,
      env: deps.env,
      fetch: deps.fetch,
      out,
      sleep: deps.sleep,
    })
    await snapshot(ctx)
    return ctx
  }

  program
    .command("init")
    .description("Write a new stack file with an entry for each tip, bottom first")
    .argument("<path>", "the stack file to create")
    .requiredOption("--tips <revset>", "the tip of each pull request")
    .action(async (path, options) => {
      result = await init({ repo: await Repo.open(cwd, deps.env), out }, path, options)
    })

  program
    .command("status")
    .description("Check a stack file and show what submit would do with it")
    .argument("<path>", "the stack file")
    .action(async (path) => {
      const checked = await status(await context(), path)
      result = checked
      if (!json()) printStatus(out, checked)
    })

  program
    .command("adopt")
    .description("Take over pull requests opened without jjack, by their branch names")
    .argument("<path>", "the stack file")
    .option(
      "--copy-github-text",
      "copy each pull request's title and body into its body file",
    )
    .option("--dry-run", "show what would be adopted, changing nothing")
    .action(async (path, options) => {
      result = await adopt(await context(), path, options)
    })

  program
    .command("submit")
    .description(
      "Open or update the pull requests of a stack file, or of the changes up to -r",
    )
    .argument("[path]", "the stack file")
    .option(
      "-r, --revision <rev>",
      "submit the changes from the main branch up to this one",
    )
    .option("--upto <tip>", "submit only the entries up to this one")
    .option(
      "-m, --message <message>",
      "message for the last commit of each update (default: Update, or Merge … for a merge)",
    )
    .option("--overwrite-github", "replace titles and bodies edited on GitHub")
    .option("--draft", "open new pull requests as drafts")
    .option(
      "--discard-remote-changes",
      "push even if a pull request has commits that are not in its local changes (someone else pushed to it); their edits stay in the branch's history but leave the pull request's diff",
    )
    .option("--dry-run", "show what would happen, changing nothing")
    .action(async (path, { revision, ...options }) => {
      const from = source(path, revision)
      result = await submit(await context(), from, options)
    })

  program
    .command("land")
    .description("Merge the pull requests of a stack file, or of the changes up to -r")
    .argument("[path]", "the stack file")
    .option("-r, --revision <rev>", "land the changes from the main branch up to this one")
    .option("--upto <tip>", "land only the entries up to this one")
    .option("--no-sync", "leave the landed changes for `jjack sync`")
    .action(async (path, { revision, ...options }) => {
      const from = source(path, revision)
      result = await land(await context(), from, options)
    })

  program
    .command("sync")
    .description("Abandon the changes whose pull requests merged and rebase the rest")
    .argument("[path]", "the stack file")
    .option("-r, --revision <rev>", "sync the changes from the main branch up to this one")
    .option("--dry-run", "show what would happen, changing nothing")
    .action(async (path, { revision, ...options }) => {
      const from = source(path, revision)
      result = await sync(await context(), from, options)
    })

  program
    .command("close")
    .description("Close pull requests and delete their branches")
    .argument("[path]", "the stack file")
    .option("-r, --revision <rev>", "close the pull request of this change")
    .option("--pr <tip>", "close the pull request of this entry")
    .option("--all", "close every pull request of the file, or up to -r")
    .action(async (path, { revision, ...options }) => {
      const from = source(path, revision)
      result = await close(await context(), from, options)
    })

  const print = (document: object) =>
    stdout(JSON.stringify({ ...document, warnings: out.warnings }, null, 2))
  try {
    await program.parseAsync(argv, { from: "user" })
    if (json()) print({ ok: true, command, result })
    return 0
  } catch (e) {
    if (e instanceof CommanderError) {
      // Help and --version end with exit code 0, and commander has printed
      // why anything else failed
      if (e.exitCode === 0) return 0
      if (json())
        print({ ok: false, command, error: { code: "usage", message: e.message } })
      return 2
    }
    const error = toJjackError(e)
    printError(out, error)
    if (json()) {
      const partial = error.partial === undefined ? {} : { partial: error.partial }
      print({ ok: false, command, error: error.toJSON(), ...partial })
    }
    return error.code === "usage" ? 2 : 1
  }
}
