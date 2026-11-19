// Scenario tests of the description-line source: `submit`, `land`, `sync`,
// and `close` with `-r <rev>` on changes whose `Pull Request:` lines link
// them to their pull requests. Three of them are ports of jj-spr's
// `diff_refuses_a_change_linking_two_pull_requests`,
// `diff_checks_for_closed_pull_requests_before_pushing`, and
// `close_deletes_the_branch_and_unlinks_the_change`.

import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, it } from "vitest"
import { checkChain, TestEnv } from "./env.ts"
import { heads } from "./stack.ts"

const url = (number: number) => `https://github.com/fake/repo/pull/${number}`

/** One change per name ("Change A" adding `a.txt` for "a"), submitted with
 * `submit -r` on the top one. Returns the changes and their pull requests. */
async function lineStack(
  env: TestEnv,
  names: string[],
): Promise<{ changes: string[]; prs: number[] }> {
  const changes = []
  for (const name of names) {
    changes.push(
      await env.commit(`Change ${name.toUpperCase()}`, `${name}.txt`, `${name}\n`),
    )
  }
  await env.jjack(["submit", "-r", changes.at(-1)!, "-m", "initial"])
  return { changes, prs: await env.prsFor(changes) }
}

/** The recorded requests since `from` that change something on GitHub */
function writesSince(env: TestEnv, from: number): string[] {
  return ["POST", "PATCH", "PUT", "DELETE"].flatMap((method) =>
    env.requestsSince(from, method, "/repos/"),
  )
}

