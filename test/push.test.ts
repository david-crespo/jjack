// Scenario tests of `jjack submit` with GitHub stacks: reruns, amends,
// rebases, appends, and reorders. A port of the push tests of
// `tests/native_stacks.rs` from papertigers/jj-spr's `native-stacks` branch,
// through a stack file where those used `jj spr diff`, plus a test of what
// submit refuses before changing anything and one of the update commits'
// default messages.

import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, it, type ExpectStatic } from "vitest"
import { checkChain, TestEnv } from "./env.ts"
import { fileStack, heads, nothingPushed, type Stack } from "./stack.ts"

/** The write requests (POST, PATCH, and PUT) to the REST API since `from` */
function writesSince(env: TestEnv, from: number): string[] {
  return ["POST", "PATCH", "PUT"].flatMap((method) =>
    env.requestsSince(from, method, "/repos/"),
  )
}

/** Put the stack file's entries in `order` (indices into the current entries,
 * bottom first) */
function reorderEntries(stack: Stack, order: number[]): void {
  const file = stack.read()
  file.prs = order.map((i) => file.prs[i])
  stack.write(file)
}

/** Submit a, b, and c, reorder them locally and in the stack file to `order`
 * (indices into a, b, and c, bottom first), submit again, and land the whole
 * stack. Each pull request has to reach main as its own commit, titled for it,
 * with only its own file. */
async function reorderAndLand(
  expect: ExpectStatic,
  order: [number, number, number],
): Promise<void> {
  await using env = await TestEnv.create()
  const { stack, changes, prs } = await fileStack(env, ["a", "b", "c"])
  const main = env.branch("main")!
  for (let i = 1; i < order.length; i++) {
    await env.jj([
      "rebase",
      "-r",
      changes[order[i]],
      "--insert-after",
      changes[order[i - 1]],
    ])
  }
  await env.jj(["new", changes[order[2]]])
  reorderEntries(stack, order)
  await stack.jjack("submit", ["-m", "reorder"])
  await checkChain(
    env,
    order.map((i) => changes[i]),
    order.map((i) => prs[i]),
  )

  await stack.jjack("land")
  for (const i of order) {
    const pr = env.pr(prs[i])
    expect(pr.mergedAt, `PR #${prs[i]} was not merged (${pr.closedReason})`).not.toBeNull()
  }
  const landed = ["Change A: a.txt", "Change B: b.txt", "Change C: c.txt"]
  expect(env.landedSince(main)).toEqual(order.map((i) => landed[i]))
}

