// Scenario tests of `jjack land` on a stack file: the merge messages, the
// repository's squash defaults, refusals, branch cleanup, and waiting for
// GitHub. A port of the land tests of `tests/native_stacks.rs` from
// papertigers/jj-spr's `native-stacks` branch, through a stack file where
// those used `jj spr diff` and `land -r`.

import { chmod, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, it } from "vitest"
import { checkChain, TestEnv } from "./env.ts"
import { fileStack, heads, Stack } from "./stack.ts"

const PULL_REQUEST_DEFAULTS_HINT =
  "Setting the repository's default squash commit message to the pull request title " +
  "and description lets jjack land a stack in one merge."

/** The messages of the commits on main after `since`, oldest first */
function messagesOnMainSince(env: TestEnv, since: string): string[] {
  return env
    .remoteGit(["log", "--reverse", "--format=%B%x00", `${since}..main`])
    .split("\0")
    .map((m) => m.trim())
    .filter(Boolean)
}

/** A stack file with one entry per change, titled `titles[i]`, without body
 * files, submitted */
async function submitChanges(
  env: TestEnv,
  changes: string[],
  titles: string[],
  args = ["-m", "initial"],
): Promise<{ stack: Stack; prs: number[] }> {
  const stack = new Stack(env)
  stack.entries(changes.map((tip, i) => ({ tip, title: titles[i] })))
  await stack.jjack("submit", args)
  return { stack, prs: stack.prs() }
}

/** One change per name, "Change A" adding `a.txt` for "a", and a stack file
 * whose entries have a body file each, "# Change A\n\nWhat a does.", submitted */
async function stackWithBodies(
  env: TestEnv,
  names: string[],
): Promise<{ stack: Stack; changes: string[]; prs: number[] }> {
  const stack = new Stack(env)
  const changes = []
  for (const name of names) {
    const title = `Change ${name.toUpperCase()}`
    changes.push(await env.commit(title, `${name}.txt`, `${name}\n`))
    stack.body(`${name}.md`, `# ${title}\n\nWhat ${name} does.\n`)
  }
  stack.entries(changes.map((tip, i) => ({ tip, body: `${names[i]}.md` })))
  await stack.jjack("submit", ["-m", "initial"])
  return { stack, changes, prs: stack.prs() }
}

/** Set the repository's squash defaults to the pull request's title and body,
 * and build a stack of changes with a body each */
function stackWithPullRequestDefaults(env: TestEnv, names: string[]) {
  env.gh.squashMergeCommitTitle = "PR_TITLE"
  env.gh.squashMergeCommitMessage = "PR_BODY"
  return stackWithBodies(env, names)
}

/** GitHub's default squash message under `PR_TITLE` and `PR_BODY` */
function defaultMessage(env: TestEnv, number: number): string {
  const pr = env.pr(number)
  if (!pr.body.includes(" does.")) throw new Error(`unexpected body: ${pr.body}`)
  return `${pr.title} (#${number})\n\n${pr.body.trim()}`
}

const noneMerged = (env: TestEnv) => [...env.gh.prs.values()].every((pr) => !pr.mergedAt)

