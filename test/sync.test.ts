// End-to-end tests of `jjack sync` on a stack file against the fake GitHub. A
// port of the kept tests of `tests/sync.rs` from papertigers/jj-spr's
// `native-stacks` branch, with `jj spr diff` replaced by `jjack submit <file>`.
// They need `jj` and `git` on `PATH`.

import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, type ExpectStatic, it } from "vitest"
import { TestEnv, checkChain } from "./env.ts"
import { Stack, fileStack } from "./stack.ts"

/** After a sync, `changes` sit in order directly on `main@origin` */
async function assertRebasedOntoMain(
  env: TestEnv,
  expect: ExpectStatic,
  changes: string[],
): Promise<void> {
  const main = await env.commitId("main@origin")
  expect(await env.parentOf(changes[0]), "bottom change should be on main@origin").toBe(
    main,
  )
  for (let i = 1; i < changes.length; i++) {
    expect(
      await env.parentOf(changes[i]),
      `${changes[i]} should sit on ${changes[i - 1]}`,
    ).toBe(await env.commitId(changes[i - 1]))
  }
}

const commitIds = (env: TestEnv, changes: string[]) =>
  Promise.all(changes.map((c) => env.commitId(c)))

describe.concurrent("sync", () => {
  it("sync_after_merge_on_github", async ({ expect }) => {
    await using env = await TestEnv.create()
    const { stack, changes, prs } = await fileStack(env, ["a", "b", "c"])
    env.gh.mergeOnGithub(prs[0])

    await stack.jjack("sync")
    expect(await env.isVisible(changes[0])).toBe(false)
    await assertRebasedOntoMain(env, expect, changes.slice(1))
    await stack.jjack("submit", ["-m", "after sync"])
    await checkChain(env, changes.slice(1), prs.slice(1))
  })

  it("sync_keeps_unpublished_edits", async ({ expect }) => {
    await using env = await TestEnv.create()
    const { stack, changes } = await fileStack(env, ["a", "b", "c"])
    await stack.jjack("land", ["--no-sync", "--upto", changes[0]])

    // Edit the landed change locally before syncing
    await env.jj(["edit", changes[0]])
    await writeFile(join(env.work, "a.txt"), "a, with more work\n")
    await env.jj(["new", changes[2]])
    const aCommit = await env.commitId(changes[0])
    const bParent = await env.parentOf(changes[1])

    const out = await stack.tryJjack("sync")
    expect(out.success, `sync should refuse:\n${out.text}`).toBe(false)
    expect(out.flat).toContain("differs from what merged")
    expect(await env.isVisible(changes[0]), "the edited change must be kept").toBe(true)
    expect(await env.commitId(changes[0]), "nothing should change").toBe(aCommit)
    expect(await env.parentOf(changes[1]), "nothing should be rebased").toBe(bParent)
  })

  it("sync_stops_on_conflict", async ({ expect }) => {
    await using env = await TestEnv.create()
    const { stack, changes } = await fileStack(env, ["a", "b"])
    await stack.jjack("land", ["--no-sync", "--upto", changes[0]])
    // A colleague adds a conflicting b.txt to main
    await env.pushToMain("b.txt", "someone else's b\n")

    const out = await stack.tryJjack("sync")
    expect(out.success, `sync should report the conflict:\n${out.text}`).toBe(false)
    expect(out.flat).toContain("left conflicts")
    expect(out.flat).toContain("jj undo")
    const conflicted = await env.jjQuery([
      "log",
      "--no-graph",
      "-r",
      "conflicts() & main@origin..",
      "-T",
      'change_id ++ "\\n"',
    ])
    expect(conflicted.split("\n"), "B should be conflicted").toContain(changes[1])
    expect(out.text, "sync should name B").toContain(changes[1].slice(0, 8))
  })

  it("sync_nothing_merged", async ({ expect }) => {
    await using env = await TestEnv.create()
    const { stack, changes } = await fileStack(env, ["a", "b"])
    await env.pushToMain("other.txt", "other\n")
    await env.jj(["git", "fetch"])
    const before = await commitIds(env, changes)

    const out = await stack.jjack("sync")
    expect(out.text).toContain("Nothing in this stack has merged")
    expect(
      await commitIds(env, changes),
      "sync must not rebase just because main moved",
    ).toEqual(before)
  })

  it("sync_leaves_closed_unmerged", async ({ expect }) => {
    await using env = await TestEnv.create()
    const { stack, changes, prs } = await fileStack(env, ["a", "b"])
    env.gh.closeOnGithub(prs[0])

    const out = await stack.jjack("sync")
    expect(out.flat).toContain("closed without merging")
    for (const c of changes) expect(await env.isVisible(c)).toBe(true)
  })

  it("sync_dry_run", async ({ expect }) => {
    await using env = await TestEnv.create()
    const { stack, changes } = await fileStack(env, ["a", "b"])
    await stack.jjack("land", ["--no-sync", "--upto", changes[0]])
    const before = await commitIds(env, changes)

    const out = await stack.jjack("sync", ["--dry-run"])
    expect(out.text).toContain("Would abandon")
    expect(out.text).toContain("Would rebase")
    expect(await commitIds(env, changes), "a dry run must not change anything").toEqual(
      before,
    )
  })

  it("sync_after_local_rebase_without_resubmitting", async ({ expect }) => {
    // The local stack was rebased onto a newer main but not resubmitted
    // before the bottom PR merged. Its trees differ from what merged, but it
    // has nothing unpublished, so sync must still abandon it.
    await using env = await TestEnv.create()
    const { stack, changes, prs } = await fileStack(env, ["a", "b"])
    await env.pushToMain("other.txt", "other\n")
    await env.jj(["git", "fetch"])
    await env.jj(["rebase", "-s", changes[0], "-d", "main@origin"])
    env.gh.mergeOnGithub(prs[0])

    await stack.jjack("sync")
    expect(await env.isVisible(changes[0]), "the merged change should be abandoned").toBe(
      false,
    )
    await assertRebasedOntoMain(env, expect, changes.slice(1))
  })

  it("sync_after_github_rebased_stack", async ({ expect }) => {
    // Nothing merged, but someone pressed the stack's rebase button after
    // main moved. Pushing from the old base would make the bottom PR look
    // like it reverts other.txt, so sync rebases the local stack to match.
    await using env = await TestEnv.create()
    const { stack, changes, prs } = await fileStack(env, ["a", "b", "c"])
    await env.pushToMain("other.txt", "other\n")
    env.gh.rebaseStackOnGithub(prs[0])

    // From sync_dry_run_after_github_rebased_stack
    const before = await commitIds(env, changes)
    const dryRun = await stack.jjack("sync", ["--dry-run"])
    expect(dryRun.text).toContain("Would rebase")
    expect(await commitIds(env, changes), "a dry run must not change anything").toEqual(
      before,
    )

    const out = await stack.jjack("sync")
    expect(out.flat).toContain("GitHub rebased")
    for (const c of changes) expect(await env.isVisible(c)).toBe(true)
    await assertRebasedOntoMain(env, expect, changes)
    expect(out.flat).toContain(`jjack submit ${stack.path}`)

    await stack.jjack("submit", ["-m", "after sync"])
    await checkChain(env, changes, prs)
    expect(env.prFiles(prs[0])).toEqual(["a.txt"])
    expect(env.prFiles(prs[1])).toEqual(["b.txt"])
    expect(env.prFiles(prs[2])).toEqual(["c.txt"])
  })

  it("sync_after_github_updated_branch", async ({ expect }) => {
    // "Update branch" on an ordinary PR merges main into it: the same
    // situation as the stack's rebase button. The Rust test used a
    // cherry-picked PR; a one-entry stack file gives the same ordinary PR.
    await using env = await TestEnv.create()
    const {
      stack,
      changes: [change],
      prs: [pr],
    } = await fileStack(env, ["a"])
    await env.pushToMain("other.txt", "other\n")
    env.gh.updateBranch(pr)

    const out = await stack.jjack("sync")
    expect(out.flat).toContain("GitHub rebased")
    await assertRebasedOntoMain(env, expect, [change])
    await stack.jjack("submit", ["-m", "after sync"])
    expect(env.prFiles(pr)).toEqual(["a.txt"])
  })

  it("sync_keeps_a_change_that_undoes_part_of_a_merged_one", async ({ expect }) => {
    // C removes a line B adds. Abandoning B before rebasing would put C on
    // B's parent (main with A), where there is no line to remove, and the
    // later rebase onto main (which has B's line) would leave the line in.
    await using env = await TestEnv.create()
    const changes = [
      await env.commit("Change A", "shared.txt", "one\ntwo\n"),
      await env.commit("Change B", "shared.txt", "one\nnote\ntwo\n"),
      await env.commit("Change C", "shared.txt", "one\ntwo\n"),
    ]
    const stack = new Stack(env)
    stack.entries(changes.map((tip, i) => ({ tip, title: `Change ${"ABC"[i]}` })))
    await stack.jjack("submit", ["-m", "stack"])
    const prs = stack.prs()
    env.gh.mergeOnGithub(prs[0])
    await stack.jjack("sync")
    await stack.jjack("submit", ["-m", "after landing A"])
    env.gh.mergeOnGithub(prs[1])

    await stack.jjack("sync")
    expect(await env.isVisible(changes[1])).toBe(false)
    await assertRebasedOntoMain(env, expect, changes.slice(2))
    expect(await env.filesIn(changes[2])).toEqual(["shared.txt"])
    expect(await env.jjQuery(["file", "show", "-r", changes[2], "shared.txt"])).toBe(
      "one\ntwo\n",
    )
  })

  it("sync_counts_changes_not_entries_when_rebasing", async ({ expect }) => {
    await using env = await TestEnv.create()
    const a = await env.commit("Change A", "a.txt", "a\n")
    await env.commit("Change B1", "b1.txt", "b1\n")
    await env.commit("Change B2", "b2.txt", "b2\n")
    const b3 = await env.commit("Change B3", "b3.txt", "b3\n")
    const stack = new Stack(env)
    stack.entries([
      { tip: a, title: "Change A" },
      { tip: b3, title: "Change B" },
    ])
    await stack.jjack("submit")
    env.gh.mergeOnGithub(stack.prs()[0])

    const out = await stack.jjack("sync")
    expect(out.text).toContain("Rebased 3 change(s) onto main@origin")
  })
})