describe.concurrent("submit with GitHub stacks", () => {
  it("rerun_is_noop", async ({ expect }) => {
    await using env = await TestEnv.create()
    const { stack, changes, prs } = await fileStack(env, ["a", "b", "c"])
    const branches = env.gh.branches()
    const before = env.requestCount()
    const out = await stack.jjack("submit", ["-m", "again"])
    expect(env.gh.branches(), "rerun changed branches").toEqual(branches)
    expect(out.text).toContain("No update necessary")
    expect(writesSince(env, before), "rerun made changes").toEqual([])
    await checkChain(env, changes, prs)
  })

  it("amend_middle", async ({ expect }) => {
    await using env = await TestEnv.create()
    const { stack, changes, prs } = await fileStack(env, ["a", "b", "c"])
    const old = heads(env, prs)

    await env.jj(["edit", changes[1]])
    await writeFile(join(env.work, "b.txt"), "b, revised\n")
    await env.jj(["new", changes[2]])
    await stack.jjack("submit", ["-m", "review feedback"])

    await checkChain(env, changes, prs)
    expect(env.headOf(prs[0]), "the bottom PR should not change").toBe(old[0])
    for (const [i, n] of prs.entries()) {
      if (i === 0) continue
      const head = env.headOf(n)
      expect(head, `PR #${n} was not updated`).not.toBe(old[i])
      expect(env.isAncestor(old[i], head), `PR #${n} lost its history`).toBe(true)
    }
    expect(env.remoteGit(["log", "-1", "--format=%s", env.headOf(prs[1])])).toBe(
      "review feedback",
    )
  })

  it("rebase_on_main", async ({ expect }) => {
    await using env = await TestEnv.create()
    const { stack, changes, prs } = await fileStack(env, ["a", "b", "c"])
    const old = heads(env, prs)

    // Someone else lands work on main
    await env.pushToMain("other.txt", "other\n")
    await env.jj(["git", "fetch"])
    await env.jj(["rebase", "-s", changes[0], "-d", "main@origin"])
    const before = env.requestCount()
    await stack.jjack("submit", ["-m", "rebase on main"])

    await checkChain(env, changes, prs)
    const main = env.branch("main")!
    for (const [i, n] of prs.entries()) {
      const head = env.headOf(n)
      expect(head, `PR #${n} was not updated`).not.toBe(old[i])
      expect(env.isAncestor(old[i], head), `PR #${n} was rewritten`).toBe(true)
      expect(env.isAncestor(main, head), `PR #${n} does not include main`).toBe(true)
      const parents = env.remoteGit(["log", "-1", "--format=%P", head])
      expect(parents.split(" ")[0], `PR #${n}'s first parent`).toBe(old[i])
    }
    expect(env.prFiles(prs[0])).toEqual(["a.txt"])
    expect(
      env.requestsSince(before, "POST", "/stacks"),
      "a rebase should not touch the stack",
    ).toEqual([])
  })

  it("append_to_stack", async ({ expect }) => {
    await using env = await TestEnv.create()
    const { stack, changes } = await fileStack(env, ["a", "b", "c"])
    const d = await env.commit("Change D", "d.txt", "d\n")
    const file = stack.read()
    file.prs.push({ tip: d, title: "Change D" })
    stack.write(file)
    const before = env.requestCount()
    await stack.jjack("submit", ["-m", "add d"])
    const prs = stack.prs()
    await checkChain(env, [...changes, d], prs)
    expect(prs).toHaveLength(4)
    expect(env.stacks().size, JSON.stringify([...env.stacks()])).toBe(1)
    expect(env.requestsSince(before, "POST", "/add"), "append to the stack").toHaveLength(1)
  })

  it("stacks_disabled", async ({ expect }) => {
    await using env = await TestEnv.create({ stacks: false })
    const { prs } = await fileStack(env, ["a", "b", "c"])
    for (let i = 1; i < prs.length; i++) {
      expect(env.pr(prs[i]).baseRef, "PRs not chained").toBe(env.pr(prs[i - 1]).headRef)
      expect(env.prFiles(prs[i])).toEqual([`${["a", "b", "c"][i]}.txt`])
    }
    expect(env.stacks().size, "no stacks when disabled").toBe(0)
  })

  it("github_rebase_after_merge_keeps_edits_in_merge_commits", async ({ expect }) => {
    // Amending a change and the one below it in one run gives the upper PR an
    // update commit that is a merge carrying its own edit. GitHub's post-merge
    // rebase drops merge commits, so check what survives.
    await using env = await TestEnv.create()
    const { stack, changes, prs } = await fileStack(env, ["a", "b", "c"])
    await writeFile(join(env.work, "b.txt"), "b, edited\n")
    await env.jj(["squash", "--into", changes[1]])
    await writeFile(join(env.work, "c.txt"), "c, edited\n")
    await env.jj(["squash", "--into", changes[2]])
    await stack.jjack("submit", ["-m", "edit B and C"])
    const show = (n: number, path: string) =>
      env.remoteGit(["show", `${env.headOf(n)}:${path}`])
    expect(show(prs[2], "c.txt")).toBe("c, edited")

    await stack.jjack("land", ["--upto", changes[0]])
    expect(
      show(prs[2], "c.txt"),
      "C's edit was in a merge commit that GitHub's rebase dropped",
    ).toBe("c, edited")
    expect(env.prFiles(prs[2])).toEqual(["c.txt"])
  })

  it("amend_the_bottom_change_then_land_it_and_the_rest", async ({ expect }) => {
    // The amend gives B and C a merge commit each. After A merges, GitHub
    // replays B and C without those, which is what the local changes are after
    // a sync, so there is nothing to push before landing the rest.
    await using env = await TestEnv.create()
    const { stack, changes, prs } = await fileStack(env, ["a", "b", "c"])
    const main = env.branch("main")!
    await writeFile(join(env.work, "a.txt"), "a, amended\n")
    await env.jj(["squash", "--into", changes[0]])
    await stack.jjack("submit", ["-m", "amend A"])

    await stack.jjack("land", ["--no-sync", "--upto", changes[0]])
    await stack.jjack("sync")
    const before = heads(env, prs.slice(1))
    const out = await stack.jjack("submit", ["-m", "after sync"])
    expect(out.text.split("No update necessary").length - 1, out.text).toBe(2)
    expect(heads(env, prs.slice(1)), "nothing should be pushed").toEqual(before)

    await stack.jjack("land")
    expect(env.landedSince(main)).toEqual([
      "Change A: a.txt",
      "Change B: b.txt",
      "Change C: c.txt",
    ])
    expect(env.remoteGit(["show", "main:a.txt"])).toBe("a, amended")
  })

  it("submit_upto_refuses_to_rebuild_a_stack_it_would_cut_short", async ({ expect }) => {
    // Swapping the bottom two entries changes their bases, so the stack has to
    // be dissolved and rebuilt, which a run that leaves out the top entry
    // can't do.
    await using env = await TestEnv.create()
    const { stack, changes, prs } = await fileStack(env, ["a", "b", "c"])
    await env.jj(["rebase", "-r", changes[1], "--insert-before", changes[0]])
    reorderEntries(stack, [1, 0, 2])
    const before = heads(env, prs)
    const stacks = env.activeStacks()
    const requests = env.requestCount()

    const out = await stack.tryJjack("submit", ["--upto", changes[0], "-m", "swap"])
    expect(out.success, out.text).toBe(false)
    expect(out.flat).toContain(`also contains #${prs[2]}`)
    expect(out.text).not.toContain("Dissolving")
    nothingPushed(env, prs, before)
    expect(env.activeStacks(), "the stack must be kept").toEqual(stacks)
    expect(writesSince(env, requests), "nothing may change on GitHub").toEqual([])
  })

  it("updates_get_default_messages_and_m_replaces_the_last", async ({ expect }) => {
    // Without -m, each update commit is named for what it does: `Update`
    // brings a branch to the local tree, and a merge names what it merges
    await using env = await TestEnv.create()
    const { stack, changes, prs } = await fileStack(env, ["a", "b", "c"])
    const [a, b] = prs.map((n) => env.pr(n).headRef)
    const edit = async (i: number, content: string) => {
      const name = ["a", "b", "c"][i]
      await writeFile(join(env.work, `${name}.txt`), content)
      await env.jj(["squash", "--into", changes[i]])
    }

    // An edit of B and C: B gets an `Update`. C's update merges B's new head
    // first, with what GitHub's replay would give, then brings C to its tree.
    await edit(1, "b, edited\n")
    await edit(2, "c, edited\n")
    await stack.jjack("submit")
    await checkChain(env, changes, prs)
    expect(env.prCommits(prs[1])).toEqual(["Change B", "Update"])
    expect(env.prCommits(prs[2])).toEqual(["Change C", `Merge #${prs[1]} (${b})`, "Update"])

    // -m replaces the last commit's message, and the merge keeps its own
    await edit(1, "b, edited again\n")
    await edit(2, "c, edited again\n")
    await stack.jjack("submit", ["-m", "review feedback"])
    await checkChain(env, changes, prs)
    expect(env.prCommits(prs[1]).slice(2)).toEqual(["review feedback"])
    expect(env.prCommits(prs[2]).slice(3)).toEqual([
      `Merge #${prs[1]} (${b})`,
      "review feedback",
    ])

    // A rebase onto a newer main: the bottom one merges main, and each one
    // above merges the one below. The replays give the local trees, so each
    // update is the merge alone.
    await env.pushToMain("other.txt", "other\n")
    await env.jj(["git", "fetch"])
    await env.jj(["rebase", "-s", changes[0], "-d", "main@origin"])
    await stack.jjack("submit")
    await checkChain(env, changes, prs)
    expect(env.prCommits(prs[0])).toEqual(["Change A", "Merge main"])
    expect(env.prCommits(prs[1]).at(-1)).toBe(`Merge #${prs[0]} (${a})`)
    expect(env.prCommits(prs[2]).at(-1)).toBe(`Merge #${prs[1]} (${b})`)
  })

  it("reorder_two_adjacent_pull_requests_and_land", async ({ expect }) => {
    // B moves above C. B's original commit is then in C's branch, so B's
    // update has to bring B's change in a commit of its own, or GitHub's
    // rebase after A merges leaves B with no commits and closes it.
    await reorderAndLand(expect, [0, 2, 1])
  })

  it("submit_refuses_when_github_moved_pr_onto_newer_main", async ({ expect }) => {
    await using env = await TestEnv.create()
    const { stack, changes, prs } = await fileStack(env, ["a", "b"])
    await env.pushToMain("other.txt", "other\n")
    env.gh.rebaseStackOnGithub(prs[0])
    const before = heads(env, prs)

    const out = await stack.tryJjack("submit", ["--json"])
    expect(out.code, out.text).toBe(1)
    expect(JSON.parse(out.stdout).error).toMatchObject({
      code: "needs_sync",
      fix: [`jjack sync ${stack.path}`, `jjack submit ${stack.path}`],
    })
    nothingPushed(env, prs, before)

    // Following the fix rebases locally and submits cleanly without reverting other.txt
    await stack.jjack("sync")
    await stack.jjack("submit")
    await checkChain(env, changes, prs)
    expect(env.prFiles(prs[0])).toEqual(["a.txt"])
    expect(env.prFiles(prs[1])).toEqual(["b.txt"])
  })

  it("submit_refuses_after_github_update_branch", async ({ expect }) => {
    await using env = await TestEnv.create()
    const { stack, prs } = await fileStack(env, ["a"])
    await env.pushToMain("other.txt", "other\n")
    env.gh.updateBranch(prs[0])
    const before = heads(env, prs)

    const out = await stack.tryJjack("submit", ["--json"])
    expect(out.code, out.text).toBe(1)
    expect(JSON.parse(out.stdout).error).toMatchObject({
      code: "needs_sync",
      pr: prs[0],
      fix: [`jjack sync ${stack.path}`, `jjack submit ${stack.path}`],
    })
    nothingPushed(env, prs, before)
    expect(env.prFiles(prs[0])).toEqual(["a.txt"])
  })

  it("move_the_top_pull_request_to_the_bottom_and_land", async ({ expect }) => {
    await reorderAndLand(expect, [2, 0, 1])
  })
})