describe.concurrent("the description-line source", () => {
  it("submit_opens_one_pull_request_per_change_and_writes_the_lines", async ({
    expect,
  }) => {
    await using env = await TestEnv.create()
    const changes = []
    for (const name of ["a", "b", "c"]) {
      const upper = name.toUpperCase()
      changes.push(
        await env.commit(
          `Change ${upper}\n\nWhat ${upper} does.`,
          `${name}.txt`,
          `${name}\n`,
        ),
      )
    }

    const out = await env.jjack(["submit", "-r", changes[2]])
    const prs = await env.prsFor(changes)
    expect(prs).toEqual([1, 2, 3])
    for (const number of prs) {
      expect(out.flat).toContain(`Created new pull request #${number}: ${url(number)}`)
    }
    await checkChain(env, changes, prs)
    expect(env.requestsSince(0, "POST", "/stacks"), "one stack creation").toHaveLength(1)
    for (const [i, name] of ["A", "B", "C"].entries()) {
      expect(await env.description(changes[i])).toBe(
        `Change ${name}\n\nWhat ${name} does.\n\nPull Request: ${url(prs[i])}\n`,
      )
      expect(env.pr(prs[i])).toMatchObject({
        title: `Change ${name}`,
        body: `What ${name} does.`,
      })
    }
  })

  it("resubmit_is_a_noop", async ({ expect }) => {
    await using env = await TestEnv.create()
    const { changes, prs } = await lineStack(env, ["a", "b", "c"])
    const branches = env.gh.branches()
    const descriptions = await Promise.all(changes.map((c) => env.description(c)))
    const commits = await Promise.all(changes.map((c) => env.commitId(c)))
    const before = env.requestCount()

    const out = await env.jjack(["submit", "-r", changes[2], "-m", "again"])
    expect(env.gh.branches(), "rerun changed branches").toEqual(branches)
    expect(out.text).toContain("No update necessary")
    expect(writesSince(env, before), "rerun made changes").toEqual([])
    expect(await Promise.all(changes.map((c) => env.description(c)))).toEqual(descriptions)
    expect(
      await Promise.all(changes.map((c) => env.commitId(c))),
      "rerun described",
    ).toEqual(commits)
    await checkChain(env, changes, prs)
  })

  it("the_description_wins_for_title_and_body", async ({ expect }) => {
    await using env = await TestEnv.create()
    const { changes, prs } = await lineStack(env, ["a", "b"])
    const branches = env.gh.branches()
    // The title of A edited on GitHub, and the body of B edited locally
    env.gh.prs.get(prs[0])!.title = "Edited on GitHub"
    env.gh.prs.get(prs[0])!.body = "A body from GitHub"
    await env.jj([
      "describe",
      "-r",
      changes[1],
      "-m",
      `Change B\n\nA new body.\n\nPull Request: ${url(prs[1])}\n`,
    ])

    const out = await env.jjack(["submit", "-r", changes[1], "-m", "unused"])
    expect(out.flat).toContain(`Updated the title and body of #${prs[0]} on GitHub`)
    expect(out.flat).toContain(`Updated the body of #${prs[1]} on GitHub`)
    expect(env.pr(prs[0])).toMatchObject({ title: "Change A", body: "" })
    expect(env.pr(prs[1])).toMatchObject({ title: "Change B", body: "A new body." })
    expect(env.gh.branches(), "nothing to push").toEqual(branches)
    await checkChain(env, changes, prs)
  })

  it("an_edit_gives_an_update_commit_and_merges_above", async ({ expect }) => {
    await using env = await TestEnv.create()
    const { changes, prs } = await lineStack(env, ["a", "b", "c"])
    const old = heads(env, prs)
    const descriptions = await Promise.all(changes.map((c) => env.description(c)))

    await env.jj(["edit", changes[1]])
    await writeFile(join(env.work, "b.txt"), "b, revised\n")
    await env.jj(["new", changes[2]])
    await env.jjack(["submit", "-r", changes[2], "-m", "review feedback"])

    await checkChain(env, changes, prs)
    expect(env.headOf(prs[0]), "the bottom PR should not change").toBe(old[0])
    for (const [i, number] of prs.entries()) {
      if (i === 0) continue
      const head = env.headOf(number)
      expect(head, `PR #${number} was not updated`).not.toBe(old[i])
      expect(env.isAncestor(old[i], head), `PR #${number} lost its history`).toBe(true)
    }
    expect(env.remoteGit(["log", "-1", "--format=%s", env.headOf(prs[1])])).toBe(
      "review feedback",
    )
    expect(await Promise.all(changes.map((c) => env.description(c)))).toEqual(descriptions)
  })

  it("submit_refuses_a_line_it_cannot_read", async ({ expect }) => {
    for (const stacks of [true, false]) {
      await using env = await TestEnv.create({ stacks })
      const { changes, prs } = await lineStack(env, ["a", "b", "c"])

      if (stacks) {
        // A URL for another repository
        const foreign = "https://github.com/other/repo/pull/3"
        const own = await env.description(changes[2])
        await env.jj([
          "describe",
          "-r",
          changes[2],
          "-m",
          `Change C\n\nPull Request: ${foreign}\n`,
        ])
        const before = heads(env, prs)
        const stacksBefore = env.activeStacks()
        const out = await env.tryJjack(["submit", "-r", changes[2], "-m", "foreign"])
        expect(out.success, `submit should refuse:\n${out.text}`).toBe(false)
        expect(out.flat).toContain(
          `Not submitting: ${changes[2].slice(0, 8)} has a \`Pull Request:\` line that jjack cannot read:`,
        )
        expect(out.flat).toContain(foreign)
        expect(out.text).not.toContain("Created new")
        expect(heads(env, prs), "nothing may be pushed").toEqual(before)
        expect(env.gh.prs.size, "nothing may be opened").toBe(prs.length)
        expect(env.activeStacks(), "the stack must be kept").toEqual(stacksBefore)
        await env.jj(["describe", "-r", changes[2], "-m", own])
      }

      // Keep both descriptions, as `jj squash` does in an editor
      await env.jj(["--config", 'ui.editor="true"', "squash", "-r", changes[1]])
      const description = await env.description(changes[0])
      expect(description.match(/Pull Request:/g), description).toHaveLength(2)
      const before = heads(env, [prs[0], prs[2]])
      const stacksBefore = env.activeStacks()

      const out = await env.tryJjack(["submit", "-r", changes[2], "-m", "after squash"])
      expect(out.success, `submit should refuse:\n${out.text}`).toBe(false)
      expect(out.flat).toContain("more than one pull request")
      expect(out.flat).toContain(`/pull/${prs[0]}`)
      expect(out.flat).toContain(`/pull/${prs[1]}`)
      expect(out.text).not.toContain("Created new")
      expect(heads(env, [prs[0], prs[2]]), "nothing may be pushed").toEqual(before)
      expect(env.activeStacks(), "the stack must be kept").toEqual(stacksBefore)
    }
  })

  it("submit_refuses_two_changes_with_one_pull_request", async ({ expect }) => {
    await using env = await TestEnv.create()
    const { changes, prs } = await lineStack(env, ["a", "b"])
    await env.jj(["duplicate", changes[0], "--onto", changes[1]])
    const copy = await env.changeId(`children(${changes[1]}) ~ @`)
    const before = heads(env, prs)
    const stacksBefore = env.activeStacks()

    const out = await env.tryJjack(["submit", "-r", copy, "-m", "duplicate"])
    expect(out.success, `submit should refuse:\n${out.text}`).toBe(false)
    expect(out.flat).toContain(
      `Not submitting: Pull request #${prs[0]} is linked from more than one change: ` +
        `${changes[0].slice(0, 8)}, ${copy.slice(0, 8)}.`,
    )
    expect(out.flat).toContain(
      "Keep the `Pull Request:` line on one of them and remove it from the others",
    )
    expect(heads(env, prs), "nothing may be pushed").toEqual(before)
    expect(env.gh.prs.size, "nothing may be opened").toBe(prs.length)
    expect(env.activeStacks(), "the stack must be kept").toEqual(stacksBefore)
  })

  it("submit_refuses_merged_and_closed_pull_requests", async ({ expect }) => {
    await using env = await TestEnv.create()
    const { changes, prs } = await lineStack(env, ["a", "b"])
    // Amend A, so a run that pushes before checking would change A's pull
    // request
    await writeFile(join(env.work, "a.txt"), "a, amended\n")
    await env.jj(["squash", "--into", changes[0]])
    env.gh.closeOnGithub(prs[1])

    let before = heads(env, prs)
    let stacksBefore = env.activeStacks()
    let out = await env.tryJjack(["submit", "-r", changes[1], "-m", "update"])
    expect(out.success, `submit should refuse:\n${out.text}`).toBe(false)
    expect(out.flat).toContain(`#${prs[1]}`)
    expect(out.flat).toContain(
      `Not submitting: Pull request #${prs[1]} is closed. If you want to open a new one, ` +
        "remove the `Pull Request:` line from the change's description.",
    )
    expect(heads(env, prs), "nothing may be pushed").toEqual(before)
    expect(env.activeStacks(), "the stack must be kept").toEqual(stacksBefore)

    // Removing the line of the closed one opens a new pull request
    await env.jj(["describe", "-r", changes[1], "-m", "Change B\n"])
    out = await env.jjack(["submit", "-r", changes[1], "-m", "update"])
    const b = await env.prFor(changes[1])
    expect(b).not.toBe(prs[1])
    expect(out.flat).toContain(`Created new pull request #${b}`)
    expect(env.prFiles(prs[0])).toEqual(["a.txt"])
    expect(env.treeOfPr(prs[0])).toBe(await env.treeOf(changes[0]))
    await checkChain(env, changes, [prs[0], b])
    expect(env.pr(prs[1]).state).toBe("closed")

    // A merged one
    env.gh.mergeOnGithub(prs[0])
    before = heads(env, [b])
    stacksBefore = env.activeStacks()
    out = await env.tryJjack(["submit", "-r", changes[1], "-m", "before sync"])
    expect(out.success, `submit should refuse:\n${out.text}`).toBe(false)
    expect(out.flat).toContain(`#${prs[0]} has already merged`)
    expect(out.flat).toContain(`jjack sync -r ${changes[1]}`)
    expect(heads(env, [b]), "nothing may be pushed").toEqual(before)
    expect(env.activeStacks(), "the stack must be kept").toEqual(stacksBefore)
  })

  it("a_failure_partway_still_writes_the_lines", async ({ expect }) => {
    await using env = await TestEnv.create()
    const a = await env.commit("Change A", "a.txt", "a\n")
    const b = await env.commit("Change B", "b.txt", "b\n")
    env.gh.failingCreations.push("spr/change-b")

    const out = await env.tryJjack(["submit", "-r", b])
    expect(out.success, `submit should fail:\n${out.text}`).toBe(false)
    const first = await env.prFor(a)
    expect(env.pr(first).state).toBe("open")
    expect(await env.description(b)).toBe("Change B\n")
    const orphan = env.branch("spr/change-b")
    expect(orphan, "the branch was pushed").toBeDefined()
    expect(out.flat).toContain("git push origin --delete spr/change-b")

    await env.jjack(["submit", "-r", b, "-m", "unused"])
    const prs = await env.prsFor([a, b])
    expect(prs[0]).toBe(first)
    await env.checkPr(prs[0], "main", ["a.txt"], a)
    await env.checkPr(prs[1], "spr/change-a", ["b.txt"], b)
    expect(env.pr(prs[1]).headRef).toBe("spr/change-b-1")
    expect(env.activeStacks()).toEqual([prs])
    expect(env.branch("spr/change-b")).toBe(orphan)
  })

  it("land_lands_the_range_and_sync_abandons_it", async ({ expect }) => {
    await using env = await TestEnv.create()
    const { changes, prs } = await lineStack(env, ["a", "b", "c"])
    const merged = prs.slice(0, 2).map((n) => env.pr(n).headRef)

    await env.jjack(["land", "--no-sync", "-r", changes[1]])
    for (const number of prs.slice(0, 2)) {
      expect(env.pr(number).mergedAt, `PR #${number} should be merged`).not.toBeNull()
    }
    const top = env.pr(prs[2])
    expect(top.state, `PR #${prs[2]} was closed: ${top.closedReason}`).toBe("open")
    expect(top.baseRef, "the rest of the stack now targets main").toBe("main")
    for (const branch of merged) {
      expect(env.branch(branch), `${branch} should be deleted`).toBeUndefined()
    }

    await env.jjack(["sync", "-r", changes[2]])
    for (const change of changes.slice(0, 2)) {
      expect(await env.isVisible(change), `${change} should be abandoned`).toBe(false)
    }
    expect(await env.parentOf(changes[2]), "the top change is on main").toBe(
      env.branch("main"),
    )
    expect(await env.prFor(changes[2])).toBe(prs[2])

    const before = env.requestCount()
    const out = await env.jjack(["submit", "-r", changes[2]])
    expect(out.text).toContain("No update necessary")
    expect(writesSince(env, before)).toEqual([])
    expect(env.prFiles(prs[2])).toEqual(["c.txt"])
  })

  it("reorder_and_insert_rebuild_the_stack", async ({ expect }) => {
    await using env = await TestEnv.create()
    const { changes, prs } = await lineStack(env, ["a", "b", "c"])
    const main = env.branch("main")!
    // a, c, x, b
    await env.jj(["rebase", "-r", changes[2], "--insert-after", changes[0]])
    await env.jj(["new", "--insert-after", changes[2], "-m", "Change X"])
    await writeFile(join(env.work, "x.txt"), "x\n")
    const x = await env.changeId("@")
    await env.jj(["new", changes[1]])

    const out = await env.jjack(["submit", "-r", changes[1], "-m", "reorder"])
    expect(out.text).toContain("Dissolving GitHub stack")
    const order = [changes[0], changes[2], x, changes[1]]
    const numbers = await env.prsFor(order)
    expect(numbers, "Pull requests keep their numbers").toEqual([
      prs[0],
      prs[2],
      numbers[2],
      prs[1],
    ])
    expect(prs, "X has a new pull request").not.toContain(numbers[2])
    await checkChain(env, order, numbers)
    expect(env.activeStacks()).toHaveLength(1)

    await env.jjack(["land", "-r", changes[1]])
    for (const number of numbers) {
      const pr = env.pr(number)
      expect(
        pr.mergedAt,
        `PR #${number} was not merged (${pr.closedReason})`,
      ).not.toBeNull()
    }
    expect(env.landedSince(main)).toEqual([
      "Change A: a.txt",
      "Change C: c.txt",
      "Change X: x.txt",
      "Change B: b.txt",
    ])
  })

  it("close_removes_the_line", async ({ expect }) => {
    await using env = await TestEnv.create()
    const a = await env.commit("Change A", "a.txt", "a\n")
    await env.jjack(["submit", "-r", a, "-m", "A"])
    const pr = await env.prFor(a)
    const branch = env.pr(pr).headRef

    await env.jjack(["close", "-r", a])
    expect(env.pr(pr).state).not.toBe("open")
    expect(env.pr(pr).mergedAt).toBeNull()
    expect(env.branch(branch), "the branch should be deleted").toBeUndefined()
    expect((await env.description(a)).trim()).toBe("Change A")
    expect(await env.description(a)).toBe("Change A\n")
    expect(await env.filesIn(a), "the change is kept").toEqual(["a.txt"])

    // --all closes every pull request up to the revision
    const b = await env.commit("Change B", "b.txt", "b\n")
    const c = await env.commit("Change C", "c.txt", "c\n")
    await env.jjack(["submit", "-r", c])
    const changes = [a, b, c]
    const prs = await env.prsFor(changes)
    expect(prs).not.toContain(pr)
    const branches = prs.map((n) => env.pr(n).headRef)

    await env.jjack(["close", "-r", c, "--all"])
    for (const [i, number] of prs.entries()) {
      expect(env.pr(number).state, `PR #${number}`).toBe("closed")
      expect(env.pr(number).mergedAt).toBeNull()
      expect(env.branch(branches[i]), `${branches[i]} should be deleted`).toBeUndefined()
      expect(await env.description(changes[i])).toBe(`Change ${"ABC"[i]}\n`)
      expect(await env.filesIn(changes[i])).toEqual([`${"abc"[i]}.txt`])
    }
  })

  it("submit_refuses_a_merge_and_an_empty_description", async ({ expect }) => {
    await using env = await TestEnv.create()
    const a = await env.commit("Change A", "a.txt", "a\n")
    const nothingChanged = () => {
      expect(env.gh.prs.size, "nothing may be opened").toBe(0)
      expect([...env.gh.branches().keys()], "nothing may be pushed").toEqual(["main"])
    }

    // A merge of A and main
    await env.jj(["new", a, "main@origin", "-m", "Merge"])
    const merge = await env.commitId("@")
    let out = await env.tryJjack(["submit", "-r", "@"])
    expect(out.success, `submit should refuse:\n${out.text}`).toBe(false)
    expect(out.flat).toContain(
      "Not submitting: the changes up to the target are not a single line of changes " +
        `(${merge.slice(0, 7)} is a merge). Pass \`-r <top of one stack>\` to pick one stack.`,
    )
    nothingChanged()

    // Two branches
    await env.jj(["new", "main@origin"])
    const b = await env.commit("Change B", "b.txt", "b\n")
    out = await env.tryJjack(["submit", "-r", `${a} | ${b}`])
    expect(out.success, `submit should refuse:\n${out.text}`).toBe(false)
    expect(out.flat).toContain(
      "Not submitting: the changes up to the target are not a single line of changes " +
        `(${(await env.commitId(b)).slice(0, 7)} is on a separate branch).`,
    )
    nothingChanged()

    // A change without a description
    await env.jj(["new", a])
    await writeFile(join(env.work, "c.txt"), "c\n")
    await env.jj(["commit", "-m", ""])
    const empty = await env.changeId("@-")
    out = await env.tryJjack(["submit", "-r", empty])
    expect(out.success, `submit should refuse:\n${out.text}`).toBe(false)
    expect(out.flat).toContain(
      `Not submitting: ${empty.slice(0, 8)} has no description. A change's first line is ` +
        "its pull request's title. Describe it with `jj describe`.",
    )
    nothingChanged()
  })

  it("land_refuses_a_change_without_a_pull_request", async ({ expect }) => {
    await using env = await TestEnv.create()
    const { prs } = await lineStack(env, ["a"])
    const b = await env.commit("Change B", "b.txt", "b\n")

    const out = await env.tryJjack(["land", "-r", b])
    expect(out.success, `land should refuse:\n${out.text}`).toBe(false)
    expect(out.flat).toContain(
      `${b.slice(0, 8)} has no pull request yet. Run \`jjack submit -r ${b}\` first.`,
    )
    expect(out.text).toContain("🛑")
    expect(env.pr(prs[0]).state).toBe("open")
    expect(env.pr(prs[0]).mergedAt).toBeNull()
    expect(env.requestsSince(0, "PUT", "merge")).toEqual([])
  })
})
