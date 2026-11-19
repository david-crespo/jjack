// End-to-end tests of `jjack submit` refusing to push over commits that
// someone else pushed to a pull request, against the fake GitHub. A port of
// the kept tests of `tests/remote_changes.rs` from papertigers/jj-spr's
// `native-stacks` branch, with `jj spr diff` replaced by `jjack submit <file>`.
// They need `jj` and `git` on `PATH`.

import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, type ExpectStatic, it } from "vitest"
import { TestEnv, checkChain } from "./env.ts"
import { Stack, fileStack, heads } from "./stack.ts"

/** The remedy in the refusal */
const REMEDY = "Bring the edits you want into your changes"

/** Rewrite the branches of `prs[1]` and `prs[2]` the way GitHub's stack
 * rebase did in oxidecomputer/propolis#1242-#1245: each branch keeps only the
 * content of the PR below it, and its own change is dropped. */
async function shiftBranchesDown(env: TestEnv, prs: number[]): Promise<void> {
  const aHead = env.headOf(prs[0])
  const bHead = env.headOf(prs[1])
  const bBranch = env.pr(prs[1]).headRef
  const cBranch = env.pr(prs[2]).headRef
  const message = "[spr] changes to main this commit is based on"
  const bLossy = env.remoteGit([
    "commit-tree",
    `${aHead}^{tree}`,
    "-p",
    aHead,
    "-m",
    message,
  ])
  const cLossy = env.remoteGit([
    "commit-tree",
    `${bHead}^{tree}`,
    "-p",
    bLossy,
    "-m",
    message,
  ])
  env.remoteGit(["update-ref", `refs/heads/${bBranch}`, bLossy])
  env.remoteGit(["update-ref", `refs/heads/${cBranch}`, cLossy])
  // `jjack sync` fetches, so the rewritten heads are local
  await env.jj(["git", "fetch"])
}

/** A submitted stack where C removes a line B adds, so B's diff is not in C */
async function buildStackWhereCUndoesPartOfB(
  env: TestEnv,
): Promise<{ stack: Stack; changes: string[]; prs: number[] }> {
  const changes = [
    await env.commit("Change A", "shared.txt", "one\ntwo\n"),
    await env.commit("Change B", "shared.txt", "one\nnote\ntwo\n"),
    await env.commit("Change C", "shared.txt", "one\ntwo\n"),
  ]
  const stack = new Stack(env)
  stack.entries(changes.map((tip, i) => ({ tip, title: `Change ${"ABC"[i]}` })))
  await stack.jjack("submit", ["-m", "initial"])
  // B moves on after C exists (as #1243 did), so no earlier version of C
  // contains what the rewritten branch holds: the first version of C is empty
  // on B, so its tree is B's as it was then.
  await writeFile(join(env.work, "b.txt"), "b\n")
  await env.jj(["squash", "--into", changes[1]])
  await stack.jjack("submit", ["-m", "edit B"])
  return { stack, changes, prs: stack.prs() }
}

/** Make `change` a commit that jj imported from Git, with no history in `jj
 * evolog`, as for a change created on another machine. Returns its new change
 * ID. */
async function reimportWithoutEvolog(
  env: TestEnv,
  expect: ExpectStatic,
  change: string,
): Promise<string> {
  const commit = await env.commitId(change)
  const git = (args: string[]) => env.gitIn(env.work, args)
  const message = await git(["log", "-1", "--format=%B", commit])
  const copy = await git([
    "commit-tree",
    `${commit}^{tree}`,
    "-p",
    `${commit}^`,
    "-m",
    message,
  ])
  await git(["update-ref", "refs/heads/reimport", copy])
  await env.jj(["git", "import"])
  await env.jj(["abandon", change])
  await env.jj(["new", copy])
  await env.jj(["bookmark", "forget", "reimport"])
  const id = await env.changeId(copy)
  const versions = await env.jjQuery([
    "evolog",
    "--no-graph",
    "-r",
    id,
    "-T",
    'commit.commit_id() ++ "\\n"',
  ])
  expect(
    versions.split("\n").filter(Boolean),
    "the copy should have no earlier versions",
  ).toHaveLength(1)
  return id
}

