// Checks that the fake GitHub kept the behavior of papertigers/jj-spr's
// `native-stacks` fake, through jjack's GitHub client. The branches are pushed
// with plain git from the seed clone.

import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import { GitHub } from "../src/github.ts"
import type { Config } from "../src/model.ts"
import { TestEnv } from "./env.ts"

const CONFIG: Config = {
  owner: "fake",
  repo: "repo",
  remote: "origin",
  main: "main",
  branchPrefix: "spr/",
  requireApproval: false,
  apiUrl: "https://api.github.test",
}

const noSleep = async () => {}

function client(env: TestEnv, config = CONFIG, fetch = env.gh.fetch): GitHub {
  return new GitHub({ config, token: "fake-token", fetch })
}

/** Commit `file` with `content` on `parent` in the seed clone, and push it to
 * `branch`. Returns the commit. */
async function push(
  env: TestEnv,
  branch: string,
  parent: string,
  file: string,
  content: string,
): Promise<string> {
  const git = (...args: string[]) => env.gitIn(env.seed, args)
  await git("fetch", "-q", "origin")
  await git("checkout", "-q", "--detach", parent)
  await writeFile(join(env.seed, file), content)
  await git("add", file)
  await git("commit", "-q", "-m", `Change ${file}`)
  await git("push", "-q", "--force", "origin", `HEAD:refs/heads/${branch}`)
  const commit = await git("rev-parse", "HEAD")
  await git("checkout", "-q", "main")
  return commit
}

/** Branches spr/<name>, each adding <name>.txt on the one before, starting on
 * main, with a pull request each, stacked unless `stacked` is false */
async function chain(env: TestEnv, gh: GitHub, names: string[], stacked = true) {
  const prs = []
  let base = "main"
  let parent = "origin/main"
  for (const name of names) {
    const head = `spr/${name}`
    parent = await push(env, head, parent, `${name}.txt`, `${name}\n`)
    const title = `Change ${name.toUpperCase()}`
    prs.push(await gh.createPullRequest({ title, body: "", base, head, draft: false }))
    base = head
  }
  if (stacked) await gh.createStack(prs)
  return prs
}

