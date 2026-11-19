// End-to-end tests of stack files (`jjack init`, `status`, `adopt`, `submit`,
// and `land`, `sync`, and `close` with a stack file) against the fake GitHub.
// A port of `tests/stack_file.rs` from the Rust prototype of stack files (a
// fork of jj-spr), with the asserts of other Rust tests merged into these.

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { type ExpectStatic, describe, it } from "vitest"
import { TestEnv } from "./env.ts"
import { Stack, change, heads, nothingPushed, submitted, threeEntries } from "./stack.ts"

/** How many times `needle` appears in `text` */
const count = (text: string, needle: string) => text.split(needle).length - 1

const PULL_REQUEST_DEFAULTS_HINT =
  "Setting the repository's default squash commit message to the pull request title and description lets jjack land a stack in one merge."

/** The `sincePushed` of each change of entry `index` in `status --json` */
async function sincePushed(stack: Stack, index: number): Promise<string[]> {
  const json = await stack.statusJson()
  return json.entries[index].members.map(
    (m: { sincePushed?: string }) => m.sincePushed ?? "(none)",
  )
}

/** The sentences of the actions of entry `index` in a status */
const actionTexts = (json: Record<string, any>, index: number): string[] =>
  json.entries[index].actions.map((a: { text: string }) => a.text)

/** The base branch of each of `prs` */
const bases = (env: TestEnv, prs: number[]) => prs.map((n) => env.pr(n).baseRef)

/** The parents of a commit on GitHub, space-separated */
const parents = (env: TestEnv, commit: string) =>
  env.remoteGit(["log", "-1", "--format=%P", commit])

/** A branch `name` on GitHub that this repository has never fetched, at a
 * commit of someone else's. Returns the commit. */
function foreignBranch(env: TestEnv, name: string): string {
  const commit = env.remoteGit(["commit-tree", "main^{tree}", "-m", "Someone else's work"])
  env.remoteGit(["update-ref", `refs/heads/${name}`, commit])
  return commit
}

/** The live version of a change: once jjack pushes on top of an adopted
 * branch, the old versions in that branch's history are visible too. */
const live = (change: string) => `change_id(${change}) & mutable()`

/** Whether jj tracks `bookmark@origin` */
async function tracked(env: TestEnv, bookmark: string): Promise<boolean> {
  const listing = await env.jjQuery([
    "bookmark",
    "list",
    "--all-remotes",
    "-T",
    'if(remote == "origin", tracked ++ "\\n")',
    `exact:${bookmark}`,
  ])
  return listing.trim() === "true"
}

/** A stack pushed the way people do without jjack: A (a1, a2) <- B (b1) <- C
 * (c1, c2), each pushed with `jj git push` to a branch named like its local
 * bookmark (feat-a, feat-b, feat-c), with a pull request opened by hand and a
 * GitHub stack. a1 was rewritten and force-pushed once. The stack file has
 * only `tip` and `body`: A's body file matches GitHub, B's has a different
 * body, and C's has a different title. Returns the stack, the changes by
 * entry, and the pull requests. */
async function pushedWithoutJjack(env: TestEnv): Promise<[Stack, string[][], number[]]> {
  const names = [["a1", "a2"], ["b1"], ["c1", "c2"]]
  const groups: string[][] = []
  const prs: number[] = []
  let base = "main"
  for (const [i, letter] of ["a", "b", "c"].entries()) {
    const members = []
    for (const name of names[i]) members.push(await change(env, name))
    const bookmark = `feat-${letter}`
    const top = members[members.length - 1]
    await env.jj(["git", "push", "--named", `${bookmark}=${top}`])
    const number = env.gh.openPrOutsideJjack(
      bookmark,
      base,
      `Title of ${letter.toUpperCase()}`,
    )
    env.gh.prs.get(number)!.body = `What ${letter} does.`
    prs.push(number)
    groups.push(members)
    base = bookmark
  }
  if (env.gh.stacksEnabled) env.gh.stackOutsideJjack(prs)
  // The force push, as after a review
  await env.jj(["edit", groups[0][0]])
  writeFileSync(join(env.work, "a1.txt"), "a1, reviewed\n")
  await env.jj(["new", groups[2][1]])
  await env.jj(["git", "push", "--bookmark", "glob:feat-*"])

  const stack = new Stack(env)
  stack.body("a.md", "# Title of A\n\nWhat a does.\n")
  stack.body("b.md", "# Title of B\n\nWhat B does, as the file has it.\n")
  stack.body("c.md", "# The file's title of C\n\nWhat c does.\n")
  stack.entries([
    { tip: "feat-a", body: "a.md" },
    { tip: "feat-b", body: "b.md" },
    { tip: "feat-c", body: "c.md" },
  ])
  return [stack, groups, prs]
}

/** The subject and body of each commit on main above `from`, oldest first */
function mainCommits(env: TestEnv, from: string): [string, string][] {
  return env
    .remoteGit(["log", "--reverse", "--format=%H", `${from}..main`])
    .split("\n")
    .filter(Boolean)
    .map((commit) => [
      env.remoteGit(["log", "-1", "--format=%s", commit]),
      env.remoteGit(["log", "-1", "--format=%b", commit]),
    ])
}

/** The messages of the commits on main after `since`, oldest first */
function messagesOnMainSince(env: TestEnv, since: string): string[] {
  return env
    .remoteGit(["log", "--reverse", "--format=%B%x00", `${since}..main`])
    .split("\0")
    .map((m) => m.trim())
    .filter(Boolean)
}

/** GitHub's default squash message under `PR_TITLE` and `PR_BODY` */
function defaultMessage(env: TestEnv, number: number): string {
  const pr = env.pr(number)
  const body = pr.body.trim()
  return body === "" ? `${pr.title} (#${number})` : `${pr.title} (#${number})\n\n${body}`
}

