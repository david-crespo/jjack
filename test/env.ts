// A jj repository whose `origin` is a bare Git repository behind the fake
// GitHub, plus helpers for driving jj and jjack and checking the result. A
// port of `tests/common/env.rs` from papertigers/jj-spr's `native-stacks`
// branch.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect } from "vitest"
import { main } from "../src/cli.ts"
import { run } from "../src/proc.ts"
import { FakeGitHub, type FakePullRequest } from "./fake_github.ts"

/** Set JJACK_TEST_VERBOSE=1 to print every command and its output */
const verbose = Boolean(process.env.JJACK_TEST_VERBOSE)

/** A command's result: whether it succeeded, and its stdout and stderr */
export interface Outcome {
  success: boolean
  /** stdout and stderr, in the order they were written */
  text: string
  /** The text with whitespace runs collapsed to one space, for substring checks */
  flat: string
}

/** jjack's outcome: its exit code, and stdout alone, too */
export type JjackOutcome = Outcome & { code: number; stdout: string }

const outcome = (success: boolean, text: string): Outcome => ({
  success,
  text,
  flat: text.trim().split(/\s+/).join(" "),
})

async function command(
  cwd: string,
  env: Record<string, string>,
  program: string,
  args: string[],
): Promise<Outcome & { stdout: string }> {
  const output = await run(program, args, { cwd, env: { ...process.env, ...env } })
  const text = output.stdout + output.stderr
  if (verbose) console.error(`$ ${program} ${args.join(" ")}\n${text}`)
  return { ...outcome(output.success, text), stdout: output.stdout }
}

function succeeded(result: Outcome, what: string): void {
  expect(result.success, `${what} failed:\n${result.text}`).toBe(true)
}

export class TestEnv {
  readonly root: string
  readonly work: string
  readonly seed: string
  readonly gh: FakeGitHub
  /** The variables every jj and git call gets over `process.env`, and the
   * `env` that jjack's `main` gets */
  readonly env: Record<string, string>

  private constructor(root: string, gh: FakeGitHub, env: Record<string, string>) {
    this.root = root
    this.work = join(root, "work")
    this.seed = join(root, "seed")
    this.gh = gh
    this.env = env
  }

  /** A temp root with `remote.git` (bare, branch `main`, one commit pushed
   * from the `seed` clone), the fake GitHub on it, and a `work` clone made
   * with jj. Dispose of it with `await using`. */
  static async create(options: { stacks?: boolean } = {}): Promise<TestEnv> {
    const root = await mkdtemp(join(tmpdir(), "jjack-test-"))
    const env = {
      JJ_CONFIG: join(root, "jj-config.toml"),
      // jj keeps a repository's config under the config directory, which may
      // not be writable in a sandbox
      XDG_CONFIG_HOME: join(root, "config"),
      JJ_USER: "Test User",
      JJ_EMAIL: "test@example.com",
      GIT_AUTHOR_NAME: "Test User",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test User",
      GIT_COMMITTER_EMAIL: "test@example.com",
      GIT_CONFIG_GLOBAL: join(root, "gitconfig"),
      NO_COLOR: "1",
    }
    await writeFile(
      env.JJ_CONFIG,
      `[jjack]
repository = "fake/repo"
branchPrefix = "spr/"
token = "fake-token"
apiUrl = "https://api.github.test"
`,
    )
    await writeFile(env.GIT_CONFIG_GLOBAL, "")
    await mkdir(env.XDG_CONFIG_HOME)

    const remote = join(root, "remote.git")
    const seed = join(root, "seed")
    const ok = async (cwd: string, program: string, args: string[]) =>
      succeeded(await command(cwd, env, program, args), `${program} ${args.join(" ")}`)
    await ok(root, "git", ["init", "-q", "--bare", "-b", "main", remote])
    await ok(root, "git", ["clone", "-q", remote, seed])
    await writeFile(join(seed, "README"), "hello\n")
    await ok(seed, "git", ["add", "README"])
    await ok(seed, "git", ["commit", "-q", "-m", "Initial commit"])
    await ok(seed, "git", ["push", "-q", "origin", "main"])

    const gh = new FakeGitHub({
      owner: "fake",
      name: "repo",
      gitDir: remote,
      stacksEnabled: options.stacks ?? true,
    })
    await ok(root, "jj", ["git", "clone", "--colocate", remote, join(root, "work")])
    return new TestEnv(root, gh, env)
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await rm(this.root, { recursive: true, force: true })
  }

  // -- commands --------------------------------------------------------------

  /** Run jj in the work clone and require it to succeed. Returns stdout and
   * stderr. */
  async jj(args: string[]): Promise<string> {
    const result = await command(this.work, this.env, "jj", args)
    succeeded(result, `jj ${args.join(" ")}`)
    return result.text
  }

