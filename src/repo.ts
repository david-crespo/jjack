// Every jj and git call. Git runs on the repository that `jj git root`
// prints, which covers colocated and non-colocated repositories and second
// workspaces alike.

import { JjackError, type Change, type Config } from "./model.ts"
import { run, type Output } from "./proc.ts"
import { mainRef, quote } from "./text.ts"

const CHANGE_TEMPLATE =
  `'{"commit":' ++ json(commit_id) ++ ',"changeId":' ++ json(change_id) ++ ` +
  `',"parents":[' ++ parents.map(|p| json(p.commit_id())).join(",") ++ ` +
  `'],"description":' ++ json(description) ++ ',"conflict":' ++ json(conflict) ++ "}\\n"`

const BOOKMARKED_TEMPLATE =
  `'{"commit":' ++ json(commit_id) ++ ',"changeId":' ++ json(change_id) ++ ` +
  `',"bookmarks":' ++ json(local_bookmarks.map(|b| b.name())) ++ "}\\n"`

export class Repo {
  /** The workspace root */
  readonly root: string
  readonly gitDir: string
  /** The GitHub remote, which `openContext` sets from the config */
  remote = "origin"
  readonly #env: NodeJS.ProcessEnv
  #trees = new Map<string, string>()
  /** Whether jj runs with --ignore-working-copy */
  #reading = false

  private constructor(root: string, gitDir: string, env: NodeJS.ProcessEnv) {
    this.root = root
    this.gitDir = gitDir
    this.#env = env
  }