/** After a sync, `changes` sit in order directly on `main@origin` */
async function expectRebasedOntoMain(
  expect: ExpectStatic,
  env: TestEnv,
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

/** Edit change a of `threeEntries`, then `submit --upto <upto>`: the entries
 * up to `upto` (`count` of them) are updated, and the ones above it, their
 * pull requests, and the GitHub stack are left as they were. A full submit
 * afterwards gives each entry above one merge of the one below. */
async function submitUptoAfterAnEditBelow(
  expect: ExpectStatic,
  upto: (groups: string[][]) => string,
  count: number,
): Promise<void> {
  await using env = await TestEnv.create()
  const [stack, groups, prs] = await submitted(env)
  const before = heads(env, prs)
  const basesBefore = bases(env, prs)
  const stacksBefore = env.stacks()
  const fileBefore = stack.read()

  await env.jj(["edit", groups[0][0]])
  writeFileSync(join(env.work, "a.txt"), "a, revised\n")
  await env.jj(["new", groups[2][0]])
  const out = await stack.jjack("submit", ["--upto", upto(groups), "-m", "revise a"])
  expect(env.prCommits(prs[0]).at(-1)).toBe("revise a")
  for (let i = 1; i < count; i++) {
    expect(parents(env, env.headOf(prs[i]))).toBe(`${before[i]} ${env.headOf(prs[i - 1])}`)
  }
  expect(heads(env, prs).slice(count), out.text).toEqual(before.slice(count))
  expect(bases(env, prs)).toEqual(basesBefore)
  expect(env.stacks(), out.text).toEqual(stacksBefore)
  for (let i = count; i < 3; i++) expect(stack.entry(i)).toEqual(fileBefore.prs[i])

  const updated = heads(env, prs)
  await stack.jjack("submit", ["-m", "revise a"])
  expect(heads(env, prs).slice(0, count)).toEqual(updated.slice(0, count))
  for (let i = count; i < 3; i++) {
    expect(
      parents(env, env.headOf(prs[i])),
      `#${prs[i]} gets one merge of the pull request below`,
    ).toBe(`${before[i]} ${env.headOf(prs[i - 1])}`)
  }
  expect(bases(env, prs)).toEqual(basesBefore)
  expect(env.stacks()).toEqual(stacksBefore)
  await env.checkPr(prs[2], env.pr(prs[1]).headRef, ["c.txt"], groups[2][0])
}

describe.concurrent("init and status", () => {
  it("init_writes_one_entry_per_tip", async ({ expect }) => {
    await using env = await TestEnv.create()
    const a = await change(env, "a")
    const b1 = await change(env, "b1")
    const b2 = await change(env, "b2")
    const c = await change(env, "c")
    await env.jj(["bookmark", "create", "-r", b2, "feature-b"])
    const stack = new Stack(env)

    const tips = `${a} | ${b2} | ${c}`
    await env.jjack(["init", stack.path, "--tips", tips])
    expect(stack.read()).toEqual({
      prs: [
        { tip: a.slice(0, 12), title: "Change a" },
        { tip: "feature-b", title: "Change b2" },
        { tip: c.slice(0, 12), title: "Change c" },
      ],
    })
    const out = await env.tryJjack(["init", stack.path, "--tips", tips])
    expect(out.success, `init should refuse:\n${out.text}`).toBe(false)
    expect(out.text).toContain("already exists")

    const status = await stack.status()
    expect(status.success, status.text).toBe(true)
    expect(status.text).toContain("Change b1")
    expect(status.text).toContain(b1.slice(0, 8))
    expect(count(status.text, "open a pull request"), status.text).toBe(3)
  })

  it("init_needs_tips_in_a_line", async ({ expect }) => {
    await using env = await TestEnv.create()
    const a = await change(env, "a")
    await env.jj(["new", "trunk()"])
    const x = await change(env, "x")
    const stack = new Stack(env)
    const out = await env.tryJjack(["init", stack.path, "--tips", `${a} | ${x}`])
    expect(out.success, `init should refuse:\n${out.text}`).toBe(false)
    expect(out.flat).toContain("in a line")
    expect(existsSync(stack.path)).toBe(false)
  })

  it("status_lists_every_problem", async ({ expect }) => {
    await using env = await TestEnv.create()
    const a = await change(env, "a")
    const undescribed = await env.commit("", "b.txt", "b\n")
    const c = await env.commit(
      "Change c\n\nPull Request: https://github.com/fake/repo/pull/9",
      "c.txt",
      "c\n",
    )
    const stack = new Stack(env)
    // An entry's changes are unknown when the tip below it doesn't resolve,
    // so the entries with bad tips go on top.
    stack.entries([
      { tip: a, title: "A" },
      { tip: undescribed, body: "b.md" },
      { tip: c, title: "C" },
      { tip: "@-" },
      { tip: "nothing-by-this-name", title: "Missing" },
    ])
    stack.body("b.md", "A body without a heading.\n")

    // status exits 0 whenever it could produce the status, with the problems
    // listed at the end
    const out = await stack.status()
    expect(out.success, `status should succeed:\n${out.text}`).toBe(true)
    expect(out.flat).toContain("has 6 problems.")
    for (const expected of [
      "relative to the working copy",
      "not a local bookmark",
      "has no title",
      "no description",
      "`Pull Request:` line",
    ]) {
      expect(out.flat, expected).toContain(expected)
    }

    const json = await stack.statusJson()
    expect(json.problems, JSON.stringify(json, null, 2)).toHaveLength(6)
    expect(json.entries[0].title).toBe("A")
    expect(json.entries[0].titleFrom).toBe("key")
    expect(json.entries[0].members[0].changeId).toBe(a)
    expect(json.entries[0].actions[0]).toEqual({
      kind: "open",
      text: "open a pull request",
    })
    expect(env.gh.prs.size).toBe(0)
  })

  it("status_refuses_tips_out_of_line_and_duplicates", async ({ expect }) => {
    await using env = await TestEnv.create()
    const a = await change(env, "a")
    const b = await change(env, "b")
    await env.jj(["new", "trunk()"])
    const x = await change(env, "x")
    const stack = new Stack(env)
    stack.entries([
      { tip: b, title: "B" },
      { tip: a, title: "A" },
    ])
    const out = (await stack.status()).flat
    expect(out).toContain("not in a line")
    expect(out).toContain("has 1 problem.")
    stack.entries([
      { tip: a, title: "A" },
      { tip: a, title: "A again" },
    ])
    expect((await stack.status()).flat).toContain("point to the same change")
    stack.entries([
      { tip: a, title: "A" },
      { tip: x, title: "X" },
    ])
    expect((await stack.status()).flat).toContain("not in a line")
    stack.entries([{ tip: "trunk", title: "T" }])
    await env.jj(["bookmark", "create", "-r", "trunk()", "trunk"])
    expect((await stack.status()).flat).toContain("has no changes")
  })

  it("status_refuses_divergent_and_hidden_tips", async ({ expect }) => {
    await using env = await TestEnv.create()
    const a = await change(env, "a")
    const b = await change(env, "b")
    await env.jj(["abandon", b])
    const stack = new Stack(env)
    stack.entries([{ tip: b, title: "B" }])
    expect((await stack.status()).flat).toContain("missing or hidden")

    const ops = await env.jjQuery(["op", "log", "--no-graph", "-T", 'id ++ "\\n"'])
    const op = ops.split("\n")[0]
    await env.jj(["describe", "-r", a, "-m", "Change a, once"])
    await env.jj(["--at-op", op, "describe", "-r", a, "-m", "Change a, twice"])
    stack.entries([{ tip: a, title: "A" }])
    expect((await stack.status()).flat).toContain("is divergent")
  })
})

describe.concurrent("submit", () => {
  it("submit_opens_a_stack_of_pull_requests", async ({ expect }) => {
    await using env = await TestEnv.create()
    const [stack, groups] = await threeEntries(env)
    const out = await stack.jjack("submit", ["-m", "unused"])
    expect(count(out.text, "Created new"), out.text).toBe(3)

    const prs = stack.prs()
    // From create_stack: the first pull requests of the repository
    expect(prs).toEqual([1, 2, 3])
    const titles = ["Title of A", "Title of B", "Title of C"]
    const bodies = ["What A does.", "What B does.\n\nIn two paragraphs.", ""]
    let base = "main"
    for (const [i, number] of prs.entries()) {
      const pr = env.pr(number)
      expect([pr.title, pr.body]).toEqual([titles[i], bodies[i]])
      const entry = stack.entry(i)
      expect(entry.synced).toMatch(/^sha256:/)
      expect(entry.pushed).toBe(await env.commitId(groups[i].at(-1)!))
      expect(pr.baseRef).toBe(base)
      base = pr.headRef
    }
    await env.checkPr(prs[0], "main", ["a.txt"], groups[0][0])
    await env.checkPr(
      prs[1],
      env.pr(prs[0]).headRef,
      ["b1.txt", "b2.txt", "b3.txt"],
      groups[1][2],
    )
    expect(env.prCommits(prs[1]), "one commit per change").toEqual([
      "Change b1",
      "Change b2",
      "Change b3",
    ])
    await env.checkPr(prs[2], env.pr(prs[1]).headRef, ["c.txt"], groups[2][0])
    expect(env.activeStacks()).toEqual([prs])
    // From create_stack: no legacy base branches, and one stack creation
    expect(
      [...env.gh.branches().keys()].some((b) => b.startsWith("spr/main.")),
      "submit should not create spr/main.* base branches",
    ).toBe(false)
    expect(env.requestsSince(0, "POST", "/stacks"), "one stack creation").toHaveLength(1)
    for (const c of groups.flat()) {
      const description = await env.description(c)
      expect(description, c).not.toContain("Pull Request:")
    }
    expect(stack.entry(1)["x-note"]).toBe("kept")

    // Again: nothing to do.
    const before = heads(env, prs)
    const file = stack.read()
    const again = await stack.jjack("submit", ["-m", "unused"])
    expect(count(again.text, "No update necessary"), again.text).toBe(3)
    nothingPushed(env, prs, before)
    expect(stack.read()).toEqual(file)
  })

  it("submit_dry_run_changes_nothing", async ({ expect }) => {
    await using env = await TestEnv.create()
    const [stack] = await threeEntries(env)
    const file = stack.read()
    const out = await stack.jjack("submit", ["--dry-run"])
    expect(count(out.text, "CREATE"), out.text).toBe(3)
    expect(out.text).toContain('"Title of B"')
    expect(env.gh.prs.size).toBe(0)
    expect([...env.gh.branches().keys()].some((b) => b.startsWith("spr/"))).toBe(false)
    expect(stack.read()).toEqual(file)
  })

  it("submit_appends_to_existing_pull_requests", async ({ expect }) => {
    await using env = await TestEnv.create()
    const [stack, groups, prs] = await submitted(env)
    const before = heads(env, prs)

    // An edit to a lower change: one commit on its pull request, and a merge
    // of it in each one above.
    await env.jj(["edit", groups[0][0]])
    writeFileSync(join(env.work, "a.txt"), "a, revised\n")
    await env.jj(["new", groups[2][0]])
    await stack.jjack("submit", ["-m", "revise a"])
    expect(env.prCommits(prs[0]).at(-1)).toBe("revise a")
    expect(
      env.remoteGit(["rev-list", "--count", `${before[0]}..${env.headOf(prs[0])}`]),
    ).toBe("1")
    for (let i = 1; i < 3; i++) {
      expect(
        parents(env, env.headOf(prs[i])),
        `#${prs[i]} merges the pull request below`,
      ).toBe(`${before[i]} ${env.headOf(prs[i - 1])}`)
    }
    await env.checkPr(prs[0], "main", ["a.txt"], groups[0][0])
    await env.checkPr(prs[2], env.pr(prs[1]).headRef, ["c.txt"], groups[2][0])

    // A new change at the top of an entry: a commit of its own.
    await env.jj(["new", "--insert-after", groups[0][0], "-m", "Change a2"])
    writeFileSync(join(env.work, "a2.txt"), "a2\n")
    const a2 = await env.changeId("@")
    await env.jj(["new", groups[2][0]])
    stack.edit(0, { tip: a2 })
    await stack.jjack("submit", ["-m", "unused"])
    expect(env.prCommits(prs[0])).toEqual(["Change a", "revise a", "Change a2"])
    await env.checkPr(prs[0], "main", ["a.txt", "a2.txt"], a2)
    await env.checkPr(
      prs[1],
      env.pr(prs[0]).headRef,
      ["b1.txt", "b2.txt", "b3.txt"],
      groups[1][2],
    )
    expect(env.activeStacks()).toEqual([prs])
    // From multi_change.rs a_change_added_on_top_is_appended_as_its_own_commit:
    // the pull request keeps its title, and a rerun finds nothing to do.
    expect(env.pr(prs[0]).title).toBe("Title of A")
    const again = await stack.jjack("submit", ["-m", "again"])
    expect(count(again.text, "No update necessary"), again.text).toBe(3)
    expect(again.text).not.toContain("differ")

    // From multi_change.rs amending_a_middle_member_appends_one_commit: an
    // edit to a member below the tip of an entry appends one commit.
    const commitsBefore = env.prCommits(prs[1])
    await env.jj(["edit", groups[1][1]])
    writeFileSync(join(env.work, "b2.txt"), "b2, revised\n")
    await env.jj(["new", groups[2][0]])
    const dry = await stack.jjack("submit", ["--dry-run"])
    expect(dry.flat).toContain(`#${prs[1]}`)
    expect(env.prCommits(prs[1]), "a dry run pushes nothing").toEqual(commitsBefore)
    await stack.jjack("submit", ["-m", "review feedback"])
    expect(env.prCommits(prs[1])).toEqual([...commitsBefore, "review feedback"])
    await env.checkPr(
      prs[1],
      env.pr(prs[0]).headRef,
      ["b1.txt", "b2.txt", "b3.txt"],
      groups[1][2],
    )
  })

  it("status_shows_what_changed_since_the_last_submit", async ({ expect }) => {
    await using env = await TestEnv.create()
    const [stack, groups, prs] = await submitted(env)
    for (let i = 0; i < 3; i++) {
      expect((await sincePushed(stack, i)).every((s) => s === "unchanged")).toBe(true)
    }
    const unchanged = await stack.status()
    expect(unchanged.text).toContain("No local changes since the last submit")

    // In B: b2 edited, b3 reworded, and a new change b4 on top. C is only
    // rebased.
    await env.jj(["edit", groups[1][1]])
    writeFileSync(join(env.work, "b2.txt"), "b2, revised\n")
    await env.jj(["describe", "-r", groups[1][2], "-m", "Change b3, reworded"])
    await env.jj(["new", "--insert-after", groups[1][2], "-m", "Change b4"])
    writeFileSync(join(env.work, "b4.txt"), "b4\n")
    await env.jj(["bookmark", "set", "b", "-r", "@"])
    await env.jj(["new", groups[2][0]])
    expect(await sincePushed(stack, 0)).toEqual(["unchanged"])
    expect(await sincePushed(stack, 1)).toEqual(["unchanged", "edited", "reworded", "new"])
    expect(await sincePushed(stack, 2)).toEqual(["unchanged"])
    let out = await stack.status()
    expect(out.success, out.text).toBe(true)
    for (const expected of [
      "Change b2 (edited since the last submit)",
      "Change b3, reworded (reworded since the last submit)",
      "Change b4 (new since the last submit)",
    ]) {
      expect(out.text, expected).toContain(expected)
    }

    // A commit that is not in the repository.
    stack.edit(0, { pushed: "0123456789abcdef0123456789abcdef01234567" })
    expect(await sincePushed(stack, 0)).toEqual(["unknown"])
    out = await stack.status()
    expect(out.success, out.text).toBe(true)
    expect(out.flat).toContain("not in this repository")

    // Submit records the new tips. (Without b4: `submit` takes an edit below
    // a new top change for someone else's push.)
    await env.jj(["bookmark", "set", "b", "--allow-backwards", "-r", groups[1][2]])
    await env.jj(["abandon", `${groups[1][2]}+ & ::${groups[2][0]}`])
    await stack.jjack("submit", ["-m", "revise b"])
    expect(stack.entry(1).pushed).toBe(await env.commitId("b"))
    expect(stack.entry(0).pushed).toBe(await env.commitId(groups[0][0]))
    for (let i = 0; i < 3; i++) {
      expect((await sincePushed(stack, i)).every((s) => s === "unchanged")).toBe(true)
    }
    expect(stack.prs()).toEqual(prs)
  })

  it("submit_updates_titles_and_bodies", async ({ expect }) => {
    await using env = await TestEnv.create()
    const [stack, , prs] = await submitted(env)
    const before = heads(env, prs)
    const synced = stack.entry(1).synced

    stack.body("b.md", "# New title of B\n\nNew body of B.\n")
    let out = await stack.jjack("submit", ["-m", "unused"])
    expect(out.flat).toContain(`Updated the title and body of #${prs[1]} on GitHub`)
    const pr = env.pr(prs[1])
    expect([pr.title, pr.body]).toEqual(["New title of B", "New body of B."])
    expect(stack.entry(1).synced).not.toEqual(synced)
    expect(heads(env, prs), "only the title and body change").toEqual(before)

    // Edited on GitHub only: GitHub's edit stays, and status and submit say
    // so.
    env.gh.prs.get(prs[1])!.title = "Edited on GitHub"
    const kept = "keep the title edited on GitHub"
    expect((await stack.status()).flat).toContain(kept)
    expect((await stack.statusJson()).entries[1]).toMatchObject({
      actions: [],
      keptFromGithub: "title",
    })
    out = await stack.jjack("submit", ["--dry-run"])
    expect(out.flat).toContain(`Would keep the title of #${prs[1]} as edited on GitHub`)
    out = await stack.jjack("submit", ["-m", "unused"])
    expect(out.flat).toContain("Keeping the title of #")
    expect(env.pr(prs[1]).title).toBe("Edited on GitHub")

    // Edited in both: refused, until --overwrite-github.
    stack.body("b.md", "# Third title of B\n\nNew body of B.\n")
    out = await stack.tryJjack("submit", ["-m", "unused"])
    expect(out.success, `submit should refuse:\n${out.text}`).toBe(false)
    expect(out.flat).toContain("--overwrite-github")
    expect(env.pr(prs[1]).title).toBe("Edited on GitHub")
    await stack.jjack("submit", ["-m", "unused", "--overwrite-github"])
    expect(env.pr(prs[1]).title).toBe("Third title of B")
    await stack.jjack("submit", ["-m", "unused"])
  })

  it("submit_upto_pushes_only_the_bottom_entries", async ({ expect }) => {
    await using env = await TestEnv.create()
    const a = await change(env, "a")
    const b = await change(env, "b")
    const unfinished = await env.commit("", "c.txt", "c\n")
    const stack = new Stack(env)
    stack.entries([{ tip: a, title: "A" }, { tip: b, title: "B" }, { tip: unfinished }])
    const out = await stack.tryJjack("submit", ["-m", "unused"])
    expect(out.success, `submit should refuse:\n${out.text}`).toBe(false)
    expect(env.gh.prs.size).toBe(0)

    await stack.jjack("submit", ["--upto", b, "-m", "unused"])
    const file = stack.read()
    const prs: number[] = [file.prs[0].pr, file.prs[1].pr]
    await env.checkPr(prs[0], "main", ["a.txt"], a)
    await env.checkPr(prs[1], env.pr(prs[0]).headRef, ["b.txt"], b)
    expect(file.prs[2].pr).toBeUndefined()
    expect(env.gh.prs.size).toBe(2)
  })

  it("submit_upto_the_bottom_leaves_the_entries_above_alone", async ({ expect }) => {
    await submitUptoAfterAnEditBelow(expect, (groups) => groups[0][0], 1)
  })

  it("submit_upto_the_middle_leaves_the_top_entry_alone", async ({ expect }) => {
    await submitUptoAfterAnEditBelow(expect, () => "b", 2)
  })

  it("a_rerun_after_a_failed_creation_opens_it_on_a_new_branch", async ({ expect }) => {
    await using env = await TestEnv.create()
    const a = await change(env, "a")
    const b = await change(env, "b")
    const stack = new Stack(env)
    stack.entries([
      { tip: a, title: "A" },
      { tip: b, title: "B" },
    ])
    env.gh.failingCreations.push("spr/b")

    const out = await stack.tryJjack("submit", ["-m", "unused"])
    expect(out.success, `submit should fail:\n${out.text}`).toBe(false)
    expect(Number.isInteger(stack.entry(0).pr), JSON.stringify(stack.entry(0))).toBe(true)
    expect(stack.entry(1).pr, JSON.stringify(stack.entry(1))).toBeUndefined()
    const orphan = env.branch("spr/b")
    expect(orphan, "the branch was pushed").toBeDefined()
    // No `cleanup` command: the error has the command that deletes the branch.
    expect(out.flat).toContain("git push origin --delete spr/b")

    await stack.jjack("submit", ["-m", "unused"])
    const prs = stack.prs()
    await env.checkPr(prs[0], "main", ["a.txt"], a)
    await env.checkPr(prs[1], "spr/a", ["b.txt"], b)
    expect(env.pr(prs[1]).headRef).toBe("spr/b-1")
    expect(env.activeStacks()).toEqual([prs])
    expect(env.branch("spr/b")).toBe(orphan)
  })

  it("a_new_pull_request_avoids_a_branch_name_taken_on_github", async ({ expect }) => {
    await using env = await TestEnv.create()
    const a = await change(env, "a")
    const b = await change(env, "b")
    const foreign = foreignBranch(env, "spr/a")
    const stack = new Stack(env)
    // Two entries with the same title get two names.
    stack.entries([
      { tip: a, title: "A" },
      { tip: b, title: "A" },
    ])
    await stack.jjack("submit")
    const prs = stack.prs()
    expect(env.pr(prs[0]).headRef).toBe("spr/a-1")
    expect(env.pr(prs[1]).headRef).toBe("spr/a-2")
    await env.checkPr(prs[1], "spr/a-1", ["b.txt"], b)
    expect(env.branch("spr/a")).toBe(foreign)
  })

  it("a_long_title_gives_a_short_branch_name", async ({ expect }) => {
    await using env = await TestEnv.create()
    const a = await change(env, "a")
    const title = "A title that goes on and on ".repeat(12)
    const stack = new Stack(env)
    stack.entries([{ tip: a, title }])
    await stack.jjack("submit")
    const branch = env.pr(stack.prs()[0]).headRef
    expect(branch.length, branch).toBeLessThanOrEqual("spr/".length + 100)
    const whole = `spr/${"a-title-that-goes-on-and-on-".repeat(12)}`
    expect(whole.startsWith(`${branch}-`), `cut after a word: ${branch}`).toBe(true)
  })

  it("submit_refuses_problems_in_the_changes", async ({ expect }) => {
    // Change b has a `Pull Request:` line, which a stack file refuses
    await using env = await TestEnv.create()
    const a = await env.commit("Change a", "README", "edited locally\n")
    const b = await env.commit(
      "Change b\n\nPull Request: https://github.com/fake/repo/pull/9",
      "b.txt",
      "b\n",
    )
    const stack = new Stack(env)
    stack.entries([{ tip: a, title: "A" }, { tip: b, title: "B" }, { tip: "@" }])
    let out = await stack.tryJjack("submit", ["-m", "unused"])
    expect(out.success, `submit should refuse:\n${out.text}`).toBe(false)
    expect(out.flat).toContain("3 problems")
    expect(out.flat).toContain("`Pull Request:` line")
    // Departure 12: the message names `jjack submit -r`
    expect(out.flat).toContain(
      "A change is submitted with a stack file or with `Pull Request:` lines (`jjack submit -r`), not both.",
    )
    expect(out.flat).toContain("relative to the working copy")
    nothingPushed(env, [], [])

    // A conflict, after a rebase onto a main that changed README too.
    stack.entries([{ tip: a, title: "A" }])
    await env.pushToMain("README", "edited on main\n")
    await env.jj(["git", "fetch"])
    await env.jj(["rebase", "-s", a, "-d", "main@origin"])
    out = await stack.tryJjack("submit", ["-m", "unused"])
    expect(out.success, `submit should refuse:\n${out.text}`).toBe(false)
    expect(out.flat).toContain("have conflicts")
    nothingPushed(env, [], [])
  })

  it("submit_refuses_a_merged_pull_request", async ({ expect }) => {
    await using env = await TestEnv.create()
    const [stack, groups, prs] = await submitted(env)
    env.gh.mergeOnGithub(prs[0])
    const before = heads(env, prs.slice(1))
    const stacksBefore = env.activeStacks()
    const out = await stack.tryJjack("submit", ["-m", "before sync"])
    expect(out.success, `submit should refuse:\n${out.text}`).toBe(false)
    expect(out.flat).toContain("jjack sync")
    // From diff_refuses_until_merged_changes_are_synced, in the stack file's
    // wording
    expect(out.flat).toContain(`#${prs[0]}, has merged`)
    expect(heads(env, prs.slice(1)), "nothing may be pushed").toEqual(before)
    expect(env.activeStacks(), "the stack must be kept").toEqual(stacksBefore)

    await stack.jjack("sync")
    await stack.jjack("submit", ["-m", "after sync"])
    await env.checkPr(prs[1], "main", ["b1.txt", "b2.txt", "b3.txt"], groups[1][2])
    await env.checkPr(prs[2], env.pr(prs[1]).headRef, ["c.txt"], groups[2][0])
    expect(env.activeStacks()).toContainEqual([prs[1], prs[2]])
  })

  it("status_shows_no_action_that_a_problem_makes_meaningless", async ({ expect }) => {
    {
      await using env = await TestEnv.create()
      const [stack, , prs] = await submitted(env)

      // Below a pull request merged outside jjack.
      env.gh.mergeOnGithub(prs[0])
      const json = await stack.statusJson()
      for (let i = 0; i < 3; i++) {
        expect(json.entries[i].actions, JSON.stringify(json, null, 2)).toBeUndefined()
      }
      const out = await stack.status()
      expect(out.text).not.toContain("Submit would")
      expect(out.flat).toContain("has 1 problem.")
    }

    // Tips out of line.
    await using env = await TestEnv.create()
    const [stack] = await submitted(env)
    const file = stack.read()
    ;[file.prs[0], file.prs[1]] = [file.prs[1], file.prs[0]]
    stack.write(file)
    const json = await stack.statusJson()
    for (let i = 1; i < 3; i++) {
      expect(json.entries[i].actions, JSON.stringify(json, null, 2)).toBeUndefined()
    }
  })

  it("submit_refuses_a_closed_pull_request", async ({ expect }) => {
    await using env = await TestEnv.create()
    const [stack, , prs] = await submitted(env)
    env.gh.closeOnGithub(prs[1])
    const before = heads(env, prs)
    const out = await stack.tryJjack("submit", ["-m", "unused"])
    expect(out.success, `submit should refuse:\n${out.text}`).toBe(false)
    expect(out.flat).toContain("is closed")
    nothingPushed(env, prs, before)
  })

  it("submit_refuses_a_stacked_pull_request_without_an_entry", async ({ expect }) => {
    await using env = await TestEnv.create()
    const [stack, , prs] = await submitted(env)
    const before = heads(env, prs)
    const file = stack.read()
    file.prs.splice(1, 1)
    stack.write(file)
    const out = await stack.tryJjack("submit", ["-m", "unused"])
    expect(out.success, `submit should refuse:\n${out.text}`).toBe(false)
    expect(out.flat).toContain(`#${prs[1]}, which is not`)
    expect(out.flat).toContain("jjack close")
    nothingPushed(env, prs, before)
  })

  it("submit_adds_an_entry_in_the_middle", async ({ expect }) => {
    // B starts out as part of C's pull request, then gets its own.
    await using env = await TestEnv.create()
    const a = await change(env, "a")
    const b = await change(env, "b")
    const c = await change(env, "c")
    const stack = new Stack(env)
    stack.entries([
      { tip: a, title: "A" },
      { tip: c, title: "C" },
    ])
    await stack.jjack("submit", ["-m", "unused"])
    const first = stack.prs()
    await env.checkPr(first[1], env.pr(first[0]).headRef, ["b.txt", "c.txt"], c)
    const before = heads(env, first)
    const main = env.branch("main")!

    stack.entries([stack.entry(0), { tip: b, title: "B" }, stack.entry(1)])
    const out = await stack.jjack("submit", ["-m", "split off B"])
    // From insert_in_middle: GitHub refuses a base change in a stack
    expect(out.text).toContain("Dissolving GitHub stack")
    const prs = stack.prs()
    expect([prs[0], prs[2]], "existing pull requests keep their numbers").toEqual([
      first[0],
      first[1],
    ])
    expect(env.headOf(prs[0]), "PR A changed").toBe(before[0])
    await env.checkPr(prs[1], env.pr(prs[0]).headRef, ["b.txt"], b)
    await env.checkPr(prs[2], env.pr(prs[1]).headRef, ["c.txt"], c)
    expect(env.isAncestor(before[1], env.headOf(prs[2])), "append-only").toBe(true)
    expect(env.activeStacks()).toEqual([prs])

    // From insert_a_pull_request_in_the_middle_and_land
    await stack.jjack("land")
    expect(env.landedSince(main)).toEqual(["A: a.txt", "B: b.txt", "C: c.txt"])
  })
})

describe.concurrent("adopt", () => {
  it("adopt_takes_over_a_stack_pushed_without_jj_spr", async ({ expect }) => {
    await using env = await TestEnv.create()
    const [stack, groups, prs] = await pushedWithoutJjack(env)
    const before = heads(env, prs)
    const remote = []
    for (const l of ["a", "b", "c"]) remote.push(await env.commitId(`feat-${l}@origin`))
    const stacks = env.stacks()
    const file = stack.read()

    let out = await env.jjack(["adopt", stack.path, "--dry-run"])
    expect(count(out.text, "Would adopt"), out.text).toBe(3)
    expect(out.flat).toContain("Would rewrite 5 changes")
    expect(stack.read()).toEqual(file)
    expect(await tracked(env, "feat-a")).toBe(true)

    out = await env.jjack(["adopt", stack.path])
    const text = out.flat
    expect(text).toContain("Rewrote 5 changes")
    expect(text).not.toContain("Stopped tracking")
    for (const [i, number] of prs.entries()) {
      const entry = stack.entry(i)
      const bookmark = ["feat-a", "feat-b", "feat-c"][i]
      expect(entry.pr, JSON.stringify(entry)).toBe(number)
      expect(entry.pushed).toBe(remote[i])
      expect(entry.synced).toMatch(/^sha256:/)
      expect(await tracked(env, bookmark), `${bookmark} is untracked`).toBe(false)
      expect(text).toContain(`Untracked ${bookmark}@origin`)
    }
    expect(text).toContain("match GitHub's")
    expect(text).toContain("body differs from GitHub's")
    expect(text).toContain("title differs from GitHub's")
    expect(heads(env, prs), "adopt changes nothing on GitHub").toEqual(before)
    expect(env.stacks()).toEqual(stacks)

    // Again: nothing to do.
    const adopted = stack.read()
    await env.jjack(["adopt", stack.path])
    expect(stack.read()).toEqual(adopted)

    // Nothing changed locally: status and submit agree, and submit keeps
    // GitHub's title and body.
    let json = await stack.statusJson()
    expect(json.problems, JSON.stringify(json, null, 2)).toEqual([])
    for (let i = 0; i < 3; i++) {
      expect((await sincePushed(stack, i)).every((s) => s === "unchanged")).toBe(true)
    }
    out = await stack.jjack("submit", ["-m", "unused"])
    expect(count(out.text, "No update necessary"), out.text).toBe(3)
    expect(heads(env, prs)).toEqual(before)
    expect(env.stacks()).toEqual(stacks)
    expect(env.pr(prs[1]).body).toBe("What b does.")
    expect(env.pr(prs[2]).title).toBe("Title of C")

    // An edit to a lower change: one commit on A's branch, a merge in each
    // branch above, no force push, and the same GitHub stack.
    await env.jj(["edit", live(groups[0][1])])
    writeFileSync(join(env.work, "a2.txt"), "a2, revised\n")
    await env.jj(["new", "feat-c"])
    await stack.jjack("submit", ["-m", "revise a2"])
    expect(env.prCommits(prs[0]).at(-1)).toBe("revise a2")
    for (const [i, number] of prs.entries()) {
      const expected = i === 0 ? before[0] : `${before[i]} ${env.headOf(prs[i - 1])}`
      expect(parents(env, env.headOf(number)), `#${number}`).toBe(expected)
      const tip = ["feat-a", "feat-b", "feat-c"][i]
      expect(env.treeOfPr(number), `#${number}`).toBe(await env.treeOf(tip))
      expect(stack.entry(i).pushed).toBe(await env.commitId(tip))
    }
    expect(env.stacks()).toEqual(stacks)
    json = await stack.statusJson()
    expect(json.problems, JSON.stringify(json, null, 2)).toEqual([])

    // Land and sync.
    const main = env.branch("main")!
    await stack.jjack("land", ["--no-sync"])
    expect(mainCommits(env, main).map(([s]) => s)).toEqual([
      "Title of A",
      "Title of B",
      "Title of C",
    ])
    env.remoteGit(["cat-file", "-e", "main:a2.txt"])
    await stack.jjack("sync")
    for (let i = 0; i < 3; i++) {
      expect(stack.entry(i).merged, JSON.stringify(stack.entry(i))).toBe(true)
    }
    for (const c of groups.flat()) {
      expect(await env.isVisible(live(c)), `${c} should be abandoned`).toBe(false)
    }
  })

  it("adopt_leaves_entries_without_an_open_pull_request_alone", async ({ expect }) => {
    await using env = await TestEnv.create()
    const a = await change(env, "a")
    await env.jj(["git", "push", "--named", `feat-a=${a}`])
    const closed = env.gh.openPrOutsideJjack("feat-a", "main", "A")
    env.gh.closeOnGithub(closed)
    const b = await change(env, "b")
    await env.jj(["git", "push", "--named", `feat-b=${b}`])
    const c = await change(env, "c")
    const stack = new Stack(env)
    stack.entries([
      { tip: "feat-a", title: "A" },
      { tip: "feat-b", title: "B" },
      { tip: c, title: "C" },
    ])
    const file = stack.read()

    const out = await env.jjack(["adopt", stack.path])
    const text = out.flat
    expect(text).toContain(`#${closed}`)
    expect(text).toContain("is closed")
    expect(text).toContain("No pull request has feat-b")
    expect(text).toContain("not a local bookmark")
    expect(stack.read()).toEqual(file)
    expect(await tracked(env, "feat-b")).toBe(true)

    // They get new pull requests on jjack's branches.
    await stack.jjack("submit", ["-m", "unused"])
    const prs = stack.prs()
    expect(prs).not.toContain(closed)
    expect(env.pr(prs[0]).headRef).toBe("spr/a")
    expect(env.pr(prs[1]).headRef).toBe("spr/b")
  })

  it("adopt_can_copy_the_title_and_body_from_github", async ({ expect }) => {
    await using env = await TestEnv.create()
    const [stack, , prs] = await pushedWithoutJjack(env)
    const headsBefore = heads(env, prs)
    await env.jjack(["adopt", stack.path, "--copy-github-text"])
    const read = (name: string) => readFileSync(join(stack.dir, name), "utf8")
    expect(read("a.md")).toBe("# Title of A\n\nWhat a does.\n")
    expect(read("b.md")).toBe("# Title of B\n\nWhat b does.\n")
    expect(read("c.md")).toBe("# Title of C\n\nWhat c does.\n")
    const json = await stack.statusJson()
    for (let i = 0; i < 3; i++) {
      expect(actionTexts(json, i), JSON.stringify(json, null, 2)).toEqual([])
    }

    // Edited in the file only: submit updates GitHub.
    stack.body("b.md", "# Title of B\n\nWhat b does, revised.\n")
    await stack.jjack("submit", ["-m", "unused"])
    expect(env.pr(prs[1]).body).toBe("What b does, revised.")
    expect(heads(env, prs)).toEqual(headsBefore)
  })

  it("close_an_adopted_entry_and_open_a_new_pull_request", async ({ expect }) => {
    await using env = await TestEnv.create()
    const [stack, groups, prs] = await pushedWithoutJjack(env)
    await env.jjack(["adopt", stack.path])
    await stack.jjack("close", ["--pr", "feat-c"])
    expect(env.pr(prs[2]).state).not.toBe("open")
    expect(env.branch("feat-c"), "close deletes the branch").toBeUndefined()
    const entry = stack.entry(2)
    for (const key of ["pr", "synced", "pushed"]) {
      expect(entry[key], JSON.stringify(entry)).toBeUndefined()
    }
    await stack.jjack("submit", ["-m", "unused"])
    const now = stack.prs()
    expect(now.slice(0, 2)).toEqual(prs.slice(0, 2))
    expect(env.pr(now[2]).headRef).toMatch(/^spr\//)
    expect(env.pr(now[2]).title).toBe("The file's title of C")
    await env.checkPr(now[2], "feat-b", ["c1.txt", "c2.txt"], live(groups[2][1]))
    expect(env.activeStacks()).toEqual([now])
  })

  it("land_part_of_an_adopted_stack_without_github_stacks_and_sync", async ({ expect }) => {
    // Without a GitHub stack, nothing rewrites the branches above the landed
    // pull request, so they keep the old versions of their changes, which jj
    // shows next to the live ones.
    await using env = await TestEnv.create({ stacks: false })
    const [stack, groups, prs] = await pushedWithoutJjack(env)
    await env.jjack(["adopt", stack.path])
    await env.jj(["edit", live(groups[0][1])])
    writeFileSync(join(env.work, "a2.txt"), "a2, revised\n")
    await env.jj(["new", "feat-c"])
    await stack.jjack("submit", ["-m", "revise a2"])

    await stack.jjack("land", ["--no-sync", "--upto", "feat-a"])
    expect(env.pr(prs[0]).mergedAt).not.toBeNull()
    await stack.jjack("sync")
    expect(stack.entry(0).merged).toBe(true)
    expect(await env.parentOf(`(${live(groups[1][0])})`)).toBe(
      await env.commitId("main@origin"),
    )
    await stack.jjack("submit", ["-m", "after landing A"])
    await env.checkPr(prs[1], "main", ["b1.txt"], "feat-b")
    await env.checkPr(prs[2], "feat-b", ["c1.txt", "c2.txt"], "feat-c")
    await stack.jjack("land", ["--no-sync"])
    await stack.jjack("sync")
    for (let i = 0; i < 3; i++) {
      expect(stack.entry(i).merged, JSON.stringify(stack.entry(i))).toBe(true)
    }
  })
})

describe.concurrent("land, sync, and close", () => {
  it("land_and_sync_a_whole_stack", async ({ expect }) => {
    await using env = await TestEnv.create()
    const [stack, groups, prs] = await submitted(env)
    const main = env.branch("main")!

    let out = await stack.jjack("land", ["--no-sync"])
    expect(out.flat).toContain(`Run \`jjack sync ${stack.path}\``)
    for (const number of prs) {
      expect(env.pr(number).mergedAt, `#${number} merged`).not.toBeNull()
    }
    expect((await stack.tryJjack("land")).flat).toContain(
      `#${prs[0]}, #${prs[1]}, #${prs[2]} merged already. Run \`jjack sync`,
    )
    const commits = mainCommits(env, main)
    expect(commits.map(([s]) => s)).toEqual(["Title of A", "Title of B", "Title of C"])
    expect(
      commits[1][1].startsWith("What B does.\n\nIn two paragraphs."),
      commits[1][1],
    ).toBe(true)
    expect(commits[1][1]).toContain(`pull/${prs[1]}`)

    out = await stack.jjack("sync")
    for (const c of groups.flat()) {
      expect(await env.isVisible(c), `${c} should be abandoned`).toBe(false)
    }
    const b = groups[1].map((c) => c.slice(0, 8))
    expect(out.flat).toContain(`Abandoned ${b.join(", ")} (#${prs[1]})`)
    // From sync_whole_stack_merged
    expect(out.text).toContain("Every change in this stack has merged")
    for (let i = 0; i < 3; i++) {
      expect(stack.entry(i).merged, JSON.stringify(stack.entry(i))).toBe(true)
    }
    out = await stack.jjack("submit")
    expect(out.text).toContain("Nothing to submit")
  })

  it("land_a_stack_file_in_one_merge_with_pull_request_defaults", async ({ expect }) => {
    await using env = await TestEnv.create()
    const [stack, groups, prs] = await submitted(env)
    const main = env.branch("main")!
    env.gh.squashMergeCommitTitle = "PR_TITLE"
    env.gh.squashMergeCommitMessage = "PR_BODY"
    const basesBefore = bases(env, prs)
    const branches = prs.map((n) => env.pr(n).headRef)

    const out = await stack.jjack("land", ["--no-sync"])
    expect(env.requestsSince(0, "PUT", "merge-async")).toHaveLength(1)
    // From land_a_stack_in_one_merge_with_pull_request_defaults: one merge of
    // the top, with GitHub's default message
    const merges = env.gh.requests.filter(
      (r) => r.method === "PUT" && r.path.endsWith("merge-async"),
    )
    expect(merges[0].path.endsWith(`pulls/${prs[2]}/merge-async`), merges[0].path).toBe(
      true,
    )
    const body = merges[0].body as Record<string, unknown>
    expect(body.commit_title).toBeUndefined()
    expect(body.commit_message).toBeUndefined()
    const commits = mainCommits(env, main)
    expect(commits.map(([s]) => s)).toEqual([
      `Title of A (#${prs[0]})`,
      `Title of B (#${prs[1]})`,
      `Title of C (#${prs[2]})`,
    ])
    expect(commits[1][1].trim()).toBe(env.pr(prs[1]).body.trim())
    expect(
      commits[1][1].startsWith("What B does.\n\nIn two paragraphs."),
      commits[1][1],
    ).toBe(true)
    expect(messagesOnMainSince(env, main)).toEqual(prs.map((n) => defaultMessage(env, n)))
    expect(out.flat).toContain(`Landed #${prs[0]}, #${prs[1]}, #${prs[2]}`)
    expect(out.flat).not.toContain("Waiting for GitHub")
    expect(out.flat).not.toContain(PULL_REQUEST_DEFAULTS_HINT)
    // GitHub merges the ones below without retargeting them.
    expect(env.pr(prs[1]).baseRef).toBe(basesBefore[1])
    expect(env.pr(prs[2]).baseRef).toBe(basesBefore[2])
    for (const branch of branches) {
      expect(env.branch(branch), `${branch} should be deleted`).toBeUndefined()
    }

    await stack.jjack("sync")
    for (const c of groups.flat()) {
      expect(await env.isVisible(c), `${c} should be abandoned`).toBe(false)
    }
    for (let i = 0; i < 3; i++) {
      expect(stack.entry(i).merged, JSON.stringify(stack.entry(i))).toBe(true)
    }
  })

  it("land_upto_then_sync_and_submit_the_rest", async ({ expect }) => {
    {
      await using env = await TestEnv.create()
      const [stack, groups, prs] = await submitted(env)
      const mergedBranches = prs.slice(0, 2).map((n) => env.pr(n).headRef)

      const land = await stack.jjack("land", ["--no-sync", "--upto", "b"])
      expect(env.pr(prs[0]).mergedAt).not.toBeNull()
      expect(env.pr(prs[1]).mergedAt).not.toBeNull()
      expect(env.pr(prs[2]).state).toBe("open")
      // From land_middle_merges_stack_below
      expect(
        env.requestsSince(0, "PUT", "merge-async"),
        "one stack merge per pull request",
      ).toHaveLength(2)
      expect(env.pr(prs[2]).baseRef, "the rest of the stack now targets main").toBe("main")
      for (const branch of mergedBranches) {
        expect(env.branch(branch), `${branch} should be deleted`).toBeUndefined()
      }
      expect(land.flat).toContain(`Run \`jjack sync ${stack.path}\``)

      // Before sync, submit sees the merged pull requests.
      const refused = await stack.tryJjack("submit", ["-m", "unused"])
      expect(refused.success, `submit should refuse:\n${refused.text}`).toBe(false)
      expect(refused.flat).toContain("jjack sync")

      const out = await stack.jjack("sync")
      expect(out.flat).toContain("jjack submit")
      expect(stack.entry(0).merged).toBe(true)
      expect(stack.entry(1).merged).toBe(true)
      expect(stack.entry(2).merged).toBeUndefined()
      expect(await env.parentOf(groups[2][0])).toBe(await env.commitId("main@origin"))
      // From sync_after_merging_part_of_stack
      for (const c of [...groups[0], ...groups[1]]) {
        expect(await env.isVisible(c), `${c} should be abandoned`).toBe(false)
      }

      await stack.jjack("submit", ["-m", "after landing"])
      await env.checkPr(prs[2], "main", ["c.txt"], groups[2][0])
      await stack.jjack("land")
      expect(env.pr(prs[2]).mergedAt).not.toBeNull()
    }

    // The bottom alone (land_bottom and sync_after_land), and the step
    // commits of B after GitHub's rebase (multi_change.rs
    // steps_survive_github_rebase_after_a_stacked_merge).
    await using env = await TestEnv.create()
    const [stack, groups, prs] = await submitted(env)
    const bottomBranch = env.pr(prs[0]).headRef

    const land = await stack.jjack("land", ["--no-sync", "--upto", groups[0][0]])
    expect(env.pr(prs[0]).mergedAt, "bottom PR was not merged").not.toBeNull()
    expect(env.requestsSince(0, "PUT", "merge-async"), "a stack merge").toHaveLength(1)
    for (const n of prs.slice(1)) {
      const pr = env.pr(n)
      expect(pr.state, `PR #${n} was closed: ${pr.closedReason}`).toBe("open")
    }
    expect(env.pr(prs[1]).baseRef, "next PR should now target main").toBe("main")
    expect(env.branch(bottomBranch), "landed branch should be deleted").toBeUndefined()
    expect(land.flat).toContain("jjack sync")
    expect(env.prCommits(prs[1]), "GitHub replays the steps").toEqual([
      "Change b1",
      "Change b2",
      "Change b3",
    ])

    const out = await stack.jjack("sync")
    expect(await env.isVisible(groups[0][0]), "landed change should be abandoned").toBe(
      false,
    )
    await expectRebasedOntoMain(expect, env, [...groups[1], ...groups[2]])
    expect(out.flat).toContain("jjack submit")
    expect(stack.entry(0).merged).toBe(true)

    const resubmit = await stack.jjack("submit", ["-m", "after sync"])
    expect(resubmit.text).toContain("No update necessary")
    await env.checkPr(prs[1], "main", ["b1.txt", "b2.txt", "b3.txt"], groups[1][2])
    await env.checkPr(prs[2], env.pr(prs[1]).headRef, ["c.txt"], groups[2][0])
    expect(env.activeStacks()).toContainEqual([prs[1], prs[2]])
  })

  it("land_refuses_a_stack_that_differs_from_the_file", async ({ expect }) => {
    await using env = await TestEnv.create()
    const [stack, , prs] = await submitted(env)
    const file = stack.read()
    file.prs.splice(1, 1)
    stack.write(file)
    const out = await stack.tryJjack("land")
    expect(out.success, `land should refuse:\n${out.text}`).toBe(false)
    expect(out.flat).toContain("jjack submit")
    for (const number of prs) {
      expect(env.pr(number).state, `#${number} stays open`).toBe("open")
    }
  })

  it("land_without_github_stacks_lands_one_at_a_time", async ({ expect }) => {
    await using env = await TestEnv.create({ stacks: false })
    const [stack, , prs] = await submitted(env)
    const main = env.branch("main")!
    await stack.jjack("land")
    for (const number of prs) {
      expect(env.pr(number).mergedAt, `#${number} merged`).not.toBeNull()
    }
    expect(mainCommits(env, main).map(([s]) => s)).toEqual([
      "Title of A",
      "Title of B",
      "Title of C",
    ])
  })

  it("close_one_entry_then_drop_it", async ({ expect }) => {
    await using env = await TestEnv.create()
    const [stack, groups, prs] = await submitted(env)
    const main = env.branch("main")!
    const bBranch = env.pr(prs[1]).headRef
    const cHead = env.headOf(prs[2])

    const out = await stack.jjack("close", ["--pr", "b"])
    expect(out.flat).toContain(`Run \`jjack submit ${stack.path}\` to restack it`)
    // From close_keeps_dependents and remove_a_pull_request_from_the_middle_and_land
    expect(out.flat).toContain(`because #${prs[2]} still targets it`)
    expect(env.pr(prs[1]).state).not.toBe("open")
    expect(env.branch(bBranch), "C still targets B's branch").toBeDefined()
    expect([...env.stacks().values()][0], "B stays listed").toEqual(prs)
    expect(stack.entry(1)).toEqual({ tip: "b", body: "b.md", "x-note": "kept" })
    expect(env.pr(prs[0]).state).toBe("open")
    expect(env.pr(prs[2]).state).toBe("open")

    // Drop B: its entry and its changes.
    const file = stack.read()
    file.prs.splice(1, 1)
    stack.write(file)
    await env.jj(["abandon", `${groups[1][0]}::${groups[1][2]}`])
    await stack.jjack("submit", ["-m", "drop B"])
    expect(stack.prs()).toEqual([prs[0], prs[2]])
    await env.checkPr(prs[2], env.pr(prs[0]).headRef, ["c.txt"], groups[2][0])
    expect(env.activeStacks()).toEqual([[prs[0], prs[2]]])
    expect(
      env.isAncestor(cHead, env.headOf(prs[2])),
      "C's update should be a fast-forward",
    ).toBe(true)
    await stack.jjack("land")
    expect(env.landedSince(main)).toEqual(["Title of A: a.txt", "Title of C: c.txt"])
  })

  it("close_an_entry_and_open_a_new_pull_request", async ({ expect }) => {
    await using env = await TestEnv.create()
    const [stack, groups, prs] = await submitted(env)
    await stack.jjack("close", ["--pr", "b"])
    await stack.jjack("submit", ["-m", "reopen B"])
    const now = stack.prs()
    expect([now[0], now[2]]).toEqual([prs[0], prs[2]])
    expect(prs, "B gets a new pull request").not.toContain(now[1])
    await env.checkPr(
      now[1],
      env.pr(now[0]).headRef,
      ["b1.txt", "b2.txt", "b3.txt"],
      groups[1][2],
    )
    await env.checkPr(now[2], env.pr(now[1]).headRef, ["c.txt"], groups[2][0])
    expect(env.activeStacks()).toEqual([now])
  })

  it("close_the_top_entry_and_open_a_new_pull_request", async ({ expect }) => {
    // GitHub keeps the closed pull request at the top of the stack, and
    // chains a pull request added to the stack from it, so the stack has to
    // be rebuilt.
    await using env = await TestEnv.create()
    const [stack, groups, prs] = await submitted(env)
    const c = groups[2][0]
    const old = [...env.stacks().keys()]
    await stack.jjack("close", ["--pr", c])
    const out = await stack.jjack("submit", ["-m", "reopen C"])
    expect(out.text).not.toContain("failed")
    const now = stack.prs()
    expect(now.slice(0, 2)).toEqual(prs.slice(0, 2))
    expect(prs, "C gets a new pull request").not.toContain(now[2])
    await env.checkPr(now[2], env.pr(now[1]).headRef, ["c.txt"], c)
    expect(env.activeStacks()).toEqual([now])
    // From close_the_top_pull_request_and_open_a_new_one
    const stacks = [...env.stacks().keys()]
    expect(
      stacks.every((s) => !old.includes(s)),
      `the old stack is dissolved: ${stacks}`,
    ).toBe(true)
  })

  it("close_every_entry", async ({ expect }) => {
    await using env = await TestEnv.create()
    const [stack, , prs] = await submitted(env)
    const out = await stack.tryJjack("close")
    expect(out.success, `close needs --pr or --all:\n${out.text}`).toBe(false)

    await stack.jjack("close", ["--all"])
    for (const [i, number] of prs.entries()) {
      expect(env.pr(number).state, `#${number} closed`).not.toBe("open")
      const entry = stack.entry(i)
      for (const key of ["pr", "synced", "pushed"]) {
        expect(entry[key], JSON.stringify(entry)).toBeUndefined()
      }
    }
    expect([...env.gh.branches().keys()].some((b) => b.startsWith("spr/"))).toBe(false)
  })

  it("reorder_entries_then_submit_and_land", async ({ expect }) => {
    // A, B, C, then A, C, B: locally and in the file.
    await using env = await TestEnv.create()
    const [stack, groups, prs] = await submitted(env)
    const main = env.branch("main")!
    await env.jj(["rebase", "-r", groups[2][0], "-d", groups[0][0]])
    await env.jj(["rebase", "-s", groups[1][0], "-d", groups[2][0]])
    const file = stack.read()
    ;[file.prs[1], file.prs[2]] = [file.prs[2], file.prs[1]]
    stack.write(file)

    const out = await stack.jjack("submit", ["-m", "reorder"])
    // From reorder
    expect(out.text).toContain("Dissolving GitHub stack")
    expect(stack.prs(), "Pull requests keep their numbers").toEqual([
      prs[0],
      prs[2],
      prs[1],
    ])
    await env.checkPr(prs[0], "main", ["a.txt"], groups[0][0])
    await env.checkPr(prs[2], env.pr(prs[0]).headRef, ["c.txt"], groups[2][0])
    await env.checkPr(
      prs[1],
      env.pr(prs[2]).headRef,
      ["b1.txt", "b2.txt", "b3.txt"],
      groups[1][2],
    )
    expect(env.activeStacks()).toEqual([[prs[0], prs[2], prs[1]]])

    await stack.jjack("land", ["--no-sync"])
    for (const number of prs) {
      expect(env.pr(number).mergedAt, `#${number} merged`).not.toBeNull()
    }
    expect(mainCommits(env, main).map(([s]) => s)).toEqual([
      "Title of A",
      "Title of C",
      "Title of B",
    ])
    for (const f of ["a.txt", "b1.txt", "b2.txt", "b3.txt", "c.txt"]) {
      env.remoteGit(["cat-file", "-e", `main:${f}`])
    }
    await stack.jjack("sync")
    for (let i = 0; i < 3; i++) {
      expect(stack.entry(i).merged, JSON.stringify(stack.entry(i))).toBe(true)
    }
  })
})