  /** Run jj for its output only, without the notices it prints on stderr */
  async jjQuery(args: string[]): Promise<string> {
    const result = await command(this.work, this.env, "jj", args)
    succeeded(result, `jj ${args.join(" ")}`)
    return result.stdout
  }

  /** Run jjack's CLI in this process and return its outcome, whether or not
   * it succeeded */
  async tryJjack(args: string[], options: { cwd?: string } = {}): Promise<JjackOutcome> {
    let text = ""
    let stdout = ""
    const code = await main(args, {
      cwd: options.cwd ?? this.work,
      env: this.env,
      fetch: this.gh.fetch,
      stdout: (line) => {
        text += `${line}\n`
        stdout += `${line}\n`
      },
      stderr: (line) => void (text += `${line}\n`),
      sleep: async () => {},
    })
    if (verbose) console.error(`$ jjack ${args.join(" ")} (exit ${code})\n${text}`)
    return { ...outcome(code === 0, text), code, stdout }
  }

  /** Run jjack's CLI and require it to succeed */
  async jjack(args: string[], options: { cwd?: string } = {}): Promise<JjackOutcome> {
    const result = await this.tryJjack(args, options)
    succeeded(result, `jjack ${args.join(" ")}`)
    return result
  }

  /** Run git in `cwd` and require it to succeed. Returns its output, trimmed. */
  async gitIn(cwd: string, args: string[]): Promise<string> {
    const result = await command(cwd, this.env, "git", args)
    succeeded(result, `git ${args.join(" ")}`)
    return result.text.trim()
  }

  /** Push a commit of the work clone to a branch on GitHub */
  async pushCommit(commit: string, branch: string): Promise<void> {
    await this.gitIn(this.work, ["push", "-q", "origin", `${commit}:refs/heads/${branch}`])
  }

  /** Create a change on top of `@-`. Returns its change ID. */
  async commit(title: string, path: string, content: string): Promise<string> {
    await writeFile(join(this.work, path), content)
    await this.jj(["commit", "-m", title])
    return this.changeId("@-")
  }

  async changeId(rev: string): Promise<string> {
    return (await this.jjQuery(["log", "--no-graph", "-r", rev, "-T", "change_id"])).trim()
  }

  async commitId(rev: string): Promise<string> {
    return (await this.jjQuery(["log", "--no-graph", "-r", rev, "-T", "commit_id"])).trim()
  }

  // -- observations ----------------------------------------------------------

  /** The number in a change's `Pull Request:` line */
  async prFor(change: string): Promise<number> {
    const description = await this.description(change)
    const line = description.split("\n").find((l) => l.startsWith("Pull Request:"))
    const number = Number(line?.trim().split("/").pop())
    if (!line || !Number.isInteger(number)) {
      throw new Error(`change ${change} has no pull request line:\n${description}`)
    }
    return number
  }

  prsFor(changes: string[]): Promise<number[]> {
    return Promise.all(changes.map((c) => this.prFor(c)))
  }

  description(change: string): Promise<string> {
    return this.jjQuery(["log", "--no-graph", "-r", change, "-T", "description"])
  }

  /** The subjects of the commits on a pull request's branch that are not on
   * its base branch, oldest first */
  prCommits(number: number): string[] {
    const pr = this.pr(number)
    const log = this.remoteGit([
      "log",
      "--reverse",
      "--format=%s",
      `${pr.baseRef}..${pr.headRef}`,
    ])
    return log.split("\n").filter(Boolean)
  }

  /** A pull request is open, targets `base`, shows `files`, and has the tree
   * of `top`, its top change */
  async checkPr(number: number, base: string, files: string[], top: string): Promise<void> {
    const pr = this.pr(number)
    expect(pr.state, `PR #${number} is ${pr.state}`).toBe("open")
    expect(pr.baseRef, `PR #${number}'s base`).toBe(base)
    expect(this.prFiles(number), `files in PR #${number}'s diff`).toEqual(files)
    expect(this.treeOfPr(number), `PR #${number}'s tree`).toBe(await this.treeOf(top))
  }

  /** A copy of a pull request's state on the fake */
  pr(number: number): FakePullRequest {
    const pr = this.gh.prs.get(number)
    if (!pr) throw new Error(`no pull request #${number}`)
    return structuredClone(pr)
  }

  /** A branch's head on GitHub */
  branch(name: string): string | undefined {
    return this.gh.branches().get(name)
  }

  headOf(number: number): string {
    const headRef = this.pr(number).headRef
    const head = this.branch(headRef)
    if (head === undefined) throw new Error(`PR #${number}'s branch ${headRef} is missing`)
    return head
  }

  /** git on the bare repository behind the fake */
  remoteGit(args: string[]): string {
    return this.gh.git(args)
  }

  isAncestor(ancestor: string, descendant: string): boolean {
    return this.gh.isAncestor(ancestor, descendant)
  }

  /** The files a change touches, sorted */
  async filesIn(change: string): Promise<string[]> {
    const listing = await this.jjQuery(["diff", "--name-only", "-r", change])
    return listing.split(/\s+/).filter(Boolean).sort()
  }