describe.concurrent("land", () => {
  it("land_syncs_a_whole_stack", async ({ expect }) => {
    await using env = await TestEnv.create()
    const { stack, changes, prs } = await fileStack(env, ["a", "b", "c"])

    const out = await stack.jjack("land", ["--json"])
    for (const change of changes) expect(await env.isVisible(change)).toBe(false)
    for (let i = 0; i < 3; i++) expect(stack.entry(i).merged).toBe(true)
    expect(out.text).toContain("Every change in this stack has merged")
    expect(out.text, "no hint to sync once it ran").not.toContain("Run `jjack sync")
    const { result } = JSON.parse(out.stdout)
    expect(result).toMatchObject({
      landed: prs,
      notLanded: [],
      commit: env.branch("main"),
      sync: {
        abandoned: prs,
        markedMerged: prs,
        remaining: [],
        rebased: false,
        movedWorkingCopy: true,
      },
      syncError: null,
    })
    // The empty working copy that sat on the stack moved onto the new main
    expect(await env.parentOf("@")).toBe(await env.commitId("main@origin"))
    expect(out.text).toContain("Moved the empty working copy onto main@origin")
  })

  it("land_leaves_a_working_copy_with_edits_or_a_description", async ({ expect }) => {
    for (const work of [
      (env: TestEnv) => writeFile(join(env.work, "notes.txt"), "notes\n"),
      (env: TestEnv) => env.jj(["describe", "-m", "Next thing"]),
    ]) {
      await using env = await TestEnv.create()
      const { stack } = await fileStack(env, ["a", "b"])
      const oldMain = await env.commitId("main@origin")
      await work(env)

      const out = await stack.jjack("land", ["--json"])
      expect(JSON.parse(out.stdout).result.sync.movedWorkingCopy).toBe(false)
      // Where jj put it: on the parent of the abandoned changes
      expect(await env.parentOf("@")).toBe(oldMain)
    }
  })

  it("land_upto_syncs_and_leaves_the_rest_ready_to_submit", async ({ expect }) => {
    await using env = await TestEnv.create()
    const { stack, changes, prs } = await fileStack(env, ["a", "b", "c"])

    const out = await stack.jjack("land", ["--upto", changes[0], "--json"])
    expect(await env.isVisible(changes[0])).toBe(false)
    expect(stack.entry(0).merged).toBe(true)
    expect(await env.parentOf(changes[1])).toBe(await env.commitId("main@origin"))
    expect(JSON.parse(out.stdout).result.sync).toMatchObject({
      abandoned: [prs[0]],
      rebased: true,
      markedMerged: [prs[0]],
      remaining: prs.slice(1),
    })

    // GitHub rebased the rest as the sync did, so submit has nothing to push
    const before = heads(env, prs.slice(1))
    const submit = await stack.jjack("submit")
    expect(submit.text.split("No update necessary").length - 1, submit.text).toBe(2)
    expect(heads(env, prs.slice(1))).toEqual(before)
    await checkChain(env, changes.slice(1), prs.slice(1))
  })

  it("a_sync_that_refuses_after_a_land_is_a_warning", async ({ expect }) => {
    // A's local change has an edit that was never submitted, so what merged
    // lacks it and the sync refuses to abandon it. The landing still worked.
    await using env = await TestEnv.create()
    const { stack, changes, prs } = await fileStack(env, ["a", "b"])
    await writeFile(join(env.work, "a.txt"), "a, edited locally\n")
    await env.jj(["squash", "--into", changes[0]])

    const out = await stack.tryJjack("land", ["--upto", changes[0], "--json"])
    expect(out.code, out.text).toBe(0)
    expect(env.pr(prs[0]).mergedAt, "A should be merged").not.toBeNull()
    expect(await env.isVisible(changes[0]), "the sync abandons nothing").toBe(true)
    const json = JSON.parse(out.stdout)
    expect(json).toMatchObject({
      ok: true,
      result: {
        landed: [prs[0]],
        sync: null,
        syncError: { code: "local_differs_from_merged", fix: [`jjack sync ${stack.path}`] },
      },
    })
    // The sync's line about A, then the land's about the sync
    expect(json.warnings).toHaveLength(2)
    expect(json.warnings[0]).toContain(`#${prs[0]} merged, but the local change has edits`)
    expect(json.warnings[1]).toContain(`Run \`jjack sync ${stack.path}\``)
    expect(json.warnings[1]).toContain("the local version differs from what merged")
  })

  it("land_top_gives_every_pull_request_its_message", async ({ expect }) => {
    // With body files, so that the message has the body before the
    // `Pull Request:` line, without jj-spr's `Reviewers:` lines
    await using env = await TestEnv.create()
    const { stack, prs } = await stackWithBodies(env, ["a", "b", "c"])
    const main = env.branch("main")!

    const out = await stack.jjack("land")
    const landed = (number: number, title: string, body: string) =>
      `${title}\n\n${body}\n\nPull Request: https://github.com/fake/repo/pull/${number}`
    expect(messagesOnMainSince(env, main)).toEqual([
      landed(prs[0], "Change A", "What a does."),
      landed(prs[1], "Change B", "What b does."),
      landed(prs[2], "Change C", "What c does."),
    ])
    expect(out.flat).toContain(PULL_REQUEST_DEFAULTS_HINT)
  })

  it("land_the_bottom_alone_with_pull_request_defaults", async ({ expect }) => {
    await using env = await TestEnv.create()
    const { stack, changes, prs } = await stackWithPullRequestDefaults(env, ["a", "b"])
    const main = env.branch("main")!

    await stack.jjack("land", ["--upto", changes[0]])
    const merge = env.gh.requests.find(
      (r) => r.method === "PUT" && r.path.endsWith("merge-async"),
    )
    expect(merge, "a stack merge").toBeDefined()
    expect(merge!.body, JSON.stringify(merge!.body)).not.toHaveProperty("commit_title")
    expect(messagesOnMainSince(env, main)).toEqual([defaultMessage(env, prs[0])])
    expect(env.pr(prs[1]).state).toBe("open")
    expect(env.pr(prs[1]).baseRef).toBe("main")
  })

  it("land_one_at_a_time_when_the_squash_defaults_cannot_be_read", async ({ expect }) => {
    await using env = await TestEnv.create()
    const { stack, prs } = await stackWithPullRequestDefaults(env, ["a", "b"])
    const main = env.branch("main")!
    env.gh.failingQueries.push("RepositorySquashDefaultsQuery")

    const out = await stack.jjack("land")
    expect(out.flat).toContain(PULL_REQUEST_DEFAULTS_HINT)
    expect(env.requestsSince(0, "PUT", "merge-async")).toHaveLength(2)
    const messages = messagesOnMainSince(env, main)
    expect(
      messages[0].startsWith("Change A\n\nWhat a does."),
      messages.join("\n--\n"),
    ).toBe(true)
    expect(messages[1].endsWith(`pull/${prs[1]}`), messages.join("\n--\n")).toBe(true)
  })

  it("land_middle_checks_stack_below", async ({ expect }) => {
    // Landing the whole file lands B, and with it A below it, which is a draft
    await using env = await TestEnv.create()
    const { stack, prs } = await fileStack(env, ["a", "b"])
    env.gh.prs.get(prs[0])!.draft = true

    const out = await stack.tryJjack("land")
    expect(out.success, `land should refuse:\n${out.text}`).toBe(false)
    expect(out.flat).toContain(`#${prs[0]} is a draft`)
    expect(noneMerged(env), "nothing should merge").toBe(true)
  })

  it("land_refuses_draft", async ({ expect }) => {
    for (const stacks of [true, false]) {
      await using env = await TestEnv.create({ stacks })
      const changes = [
        await env.commit("Change A", "a.txt", "a\n"),
        await env.commit("Change B", "b.txt", "b\n"),
      ]
      const { stack, prs } = await submitChanges(
        env,
        changes,
        ["Change A", "Change B"],
        ["--draft"],
      )
      const requests = env.requestCount()

      const out = await stack.tryJjack("land", ["--upto", changes[0]])
      expect(out.success, `land should refuse a draft:\n${out.text}`).toBe(false)
      expect(out.flat).toContain(`#${prs[0]} is a draft`)
      expect(
        env.requestsSince(requests, "PUT", "merge"),
        "no merge should be attempted",
      ).toEqual([])
      expect(env.pr(prs[0]).state).toBe("open")
    }
  })

  it("land_refuses_a_chained_pull_request_without_a_stack", async ({ expect }) => {
    // Without GitHub stacks, B targets A's branch. A file without A's entry
    // lands B alone, which would merge both as one commit.
    await using env = await TestEnv.create({ stacks: false })
    const { stack, changes, prs } = await fileStack(env, ["a", "b"])
    const bases = prs.map((n) => env.pr(n).baseRef)
    const file = stack.read()
    stack.write({ ...file, prs: file.prs.slice(1) })

    const out = await stack.tryJjack("land")
    expect(out.success, `land should refuse:\n${out.text}`).toBe(false)
    expect(out.flat).toContain(`Land #${prs[0]} first`)
    expect(noneMerged(env), "nothing should merge").toBe(true)
    expect(
      prs.map((n) => env.pr(n).baseRef),
      "bases must be unchanged",
    ).toEqual(bases)

    // Following the advice lands each as its own commit
    stack.write(file)
    const main = env.branch("main")!
    const landed = await stack.jjack("land", ["--no-sync", "--upto", changes[0]])
    expect(landed.flat).toContain(`#${prs[1]} now targets main`)
    await stack.jjack("sync")
    await stack.jjack("land")
    expect(env.landedSince(main)).toEqual(["Change A: a.txt", "Change B: b.txt"])
  })

  it("land_reports_branch_it_could_not_delete", async ({ expect }) => {
    await using env = await TestEnv.create()
    const { stack, changes, prs } = await fileStack(env, ["a", "b"])
    const branch = env.pr(prs[0]).headRef
    const hook = join(env.root, "remote.git/hooks/pre-receive")
    await writeFile(
      hook,
      '#!/bin/sh\nwhile read old new ref; do\n  case $new in 0000000000000000000000000000000000000000)\n    echo "deletion of $ref denied" >&2; exit 1;;\n  esac\ndone\n',
    )
    await chmod(hook, 0o755)

    const out = await stack.jjack("land", ["--upto", changes[0]])
    expect(out.flat).toContain(`Could not delete branch ${branch}`)
    expect(out.flat, "git's reason should be shown").toContain("denied")
    expect(env.branch(branch)).toBeDefined()
  })

  it("land_keeps_branches_when_open_pull_requests_cannot_be_listed", async ({ expect }) => {
    // Without a stack nothing but jjack's cleanup moves B off A's branch, and
    // deleting that branch would close B
    await using env = await TestEnv.create({ stacks: false })
    const { stack, changes, prs } = await fileStack(env, ["a", "b"])
    const branch = env.pr(prs[0]).headRef
    env.gh.failingQueries.push("OpenPullRequestBranchesQuery")

    const out = await stack.jjack("land", ["--upto", changes[0]])
    expect(env.pr(prs[0]).mergedAt, "A should be merged").not.toBeNull()
    expect(out.flat).toContain("Could not list the open pull requests")
    expect(out.flat).toContain(branch)
    expect(env.branch(branch), "A's branch was deleted").toBeDefined()
    const dependent = env.pr(prs[1])
    expect(dependent.state, `B was closed: ${dependent.closedReason}`).toBe("open")
  })

  it("land_waits_for_github_to_compute_mergeability", async ({ expect }) => {
    await using env = await TestEnv.create()
    const { stack, changes, prs } = await fileStack(env, ["a", "b"])
    env.gh.unknownMergeabilityPolls = 30

    const out = await stack.jjack("land", ["--upto", changes[0]])
    expect(out.flat).toContain("Waiting for GitHub")
    expect(env.pr(prs[0]).mergedAt, "A should be merged").not.toBeNull()
  })

  it("land_gives_up_when_github_does_not_compute_mergeability", async ({ expect }) => {
    await using env = await TestEnv.create()
    const { stack, changes, prs } = await fileStack(env, ["a", "b"])
    env.gh.unknownMergeabilityPolls = 2 ** 32 - 1

    const out = await stack.tryJjack("land", ["--upto", changes[0]])
    expect(out.success, `land should give up:\n${out.text}`).toBe(false)
    expect(out.flat).toContain("GitHub has not finished computing whether")
    expect(env.pr(prs[0]).state).toBe("open")
  })

  it("land_waits_for_github_to_rebase_after_a_merge_below", async ({ expect }) => {
    // B changes the line A adds. After A merges, GitHub points B at main and
    // reports B's old head as conflicting with main until its rebase of B
    // lands.
    await using env = await TestEnv.create()
    const changes = [
      await env.commit("Change A", "f.txt", "a\n"),
      await env.commit("Change B", "f.txt", "b\n"),
    ]
    const { stack } = await submitChanges(env, changes, ["Change A", "Change B"])
    const main = env.branch("main")!
    env.gh.staleHeadPolls = 3

    await stack.jjack("land")
    expect(env.landedSince(main)).toEqual(["Change A: f.txt", "Change B: f.txt"])
    expect(env.remoteGit(["show", "main:f.txt"])).toBe("b")
  })

  it("land_stops_at_a_pull_request_github_blocks", async ({ expect }) => {
    await using env = await TestEnv.create()
    const { stack, prs } = await fileStack(env, ["a", "b", "c"])
    const main = env.branch("main")!
    env.gh.blocked.push(prs[1])

    const out = await stack.tryJjack("land")
    expect(out.success, `land should stop:\n${out.text}`).toBe(false)
    expect(out.flat).toContain(`Landed #${prs[0]}, but not #${prs[1]}, #${prs[2]}`)
    expect(out.flat).toContain(
      `Pull request #${prs[1]} can't be merged yet: GitHub is blocking it`,
    )
    expect(out.flat).toContain(`Run \`jjack sync ${stack.path}\``)
    expect(env.landedSince(main)).toEqual(["Change A: a.txt"])
    expect(env.branch(env.pr(prs[0]).headRef)).toBeUndefined()
  })

  it("land_stops_at_a_pull_request_github_closed", async ({ expect }) => {
    // A, B, C reordered to A, C, B and pushed the way older versions of jj-spr
    // did: C's branch, which has B's commit in it, gets a commit that takes
    // B's file out, and B's branch gets a merge with C's. After A merges,
    // GitHub's rebase finds no commits of B's own and closes B.
    await using env = await TestEnv.create()
    const { stack, changes, prs } = await fileStack(env, ["a", "b", "c"])
    const [bHead, cHead] = [env.headOf(prs[1]), env.headOf(prs[2])]
    await env.jj(["rebase", "-r", changes[1], "--insert-after", changes[2]])
    await env.jj(["new", changes[1]])
    const git = (args: string[]) => env.gitIn(env.work, args)
    const cUpdate = await git([
      "commit-tree",
      await env.treeOf(changes[2]),
      "-p",
      cHead,
      "-m",
      "reorder",
    ])
    const bUpdate = await git([
      "commit-tree",
      await env.treeOf(changes[1]),
      "-p",
      bHead,
      "-p",
      cUpdate,
      "-m",
      "reorder",
    ])
    const branches = prs.map((n) => env.pr(n).headRef)
    await env.pushCommit(cUpdate, branches[2])
    await env.pushCommit(bUpdate, branches[1])
    env.gh.stacks.clear()
    env.gh.prs.get(prs[2])!.baseRef = branches[0]
    env.gh.prs.get(prs[1])!.baseRef = branches[2]
    env.gh.stackOutsideJjack([prs[0], prs[2], prs[1]])
    const file = stack.read()
    stack.write({ ...file, prs: [file.prs[0], file.prs[2], file.prs[1]] })
    let main = env.branch("main")!

    const out = await stack.tryJjack("land")
    expect(out.success, `land should stop:\n${out.text}`).toBe(false)
    expect(out.flat).toContain(`Landed #${prs[0]}, #${prs[2]}, but not #${prs[1]}`)
    expect(out.flat).toContain(`Pull request #${prs[1]} was closed without being merged`)
    expect(out.flat).not.toContain("has not finished computing")
    expect(env.landedSince(main)).toEqual(["Change A: a.txt", "Change C: c.txt"])

    // The way out: sync, then a new pull request for B. Its old branch is
    // still on GitHub, so the new one gets another name.
    main = env.branch("main")!
    const synced = await stack.jjack("sync")
    expect(synced.flat).toContain(`#${prs[1]} was closed without merging; keeping it`)
    expect(await env.isVisible(changes[0])).toBe(false)
    expect(await env.isVisible(changes[2])).toBe(false)
    const refused = await stack.tryJjack("submit", ["-m", "reopen B"])
    expect(refused.success, `submit should refuse:\n${refused.text}`).toBe(false)
    expect(refused.flat).toContain(`#${prs[1]}, is closed`)
    stack.edit(2, { pr: undefined, synced: undefined })
    await stack.jjack("submit", ["-m", "reopen B"])
    const reopened = stack.entry(2).pr
    expect(reopened, "B gets a new pull request").not.toBe(prs[1])
    expect(env.pr(reopened).headRef).not.toBe(branches[1])
    await env.checkPr(reopened, "main", ["b.txt"], changes[1])
    await stack.jjack("land")
    expect(env.landedSince(main)).toEqual(["Change B: b.txt"])
  })

  it("land_refuses_when_github_requires_a_review", async ({ expect }) => {
    // Even with jjack.requireApproval off, GitHub itself refuses to merge a pull
    // request whose review decision is not satisfied: stop early
    await using env = await TestEnv.create()
    const { stack, changes, prs } = await fileStack(env, ["a", "b"])
    env.gh.review(prs[0], "bob", "CHANGES_REQUESTED")

    const out = await stack.tryJjack("land", ["--upto", changes[0]])
    expect(out.success, `land should refuse:\n${out.text}`).toBe(false)
    expect(out.flat).toContain(`#${prs[0]} has changes requested`)
    expect(env.pr(prs[0]).state).toBe("open")
  })

  it("land_needs_an_approval_when_the_repository_requires_one", async ({ expect }) => {
    await using env = await TestEnv.create()
    await env.jj(["config", "set", "--repo", "jjack.requireApproval", "true"])
    const a = await env.commit("Change A", "a.txt", "a\n")
    const { stack, prs } = await submitChanges(env, [a], ["Change A"], ["-m", "A"])
    const pr = prs[0]

    const out = await stack.tryJjack("land")
    expect(out.success, `land should refuse:\n${out.text}`).toBe(false)
    expect(out.flat).toContain(`#${pr} has not been approved`)
    expect(env.pr(pr).state).toBe("open")

    env.gh.review(pr, "bob", "APPROVED")
    await stack.jjack("land")
    expect(env.pr(pr).mergedAt, "A should be merged").not.toBeNull()
  })

  it("land_unstacked_checks_all_prs_before_merging_any", async ({ expect }) => {
    await using env = await TestEnv.create({ stacks: false })
    const { stack, prs } = await fileStack(env, ["a", "b"])
    env.gh.prs.get(prs[1])!.draft = true

    const out = await stack.tryJjack("land", ["--json"])
    expect(out.code, out.text).toBe(1)
    expect(JSON.parse(out.stdout).error).toMatchObject({ code: "draft", pr: prs[1] })
    expect(noneMerged(env), "PR #1 should not merge when PR #2 is a draft").toBe(true)
  })

  it("land_stops_immediately_if_pr_merges_while_waiting", async ({ expect }) => {
    await using env = await TestEnv.create()
    const { stack, prs } = await fileStack(env, ["a"])
    const { captureOut, land, openContext } = await import("../src/index.ts")
    let polls = 0
    const ctx = await openContext(env.work, {
      env: env.env,
      out: captureOut(),
      sleep: async () => {},
      fetch: async (input, init) => {
        const req = new Request(input, init)
        const body = await req.clone().text()
        if (body.includes("PullRequestMergeabilityQuery")) {
          polls++
          if (polls === 1) {
            env.gh.mergeOnGithub(prs[0])
            env.gh.unknownMergeabilityPolls = 100
          }
        }
        return env.gh.fetch(input, init)
      },
    })
    await expect(land(ctx, { file: stack.path })).rejects.toMatchObject({
      code: "merged",
      pr: prs[0],
      fix: [`jjack sync ${stack.path}`],
    })
    expect(polls, "must not poll until timeout").toBe(1)
  })

  it("land_after_resolving_a_conflict_with_the_change_below", async ({ expect }) => {
    // A changes line 1 of f.txt, B line 3, and C line 5. A is then amended to
    // change line 3 too, and the conflict in B resolved. After A merges,
    // GitHub cannot replay B onto main, so it rebases nothing, and B's pull
    // request conflicts with main until sync and submit merge main into it.
    await using env = await TestEnv.create()
    await env.pushToMain("f.txt", "1\n2\n3\n4\n5\n")
    await env.jj(["git", "fetch"])
    await env.jj(["new", "main@origin"])
    const changes = [
      await env.commit("Change A", "f.txt", "1 A\n2\n3\n4\n5\n"),
      await env.commit("Change B", "f.txt", "1 A\n2\n3 B\n4\n5\n"),
      await env.commit("Change C", "f.txt", "1 A\n2\n3 B\n4\n5 C\n"),
    ]
    const { stack, prs } = await submitChanges(env, changes, [
      "Change A",
      "Change B",
      "Change C",
    ])
    const main = env.branch("main")!
    await env.jj(["edit", changes[0]])
    await writeFile(join(env.work, "f.txt"), "1 A\n2\n3 A\n4\n5\n")
    await env.jj(["edit", changes[1]])
    await writeFile(join(env.work, "f.txt"), "1 A\n2\n3 A+B\n4\n5\n")
    await env.jj(["new", changes[2]])
    await stack.jjack("submit", ["-m", "amend A, resolve B"])
    await checkChain(env, changes, prs)
    const before = heads(env, prs.slice(1))
    const aBranch = env.pr(prs[0]).headRef

    const out = await stack.tryJjack("land")
    expect(out.success, `land should stop after A:\n${out.text}`).toBe(false)
    expect(out.flat).toContain(`Landed #${prs[0]}, but not #${prs[1]}, #${prs[2]}`)
    expect(out.flat).toContain(
      `Pull request #${prs[1]} conflicts with main after the merge below it`,
    )
    expect(out.flat).not.toContain("rebase your changes")
    expect(
      env.requestsSince(0, "PUT", `pulls/${prs[1]}/merge`),
      "land should not ask GitHub to merge a conflicting pull request",
    ).toEqual([])
    expect(env.pr(prs[0]).mergedAt, "A should be merged").not.toBeNull()
    expect(env.branch(aBranch), "the landed branch should be deleted").toBeUndefined()
    expect(heads(env, prs.slice(1)), "GitHub rebases nothing when B conflicts").toEqual(
      before,
    )
    expect(env.pr(prs[1]).baseRef).toBe("main")
    expect(env.pr(prs[2]).baseRef).toBe(env.pr(prs[1]).headRef)

    await stack.jjack("sync")
    await stack.jjack("submit", ["-m", "after sync"])
    await checkChain(env, changes.slice(1), prs.slice(1))
    await stack.jjack("land")
    expect(env.landedSince(main)).toEqual([
      "Change A: f.txt",
      "Change B: f.txt",
      "Change C: f.txt",
    ])
    expect(env.remoteGit(["show", "main:f.txt"])).toBe("1 A\n2\n3 A+B\n4\n5 C")
  })
})
