import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, it } from "vitest"
import { Repo } from "../src/repo.ts"
import { TestEnv } from "./env.ts"

let root: string
let dir: string
let env: Record<string, string>
let repo: Repo

const exec = (program: string, args: string[], extra: Record<string, string> = {}) =>
  execFileSync(program, args, {
    cwd: dir,
    env: { ...process.env, ...env, ...extra },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim()

/** A commit on `parent` that writes `files`, and its commit ID */
function commit(
  parent: string,
  message: string,
  files: Record<string, string>,
  extra: Record<string, string> = {},
): string {
  exec("jj", ["new", parent], extra)
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text)
  exec("jj", ["commit", "-m", message], extra)
  return exec("jj", ["log", "--no-graph", "-r", "@-", "-T", "commit_id"], extra)
}

const lines = (...replaced: [number, string][]) => {
  const text = ["one", "two", "three", "four", "five"]
  for (const [i, line] of replaced) text[i] = line
  return text.join("\n") + "\n"
}

// Commits of the shared repository, which no test changes
let base: string
let ours: string
let theirs: string
let rival: string
let old: string
let chain: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "jjack-repo-"))
  mkdirSync(join(root, "xdg"))
  mkdirSync(join(root, "home"))
  writeFileSync(join(root, "gitconfig"), "")
  writeFileSync(
    join(root, "jj-config.toml"),
    '[user]\nname = "Test"\nemail = "test@example.com"\n',
  )
  env = {
    JJ_CONFIG: join(root, "jj-config.toml"),
    XDG_CONFIG_HOME: join(root, "xdg"),
    HOME: join(root, "home"),
    GIT_CONFIG_GLOBAL: join(root, "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    JJ_USER: "Test",
    JJ_EMAIL: "test@example.com",
  }
  dir = join(root, "repo")
  execFileSync("jj", ["git", "init", "repo"], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: "ignore",
  })
  base = commit("root()", "base", { "f.txt": lines() })
  ours = commit(base, "ours", { "f.txt": lines([0, "ONE"]) })
  theirs = commit(base, "theirs", { "f.txt": lines([4, "FIVE"]) })
  rival = commit(base, "rival", { "f.txt": lines([0, "uno"]) })
  old = commit(base, "old", { "g.txt": "g\n" }, { JJ_TIMESTAMP: "2020-01-01T00:00:00Z" })
  chain = commit(ours, "chain", { "h.txt": "h\n" })
})

beforeAll(async () => {
  // Opened after the commits above exist, but only reads
  repo = await Repo.open(dir, env)
}, 60_000)

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

const commitTree = (id: string) => repo.tree(id)

describe("mergeTrees", () => {
  it.concurrent("merges changes that do not overlap", async ({ expect }) => {
    const merged = await repo.mergeTrees(
      await commitTree(base),
      await commitTree(ours),
      await commitTree(theirs),
    )
    expect(merged).toMatch(/^[0-9a-f]{40}$/)
    const content = exec("git", ["--git-dir", repo.gitDir, "show", `${merged}:f.txt`])
    expect(content).toBe(lines([0, "ONE"], [4, "FIVE"]).trimEnd())
  })

  it.concurrent("returns null on a conflict", async ({ expect }) => {
    const merged = await repo.mergeTrees(
      await commitTree(base),
      await commitTree(ours),
      await commitTree(rival),
    )
    expect(merged).toBeNull()
  })

  it.concurrent("reports a change already applied", async ({ expect }) => {
    const [b, o] = [await commitTree(base), await commitTree(ours)]
    expect(await repo.treeContainsDiff(o, b, o)).toBe(true)
    expect(await repo.treeContainsDiff(b, b, o)).toBe(false)
  })
})

describe("commitTree", () => {
  it.concurrent("keeps the identity of `like` and uses a new time", async ({ expect }) => {
    const tree = await commitTree(old)
    const derived = await repo.commitTree(old, "Derived commit message", tree, [base])
    expect(derived).toMatch(/^[0-9a-f]{40}$/)
    const show = (id: string) =>
      exec("git", [
        "--git-dir",
        repo.gitDir,
        "log",
        "-1",
        "--format=%an|%ae|%cn|%ce|%at|%ct",
        id,
      ])
    const [on, oe, cn, ce, oa, oc] = show(old).split("|")
    const [dn, de, dcn, dce, da, dc] = show(derived).split("|")
    expect([dn, de, dcn, dce]).toEqual([on, oe, cn, ce])
    expect([on, oe]).toEqual(["Test", "test@example.com"])
    expect(Number(oa)).toBe(Date.parse("2020-01-01T00:00:00Z") / 1000)
    expect(Number(da)).toBeGreaterThan(Number(oa))
    expect(Number(dc)).toBeGreaterThan(Number(oc))
    expect(
      exec("git", ["--git-dir", repo.gitDir, "log", "-1", "--format=%s%n%P", derived]),
    ).toBe(`Derived commit message\n${base}`)
    expect(await repo.tree(derived)).toBe(tree)
  })
})

describe("nonMergeCommits", () => {
  it.concurrent("lists commits oldest first with parent and tree", async ({ expect }) => {
    const commits = await repo.nonMergeCommits(theirs, base)
    expect(commits).toEqual([
      { commit: theirs, parent: base, tree: await commitTree(theirs) },
    ])
    const listed = await repo.nonMergeCommits(chain, base)
    expect(listed.map((c) => c.commit)).toEqual([ours, chain])
    expect(listed[1].parent).toBe(ours)
  })

  it.concurrent("leaves out merge commits", async ({ expect }) => {
    const merge = await repo.commitTree(ours, "merge", await commitTree(ours), [
      ours,
      theirs,
    ])
    const listed = await repo.nonMergeCommits(merge, base)
    expect(listed.map((c) => c.commit).sort()).toEqual([ours, theirs].sort())
  })

  it.concurrent("is empty when head is base", async ({ expect }) => {
    expect(await repo.nonMergeCommits(base, base)).toEqual([])
  })
})

describe("fetchBranches", () => {
  it("fetches existing branches even when another is missing, and follows rewrites", async ({
    expect,
  }) => {
    await using env = await TestEnv.create()
    const workRepo = await Repo.open(env.work, env.env)
    await env.pushToMain("one.txt", "1\n")
    const main = env.branch("main")!

    const first = await workRepo.fetchBranches(["main", "missing", "main"])
    expect(first.get("main")).toBe(main)
    expect(first.get("missing")).toBeNull()

    // Rewrite a branch non-fast-forward on the remote and refetch it
    const other = await env.commit("Other", "two.txt", "2\n")
    const otherCommit = await env.commitId(other)
    await workRepo.push(otherCommit, "topic")
    const second = await workRepo.fetchBranches(["topic"])
    expect(second.get("topic")).toBe(otherCommit)

    await env.gitIn(join(env.root, "remote.git"), ["update-ref", "refs/heads/topic", main])
    const rewritten = await workRepo.fetchBranches(["topic", "missing"])
    expect(rewritten.get("topic")).toBe(main)
    expect(rewritten.get("missing")).toBeNull()
  })
})