describe.concurrent("remote changes", () => {
  it("submit_refuses_to_drop_colleagues_push", async ({ expect }) => {
    await using env = await TestEnv.create()
    const { stack, changes, prs } = await fileStack(env, ["a", "b"])
    await env.pushToPrBranch(prs[0], "a-fix.txt", "fix\n")
    // A local edit to the other PR must not matter
    await writeFile(join(env.work, "b.txt"), "b, edited\n")
    await env.jj(["squash", "--into", changes[1]])
    const before = heads(env, prs)

    const out = await stack.tryJjack("submit", ["-m", "update"])
    expect(out.success, `submit should refuse:\n${out.text}`).toBe(false)
    expect(out.flat).toContain(`#${prs[0]} has commits that are not in the local change`)
    expect(out.flat).toContain(REMEDY)
    expect(heads(env, prs), "nothing may be pushed").toEqual(before)

    await stack.jjack("submit", ["-m", "update", "--discard-remote-changes"])
    await checkChain(env, changes, prs)
    expect(env.prFiles(prs[0]), "the colleague's file is dropped").toEqual(["a.txt"])
  })

  it("submit_refuses_when_colleague_edits_the_same_lines", async ({ expect }) => {
    await using env = await TestEnv.create()
    const { stack, prs } = await fileStack(env, ["a"])
    await env.pushToPrBranch(prs[0], "a.txt", "a, by a colleague\n")

    const out = await stack.tryJjack("submit", ["-m", "update"])
    expect(out.success, `submit should refuse:\n${out.text}`).toBe(false)
    expect(out.flat).toContain(REMEDY)
  })

  it("submit_allows_own_edits_to_the_same_lines", async () => {
    await using env = await TestEnv.create()
    const { stack, changes, prs } = await fileStack(env, ["a", "b"])
    for (const round of [1, 2]) {
      await writeFile(join(env.work, "a.txt"), `a, round ${round}\n`)
      await env.jj(["squash", "--into", changes[0]])
      await stack.jjack("submit", ["-m", `round ${round}`])
      await checkChain(env, changes, prs)
    }
  })

  it("submit_allows_github_rebase_after_stacked_merge", async () => {
    // After a stacked merge GitHub rebases the rest of the stack itself.
    // Those heads are nobody else's work, even with local edits since.
    await using env = await TestEnv.create()
    const { stack, changes, prs } = await fileStack(env, ["a", "b", "c"])
    await stack.jjack("land", ["--no-sync", "--upto", changes[0]])
    await stack.jjack("sync")
    await writeFile(join(env.work, "c.txt"), "c, edited after sync\n")
    await env.jj(["squash", "--into", changes[2]])

    await stack.jjack("submit", ["-m", "after sync"])
    await checkChain(env, changes.slice(1), prs.slice(1))
  })

  it("submit_allows_github_rebase_onto_older_main", async () => {
    // As above, but main moves on before the land and again before the sync,
    // so GitHub's rebased heads and the local changes are on different
    // versions of main and no local version has the same tree as GitHub's.
    await using env = await TestEnv.create()
    const { stack, changes, prs } = await fileStack(env, ["a", "b", "c"])
    await env.pushToMain("before-land.txt", "1\n")
    await stack.jjack("land", ["--no-sync", "--upto", changes[0]])
    await env.pushToMain("after-land.txt", "2\n")
    await stack.jjack("sync")
    await writeFile(join(env.work, "c.txt"), "c, edited after sync\n")
    await env.jj(["squash", "--into", changes[2]])

    await stack.jjack("submit", ["-m", "after sync"])
    await checkChain(env, changes.slice(1), prs.slice(1))
  })

  it("submit_refetches_a_rewritten_pr_branch", async ({ expect }) => {
    // GitHub rewrites PR branches; a plain fetch then refuses the update as a
    // non-fast-forward and submit would compare against a stale head. A
    // single PR, so only its own (head) fetch can repair the local copy.
    await using env = await TestEnv.create()
    const { stack, prs } = await fileStack(env, ["a"])
    const branch = env.pr(prs[0]).headRef
    await env.pushToPrBranch(prs[0], "a-fix.txt", "fix\n")
    // Leave the local copy of the branch on an unrelated commit
    const unrelated = env.gh.git([
      "commit-tree",
      "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
      "-m",
      "unrelated",
    ])
    await env.jj(["git", "fetch"])
    await env.gitIn(env.work, ["fetch", "-q", join(env.root, "remote.git"), unrelated])
    await env.gitIn(env.work, ["update-ref", `refs/remotes/origin/${branch}`, unrelated])

    const out = await stack.tryJjack("submit", ["-m", "would drop the push"])
    expect(out.success, `submit should refuse:\n${out.text}`).toBe(false)
    expect(out.flat).toContain("commits that are not in the local change")
  })

  it("submit_refuses_colleagues_push_after_github_rebase", async ({ expect }) => {
    // The live run's sequence: land part of the stack (GitHub rewrites the
    // remaining branches), sync, resubmit, then a colleague pushes.
    await using env = await TestEnv.create()
    const { stack, changes, prs } = await fileStack(env, ["a", "b", "c"])
    await stack.jjack("land", ["--no-sync", "--upto", changes[1]])
    await stack.jjack("sync")
    await stack.jjack("submit", ["-m", "after landing"])
    const e = await env.commit("Change E", "e.txt", "e\n")
    const file = stack.read()
    file.prs.push({ tip: e, title: "Change E" })
    stack.write(file)
    await stack.jjack("submit", ["-m", "add E"])
    await env.pushToPrBranch(prs[2], "c-fix.txt", "fix\n")

    const out = await stack.tryJjack("submit", ["-m", "would drop the push"])
    expect(out.success, `submit should refuse:\n${out.text}`).toBe(false)
    expect(out.flat).toContain("commits that are not in the local change")
  })

  // Gains diff_after_github_restacks_a_change_with_no_evolog: its stack was
  // built on legacy base branches, but what it checked takes the same path
  // here, so the second case makes C a change with no earlier versions
  it.for([false, true])(
    "submit_allows_branch_holding_only_the_parents_content (without evolog: %s)",
    async (withoutEvolog, { expect }) => {
      // GitHub's restack left #1244 holding #1243's diff, which adds lines
      // #1244 deletes. That diff is all in the local parent, so pushing over
      // it drops nothing.
      await using env = await TestEnv.create()
      const { stack, changes, prs } = await buildStackWhereCUndoesPartOfB(env)
      if (withoutEvolog) {
        // C came from elsewhere, so no earlier version of it holds B's
        // content: only the local parent shows that pushing loses nothing
        changes[2] = await reimportWithoutEvolog(env, expect, changes[2])
        stack.edit(2, { tip: changes[2] })
      }
      await shiftBranchesDown(env, prs)

      await stack.jjack("submit", ["-m", "after GitHub's restack"])
      await checkChain(env, changes, prs)
      expect(env.prFiles(prs[2])).toEqual(["shared.txt"])
    },
  )

  it("submit_refuses_colleagues_push_on_top_of_parents_content", async ({ expect }) => {
    // As above, but someone also pushed to C: that is still their work
    await using env = await TestEnv.create()
    const { stack, prs } = await buildStackWhereCUndoesPartOfB(env)
    await shiftBranchesDown(env, prs)
    await env.pushToPrBranch(prs[2], "c-fix.txt", "fix\n")
    const before = heads(env, prs)

    const out = await stack.tryJjack("submit", ["-m", "would drop the push"])
    expect(out.success, `submit should refuse:\n${out.text}`).toBe(false)
    expect(out.flat).toContain(`#${prs[2]} has commits that are not in the local change`)
    expect(heads(env, prs), "nothing may be pushed").toEqual(before)
  })
})