  /** The files in GitHub's diff for a pull request: changes on its head since
   * its merge base with its base */
  prFiles(number: number): string[] {
    const pr = this.pr(number)
    const heads = this.gh.branches()
    const head = heads.get(pr.headRef)!
    const mergeBase = this.remoteGit(["merge-base", heads.get(pr.baseRef)!, head])
    return this.remoteGit(["diff", "--name-only", mergeBase, head])
      .split(/\s+/)
      .filter(Boolean)
      .sort()
  }

  /** Each commit on main after `since`, oldest first, as its subject and the
   * files it changes: "Change A: a.txt" */
  landedSince(since: string): string[] {
    return this.remoteGit([
      "log",
      "--reverse",
      "--format=%x00%s:",
      "--name-only",
      `${since}..main`,
    ])
      .split("\0")
      .map((commit) => commit.trim().split(/\s+/).join(" "))
      .filter(Boolean)
  }

  /** A copy of the fake's stacks */
  stacks(): Map<number, number[]> {
    return new Map([...this.gh.stacks].map(([n, members]) => [n, [...members]]))
  }

  /** The open members of each stack, leaving out stacks with none */
  activeStacks(): number[][] {
    return [...this.gh.stacks.values()]
      .map((members) => this.gh.active(members))
      .filter((active) => active.length > 0)
  }

  requestCount(): number {
    return this.gh.requests.length
  }

  /** Recorded requests since `from` with this method whose path contains
   * `fragment`, as "<METHOD> <path>" */
  requestsSince(from: number, method: string, fragment: string): string[] {
    return this.gh.requests
      .slice(from)
      .filter((r) => r.method === method && r.path.includes(fragment))
      .map((r) => `${r.method} ${r.path}`)
  }

  /** Whether a change is still visible (not abandoned) */
  async isVisible(change: string): Promise<boolean> {
    const id = await this.jjQuery([
      "log",
      "--no-graph",
      "-r",
      `present(${change})`,
      "-T",
      "change_id",
    ])
    return id.trim() !== ""
  }

  /** The tree of a local change */
  async treeOf(change: string): Promise<string> {
    return this.gitIn(this.work, ["rev-parse", `${await this.commitId(change)}^{tree}`])
  }

  /** The tree of a pull request's head */
  treeOfPr(number: number): string {
    return this.remoteGit(["rev-parse", `${this.headOf(number)}^{tree}`])
  }

  /** The commit ID of a change's parent */
  parentOf(change: string): Promise<string> {
    return this.commitId(`${change}-`)
  }

  /** Commit a new file on main from another clone and push it, as a colleague
   * would */
  async pushToMain(path: string, content: string): Promise<void> {
    await this.gitIn(this.seed, ["pull", "-q", "origin", "main"])
    await writeFile(join(this.seed, path), content)
    await this.gitIn(this.seed, ["add", path])
    await this.gitIn(this.seed, ["commit", "-q", "-m", `Add ${path}`])
    await this.gitIn(this.seed, ["push", "-q", "origin", "main"])
  }

  /** Commit a file on a pull request's branch from another clone and push it,
   * as a colleague would. Returns the branch's new head. */
  async pushToPrBranch(number: number, path: string, content: string): Promise<string> {
    const branch = this.pr(number).headRef
    await this.gitIn(this.seed, ["fetch", "-q", "origin", branch])
    await this.gitIn(this.seed, ["checkout", "-q", "-B", "colleague", "FETCH_HEAD"])
    await writeFile(join(this.seed, path), content)
    await this.gitIn(this.seed, ["add", path])
    await this.gitIn(this.seed, ["commit", "-q", "-m", `Change ${path}`])
    await this.gitIn(this.seed, ["push", "-q", "origin", `HEAD:${branch}`])
    await this.gitIn(this.seed, ["checkout", "-q", "main"])
    return this.headOf(number)
  }
}

/** Every pull request targets the one below, shows only its own change's
 * files, and has that change's tree, and the pull requests form one active
 * stack */
export async function checkChain(
  env: TestEnv,
  changes: string[],
  prs: number[],
): Promise<void> {
  for (const [i, number] of prs.entries()) {
    const pr = env.pr(number)
    const base = i === 0 ? "main" : env.pr(prs[i - 1]).headRef
    expect(pr.state, `PR #${number} is ${pr.state} (${pr.closedReason})`).toBe("open")
    expect(pr.baseRef, `PR #${number}'s base`).toBe(base)
    expect(env.prFiles(number), `files in PR #${number}'s diff`).toEqual(
      await env.filesIn(changes[i]),
    )
    expect(env.treeOfPr(number), `PR #${number}'s tree vs local change`).toBe(
      await env.treeOf(changes[i]),
    )
  }
  expect(env.activeStacks(), `expected stack ${prs.join(", ")}`).toContainEqual(prs)
}