describe.concurrent("the fake GitHub", () => {
  test("creates a pull request and reads it back", async () => {
    await using env = await TestEnv.create()
    const gh = client(env)
    const head = await push(env, "spr/a", "origin/main", "a.txt", "a\n")
    const number = await gh.createPullRequest({
      title: "Change A",
      body: "What A does.",
      base: "main",
      head: "spr/a",
      draft: false,
    })
    expect(number).toBe(1)
    expect(env.requestsSince(0, "POST", "/pulls")).toEqual(["POST /repos/fake/repo/pulls"])

    expect(await gh.pullRequest(number)).toEqual({
      number,
      state: "open",
      title: "Change A",
      body: "What A does.",
      base: "main",
      head: "spr/a",
      headOid: head,
      isDraft: false,
      reviewDecision: "none",
    })
    env.gh.review(number, "bob", "APPROVED")
    expect((await gh.pullRequest(number)).reviewDecision).toBe("approved")
    expect(await gh.mergeability(number)).toEqual({
      state: "open",
      base: "main",
      headOid: head,
      mergeable: true,
      blocked: false,
    })
    expect(await gh.openPullRequests()).toEqual([{ number, head: "spr/a", base: "main" }])
    expect(await gh.pullRequestsForBranch("spr/a")).toEqual([{ number, state: "open" }])

    expect(await gh.squashDefaultsToPullRequest()).toBe(false)
    env.gh.squashMergeCommitTitle = "PR_TITLE"
    env.gh.squashMergeCommitMessage = "PR_BODY"
    expect(await gh.squashDefaultsToPullRequest()).toBe(true)

    const sha = await gh.squashMerge(number, { title: "A", message: "", sha: head })
    expect(sha).toBe(env.branch("main"))
    expect(env.pr(number)).toMatchObject({ state: "closed", mergeCommitSha: sha })
    expect(env.landedSince("HEAD~1")).toEqual(["A: a.txt"])
  })

  test("refuses to change the base of a stacked pull request", async () => {
    await using env = await TestEnv.create()
    const gh = client(env)
    const [, b] = await chain(env, gh, ["a", "b"])
    await expect(gh.updatePullRequest(b, { base: "main" })).rejects.toThrow(
      "GitHub returned 422 for PATCH /repos/fake/repo/pulls/2: Validation Failed: Cannot " +
        "change the base branch because the pull request is part of a stack.",
    )
    expect(env.pr(b).baseRef).toBe("spr/a")
  })

  test("refuses the plain merge of a stacked pull request", async () => {
    await using env = await TestEnv.create()
    const gh = client(env)
    const [a] = await chain(env, gh, ["a", "b"])
    await expect(
      gh.squashMerge(a, { title: "A", message: "", sha: env.headOf(a) }),
    ).rejects.toThrow(/^GitHub returned 403 .*not supported/)
    expect(env.pr(a).state).toBe("open")
  })

  test("a stack merge replays the rest and drops merge commits", async () => {
    await using env = await TestEnv.create()
    const gh = client(env)
    const [a, b, c] = await chain(env, gh, ["a", "b", "c"])
    // A colleague merges main into the top branch
    await env.pushToMain("x.txt", "x\n")
    await env.gitIn(env.seed, ["fetch", "-q", "origin"])
    await env.gitIn(env.seed, ["checkout", "-q", "--detach", "origin/spr/c"])
    await env.gitIn(env.seed, ["merge", "-q", "--no-edit", "origin/main"])
    await env.gitIn(env.seed, ["push", "-q", "origin", "HEAD:refs/heads/spr/c"])
    await env.gitIn(env.seed, ["checkout", "-q", "main"])
    const before = env.branch("main")!

    const sha = await gh.mergeStacked(a, { sha: env.headOf(a) }, noSleep)
    expect(env.requestsSince(0, "GET", "/merge-async/")).toHaveLength(1)
    expect(sha).toBe(env.branch("main"))
    expect(env.landedSince(before)).toEqual(["Change A (#1): a.txt"])
    expect(env.pr(a)).toMatchObject({ state: "closed", mergeCommitSha: sha })
    expect(env.pr(b)).toMatchObject({ state: "open", baseRef: "main" })
    expect(env.pr(c)).toMatchObject({ state: "open", baseRef: "spr/b" })
    expect(env.prCommits(b)).toEqual(["Change b.txt"])
    expect(env.prCommits(c)).toEqual(["Change c.txt"])
    expect(env.prFiles(c)).toEqual(["c.txt"])
    expect(env.remoteGit(["rev-list", "--merges", "main..spr/c"])).toBe("")
    // The replayed commits keep their author
    expect(env.remoteGit(["log", "-1", "--format=%an", "spr/c"])).toBe("Test User")
    expect(env.activeStacks()).toEqual([[b, c]])
  })

  test("a member left empty by a stack merge is closed", async () => {
    await using env = await TestEnv.create()
    const gh = client(env)
    const [a, b] = await chain(env, gh, ["a", "b"])
    // Main gets b's change from elsewhere
    await env.pushToMain("b.txt", "b\n")

    await gh.mergeStacked(a, { sha: env.headOf(a) }, noSleep)
    expect(env.pr(b)).toMatchObject({
      state: "closed",
      mergedAt: null,
      closedReason: "no commits left after the stack rebase",
    })
    expect(env.branch("spr/b")).toBe(env.branch("main"))
  })

  test("a conflicting replay rewrites no branch", async () => {
    await using env = await TestEnv.create()
    const gh = client(env)
    const [a, b, c] = await chain(env, gh, ["a", "b", "c"])
    await env.pushToMain("b.txt", "something else\n")
    const [headB, headC] = [env.headOf(b), env.headOf(c)]

    await gh.mergeStacked(a, { sha: env.headOf(a) }, noSleep)
    expect(env.pr(a).mergedAt).not.toBeNull()
    expect([env.headOf(b), env.headOf(c)]).toEqual([headB, headC])
    expect(env.pr(b).baseRef).toBe("main")
    expect(env.pr(c).baseRef).toBe("spr/b")
    expect((await gh.mergeability(b)).mergeable).toBe(false)
  })

  test("deleting the base branch closes a pull request", async () => {
    await using env = await TestEnv.create()
    const gh = client(env)
    const [a, b] = await chain(env, gh, ["a", "b"], false)
    env.remoteGit(["update-ref", "-d", "refs/heads/spr/a"])

    expect(await gh.pullRequestsForBranch("spr/b")).toEqual([
      { number: b, state: "closed" },
    ])
    expect(env.pr(b).closedReason).toBe("base branch spr/a was deleted")
    expect(env.pr(a).closedReason).toBe("head branch spr/a was deleted")
  })

  test("a head pushed to its base marks a pull request merged", async () => {
    await using env = await TestEnv.create()
    const gh = client(env)
    const [a] = await chain(env, gh, ["a"], false)
    const head = env.headOf(a)
    await env.gitIn(env.seed, ["push", "-q", "origin", `${head}:refs/heads/main`])

    expect((await gh.pullRequest(a)).state).toBe("merged")
    expect(env.pr(a)).toMatchObject({
      mergeCommitSha: head,
      closedReason: "its head is in main",
    })
  })

  test("graphql fails on non-2xx JSON responses without errors", async () => {
    const gh = new GitHub({
      config: CONFIG,
      token: "bad-token",
      fetch: async () =>
        new Response(JSON.stringify({ message: "Bad credentials" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }),
    })
    await expect(gh.pullRequest(1)).rejects.toMatchObject({
      code: "github",
      status: 401,
      messages: ["fetching PR #1 failed", "Bad credentials"],
    })
  })

  test("serves over HTTP", async (context) => {
    await using env = await TestEnv.create()
    let server: Awaited<ReturnType<typeof env.gh.listen>>
    try {
      server = await env.gh.listen()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") context.skip()
      throw error
    }
    try {
      const gh = client(env, { ...CONFIG, apiUrl: server.url }, fetch)
      const [a, b] = await chain(env, gh, ["a", "b"])
      expect(await gh.listStacks()).toMatchObject([
        { number: 3, pull_requests: [{ number: a }, { number: b }] },
      ])
      expect((await gh.pullRequest(b)).base).toBe("spr/a")
    } finally {
      await server.close()
    }
  })
})