  /**
   * This repository for a command that only reads. A jj command snapshots the
   * working copy first, which makes an operation when files changed. A
   * program that reads on every operation would then never stop, and a server
   * would snapshot while someone is in the middle of an edit. The copy runs
   * jj with --ignore-working-copy, so it sees the repository as of the last
   * snapshot.
   */
  reading(): Repo {
    const repo = new Repo(this.root, this.gitDir, this.#env)
    repo.remote = this.remote
    repo.#trees = this.#trees
    repo.#reading = true
    return repo
  }

  /** `env` is merged over `process.env` for every child process. Opening
   * takes no snapshot. */
  static async open(cwd: string, env: Record<string, string> = {}): Promise<Repo> {
    const merged = { ...process.env, ...env }
    const root = await run(jjBin(merged), ["root"], { cwd, env: merged })
    if (!root.success) {
      throw new JjackError(
        "not_a_repository",
        "This command requires a Jujutsu repository. Could not find a Jujutsu workspace " +
          "in the current directory.",
      )
    }
    const repo = new Repo(root.stdout.trim(), "", merged).reading()
    const gitDir = (await repo.jj(["git", "root"])).trim()
    return new Repo(repo.root, gitDir, merged)
  }

  /** Snapshot the working copy, also from a `reading` copy */
  async snapshot(): Promise<void> {
    const repo = new Repo(this.root, this.gitDir, this.#env)
    await repo.jj(["util", "snapshot"])
  }

  /** stdout of jj, run at the root. Throws on a nonzero exit, with jj's stderr. */
  async jj(args: string[]): Promise<string> {
    const flags = this.#reading ? ["--ignore-working-copy"] : []
    const output = await run(jjBin(this.#env), [...flags, ...args], {
      cwd: this.root,
      env: this.#env,
    })
    if (!output.success) {
      throw new JjackError(
        "jj",
        `jujutsu exited with code ${output.code ?? "(unknown)"}, stderr:\n${output.stderr}`,
      )
    }
    return output.stdout
  }

  /** git --git-dir <gitDir> …. Never throws for a nonzero exit. */
  git(args: string[], options: { input?: string; env?: Record<string, string> } = {}) {
    return run("git", ["--git-dir", this.gitDir, ...args], {
      cwd: this.root,
      env: { ...this.#env, ...options.env },
      input: options.input,
    })
  }

  /** Like `git`, but throws on a nonzero exit, and returns stdout */
  async #gitOk(args: string[]): Promise<string> {
    const output = await this.git(args)
    if (!output.success) {
      throw new JjackError("git", `git ${args[0]} failed: ${output.stderr.trim()}`)
    }
    return output.stdout
  }

  /** The commits of `revset`, top first, as jj log lists them */
  async commitIds(revset: string): Promise<string[]> {
    const listing = await this.jj([
      "log",
      "--no-graph",
      "-r",
      revset,
      "-T",
      'commit_id ++ "\\n"',
    ])
    return listing.split("\n").filter((line) => line.trim() !== "")
  }

  /** The changes of `revset`, bottom first */
  async changes(revset: string): Promise<Change[]> {
    const listing = await this.jj([
      "log",
      "--no-graph",
      "-r",
      revset,
      "-T",
      CHANGE_TEMPLATE,
    ])
    return listing
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as Change)
      .reverse()
  }

  /** The commits of `revset`, with their change IDs and the names of their
   * local bookmarks */
  async commitsWithBookmarks(
    revset: string,
  ): Promise<{ commit: string; changeId: string; bookmarks: string[] }[]> {
    const listing = await this.jj([
      "log",
      "--no-graph",
      "-r",
      revset,
      "-T",
      BOOKMARKED_TEMPLATE,
    ])
    return listing
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line))
  }

  /** The conflicted changes in `revset`, one per line as `<short change ID>
   * <title>`, or "" */
  async conflicted(revset: string): Promise<string> {
    const listing = await this.jj([
      "log",
      "--no-graph",
      "-r",
      `conflicts() & (${revset})`,
      "-T",
      'change_id.short() ++ " " ++ description.first_line() ++ "\\n"',
    ])
    return listing.trimEnd()
  }

  /** Every version of the change that `commit` is, newest first, leaving out
   * any that are not in the Git repository */
  async evolog(commit: string): Promise<string[]> {
    const listing = await this.jj([
      "evolog",
      "--no-graph",
      "-r",
      commit,
      "-T",
      'commit.commit_id() ++ "\\n"',
    ])
    const versions = listing
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /^[0-9a-f]{40}$/.test(line))
    const present = await Promise.all(versions.map((v) => this.treeIfPresent(v)))
    return versions.filter((_, i) => present[i] !== null)
  }

  async describe(commit: string, description: string): Promise<void> {
    await this.jj(["describe", "-r", commit, "-m", description])
  }

  /** The commits a local bookmark points to */
  bookmarkCommits(name: string): Promise<string[]> {
    return this.commitIds(`bookmarks(exact:${quote(name)})`)
  }

  async ref(name: string): Promise<string | null> {
    const output = await this.git(["rev-parse", "--verify", "--quiet", name])
    return output.success ? output.stdout.trim() : null
  }

  async tree(commit: string): Promise<string> {
    const tree = await this.treeIfPresent(commit)
    if (tree === null)
      throw new JjackError(
        "git",
        `git rev-parse failed: ${commit} is not a commit in this repository`,
      )
    return tree
  }

  /** A commit's tree never changes, so the trees of commit IDs are cached:
   * the checks of a run ask for the same ones many times */
  async treeIfPresent(commit: string): Promise<string | null> {
    const cached = this.#trees.get(commit)
    if (cached !== undefined) return cached
    const output = await this.git(["rev-parse", "--verify", "--quiet", `${commit}^{tree}`])
    if (!output.success) return null
    const tree = output.stdout.trim()
    if (/^[0-9a-f]{40}$/.test(commit)) this.#trees.set(commit, tree)
    return tree
  }

  async mergeBase(a: string, b: string): Promise<string | null> {
    const output = await this.git(["merge-base", a, b])
    if (output.code === 1 && output.stdout.trim() === "") return null
    if (!output.success)
      throw new JjackError("git", `git merge-base failed: ${output.stderr.trim()}`)
    return output.stdout.trim()
  }

  /** `ancestor` is `descendant` or one of its ancestors */
  async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    const output = await this.git(["merge-base", "--is-ancestor", ancestor, descendant])
    if (output.code === 0 || output.code === 1) return output.code === 0
    throw new JjackError("git", `git merge-base failed: ${output.stderr.trim()}`)
  }

  /** Three-way merge of trees: `ours` with the changes from `base` to
   * `theirs` applied. null when the merge conflicts. */
  async mergeTrees(base: string, ours: string, theirs: string): Promise<string | null> {
    const output = await this.git([
      "merge-tree",
      "--write-tree",
      "--no-messages",
      `--merge-base=${base}`,
      ours,
      theirs,
    ])
    if (output.code === 0) return output.stdout.split("\n")[0].trim()
    if (output.code === 1) return null
    throw new JjackError("git", `git merge-tree failed: ${output.stderr.trim()}`)
  }

  /** Whether `tree` already has the changes from `from` to `to`: applying
   * them changes nothing and does not conflict. Unlike comparing trees, this
   * still holds when `tree` also has other changes, such as a newer main. */
  async treeContainsDiff(tree: string, from: string, to: string): Promise<boolean> {
    return (await this.mergeTrees(from, tree, to)) === tree
  }

  /** The non-merge commits of `head` not in `base`, oldest first */
  async nonMergeCommits(
    head: string,
    base: string,
  ): Promise<{ commit: string; parent: string; tree: string }[]> {
    const listing = await this.#gitOk([
      "rev-list",
      "--topo-order",
      "--reverse",
      "--min-parents=1",
      "--max-parents=1",
      "--no-commit-header",
      "--format=%H %P %T",
      head,
      `^${base}`,
    ])
    return listing
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => {
        const [commit, parent, tree] = line.trim().split(" ")
        return { commit, parent, tree }
      })
  }

  /** A commit with `like`'s author and committer, and the time now, so that
   * it shows up in GitHub's timeline in the right place */
  async commitTree(like: string, message: string, tree: string, parents: string[]) {
    const identity = await this.#gitOk([
      "log",
      "-1",
      "--format=%an%x00%ae%x00%cn%x00%ce",
      like,
    ])
    const [authorName, authorEmail, committerName, committerEmail] = identity
      .replace(/\n$/, "")
      .split("\0")
    const output = await this.git(
      ["commit-tree", tree, ...parents.flatMap((p) => ["-p", p]), "-F", "-"],
      {
        input: message,
        env: {
          GIT_AUTHOR_NAME: authorName,
          GIT_AUTHOR_EMAIL: authorEmail,
          GIT_COMMITTER_NAME: committerName,
          GIT_COMMITTER_EMAIL: committerEmail,
        },
      },
    )
    if (!output.success)
      throw new JjackError("git", `git commit-tree failed: ${output.stderr.trim()}`)
    return output.stdout.trim()
  }

  /** Push `commit` to `branch`. A commit that is not a descendant of the
   * branch's head is rejected, which is what keeps pushes append-only. */
  async push(commit: string, branch: string): Promise<void> {
    const output = await this.git([
      "push",
      "--atomic",
      "--no-verify",
      "--",
      this.remote,
      `${commit}:refs/heads/${branch}`,
    ])
    if (!output.success) {
      const error = new JjackError("git", "git push failed")
      for (const line of output.stderr.trim().split("\n"))
        if (line.trim()) error.context(line)
      throw error
    }
  }

  deleteBranch(branch: string): Promise<Output> {
    return this.git([
      "push",
      "--no-verify",
      "--delete",
      "--",
      this.remote,
      `refs/heads/${branch}`,
    ])
  }

  fetch(refspecs: string[]): Promise<Output> {
    return this.git(["fetch", "--no-write-fetch-head", "--", this.remote, ...refspecs])
  }

  /**
   * Fetch each remote branch in `branches` (deduplicated) into
   * `refs/remotes/<remote>/<branch>` and return each branch's local commit
   * OID, or null when missing. Forced refspecs follow rewritten pull request
   * branches (after a stacked merge, for example). A deleted branch on the
   * remote does not stop the remaining branches from being fetched.
   */
  async fetchBranches(branches: Iterable<string>): Promise<Map<string, string | null>> {
    const unique = [...new Set(branches)]
    if (unique.length === 0) return new Map()
    const refspec = (branch: string) =>
      `+refs/heads/${branch}:refs/remotes/${this.remote}/${branch}`
    const output = await this.fetch(unique.map(refspec))
    if (!output.success && unique.length > 1) {
      // One missing branch makes a multi-refspec fetch abort without updating
      // the rest. Find the branches that exist on the remote and fetch those.
      try {
        const existing = await this.remoteHeads(unique.map((b) => `refs/heads/${b}`))
        if (existing.size > 0) await this.fetch([...existing.keys()].map(refspec))
      } catch {
        // The refs stay as they were. Callers compare them with GitHub's heads.
      }
    }
    const oids = await Promise.all(
      unique.map((branch) => this.ref(`refs/remotes/${this.remote}/${branch}`)),
    )
    return new Map(unique.map((branch, i) => [branch, oids[i]]))
  }

  /** The branches on the remote that match one of `patterns` (globs of full
   * ref names), with their heads, by branch name */
  async remoteHeads(patterns: string[]): Promise<Map<string, string>> {
    const output = await this.git(["ls-remote", "--heads", "--", this.remote, ...patterns])
    if (!output.success)
      throw new JjackError("git", `git ls-remote failed: ${output.stderr.trim()}`)
    const heads = new Map<string, string>()
    for (const line of output.stdout.split("\n")) {
      const [oid, name] = line.split("\t")
      if (name?.startsWith("refs/heads/")) heads.set(name.slice("refs/heads/".length), oid)
    }
    return heads
  }

  /** The branch names under refs/remotes/<remote>/ */
  async remoteTrackingBranches(): Promise<Set<string>> {
    const prefix = `refs/remotes/${this.remote}/`
    const listing = await this.#gitOk(["for-each-ref", "--format=%(refname)", prefix])
    return new Set(
      listing
        .split("\n")
        .filter((name) => name.startsWith(prefix))
        .map((name) => name.slice(prefix.length)),
    )
  }

  /** The commit the main branch's remote-tracking ref points to */
  async main(config: Config): Promise<string> {
    const main = await this.ref(mainRef(config))
    if (main === null)
      throw new JjackError("git", `Reference ${mainRef(config)} was not found`)
    return main
  }
}

const jjBin = (env: NodeJS.ProcessEnv) => env.JJ ?? "jj"
