// Tests of the library: each command called as a function with a context on
// the fake GitHub, checking the result it returns or the error it throws.

import { chmodSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "vitest"
import {
  adopt,
  captureOut,
  close,
  init,
  JjackError,
  land,
  openContext,
  openLocalContext,
  resolveStack,
  snapshot,
  status,
  submit,
  sync,
  type Ctx,
} from "../src/index.ts"
import { TestEnv } from "./env.ts"
import { change, Stack, threeEntries } from "./stack.ts"

/** A context for the work clone, with its log captured */
function context(env: TestEnv): Promise<Ctx & { out: ReturnType<typeof captureOut> }> {
  const out = captureOut()
  return openContext(env.work, {
    env: env.env,
    fetch: env.gh.fetch,
    out,
    sleep: async () => {},
  }) as Promise<Ctx & { out: typeof out }>
}

/** The error a promise rejects with */
async function rejection(promise: Promise<unknown>): Promise<JjackError> {
  try {
    await promise
  } catch (e) {
    if (e instanceof JjackError) return e
    throw e
  }
  throw new Error("expected an error")
}

describe.concurrent("the library", () => {
  it("submit_and_its_dry_run", async ({ expect }) => {
    await using env = await TestEnv.create()
    const ctx = await context(env)
    const a = await change(env, "a")
    const b = await change(env, "b")
    const stack = new Stack(env)
    stack.body("b.md", "# Change B\n\nWhat B does.\n")
    stack.entries([
      { tip: a, title: "Change A" },
      { tip: b, body: "b.md" },
    ])
    const file = { file: stack.path }

    // A dry run has the shape of the real run, and changes nothing
    const dry = await submit(ctx, file, { dryRun: true })
    expect(env.gh.prs.size).toBe(0)
    expect(dry).toMatchObject({
      dryRun: true,
      pullRequests: [
        { label: a, number: null, url: null, action: "create", text: null, headOid: null },
        { label: b, number: null, action: "create", title: "Change B", headOid: null },
      ],
      stacks: [{ kind: "create", stack: null, pullRequests: [null, null] }],
    })

    const created = await submit(ctx, file)
    const prs = stack.prs()
    expect(created).toEqual({
      dryRun: false,
      pullRequests: [0, 1].map((i) => ({
        label: [a, b][i],
        number: prs[i],
        url: `https://github.com/fake/repo/pull/${prs[i]}`,
        action: "create",
        updates: [],
        text: null,
        title: ["Change A", "Change B"][i],
        commit: stack.entry(i).pushed,
        head: env.pr(prs[i]).headRef,
        base: i === 0 ? "main" : env.pr(prs[0]).headRef,
        headOid: env.headOf(prs[i]),
      })),
      stacks: [{ kind: "create", stack: expect.any(Number), pullRequests: prs }],
    })
    expect(dry.pullRequests.map((p) => [p.head, p.base])).toEqual(
      created.pullRequests.map((p) => [p.head, p.base]),
    )

    // A new body for B: no commits, the body on GitHub. Status and dry run
    // agree, and the dry run lists the text-only update and leaves it alone.
    stack.body("b.md", "# Change B\n\nWhat B does,\nrevised.\n")
    expect((await status(ctx, stack.path)).entries[1].actions).toEqual([
      { kind: "update_text", text: "update the body" },
    ])
    const before = env.pr(prs[1]).body
    ctx.out.lines.length = 0
    const planned = await submit(ctx, file, { dryRun: true })
    expect(planned.pullRequests[1]).toMatchObject({ action: "none", text: "body" })
    expect(planned.stacks).toEqual([])
    expect(ctx.out.lines.join("\n")).toContain("Would process 1 change(s)")
    expect(ctx.out.lines.join("\n")).toContain(`UPDATE PR #${prs[1]} (body)`)
    expect(env.pr(prs[1]).body).toBe(before)
    const updated = await submit(ctx, file)
    expect(updated.pullRequests.map((p) => [p.action, p.text])).toEqual([
      ["none", null],
      ["none", "body"],
    ])
    expect(env.pr(prs[1]).body).toBe("What B does,\nrevised.")

    // GitHub's web UI stores \r\n line endings; submit normalizes before comparing
    env.pr(prs[1]).body = "What B does,\r\nrevised.\r\n"
    const reqBefore = env.gh.requests.length
    const crlf = await submit(ctx, file)
    expect(crlf.pullRequests[1]).toMatchObject({ action: "none", text: null })
    expect(env.requestsSince(reqBefore, "PATCH", `/pulls/${prs[1]}`)).toEqual([])

    // An edit of A updates both
    await env.jj(["edit", a])
    await env.commit("Change A", "a.txt", "a, edited\n")
    await env.jj(["squash", "--from", "@-", "--into", a])
    await env.jj(["new", b])
    // Status and the plan say what each update is: commits for A's edit, and a
    // merge of A's branch into B's
    expect((await status(ctx, stack.path)).entries.map((e) => e.actions)).toEqual([
      [{ kind: "push", text: "push the changes" }],
      [{ kind: "merge", text: `merge #${prs[0]}` }],
    ])
    const plan = await submit(ctx, file, { dryRun: true })
    expect(plan.pullRequests.map((p) => p.updates)).toEqual([["push"], ["merge"]])
    const edited = await submit(ctx, file, { message: "edit A" })
    expect(edited.pullRequests.map((p) => p.action)).toEqual(["update", "update"])
    expect(edited.pullRequests.map((p) => p.updates)).toEqual([["push"], ["merge"]])
    expect(edited.pullRequests[0].headOid).toBe(env.headOf(prs[0]))
  })

  it("refusals_and_partial_results", async ({ expect }) => {
    await using env = await TestEnv.create()
    const ctx = await context(env)
    const a = await change(env, "a")
    const b = await change(env, "b")
    const stack = new Stack(env)
    stack.entries([{ tip: a, title: "Change A" }, { tip: b }])

    // A problem: the error has the problems, and status has them too
    const refused = await rejection(submit(ctx, { file: stack.path }))
    expect(refused.code).toBe("problems")
    expect(refused.problems).toEqual([
      {
        code: "no_title",
        tip: b,
        message: `'${b}' has no title. Give it a title key, or start its body file with a \`# \` heading.`,
      },
    ])
    expect((await status(ctx, stack.path)).problems).toEqual(refused.problems)

    // GitHub refuses to create B's: A's is created, and the error has it
    stack.entries([
      { tip: a, title: "Change A" },
      { tip: b, title: "Change B" },
    ])
    env.gh.failingCreations.push("spr/change-b")
    const stopped = await rejection(submit(ctx, { file: stack.path }))
    expect(stopped.code).toBe("github")
    expect(stopped.status).toBe(500)
    expect(stopped.partial).toMatchObject({
      dryRun: false,
      pullRequests: [{ label: a, number: stack.entry(0).pr, action: "create" }],
      stacks: [],
    })

    // A merged pull request: a problem whose fix is the sync
    await submit(ctx, { file: stack.path })
    const prs = stack.prs()
    env.gh.mergeOnGithub(prs[0])
    const checked = await status(ctx, stack.path)
    expect(checked.problems).toEqual([
      expect.objectContaining({
        code: "merged",
        tip: a,
        pr: prs[0],
        fix: [`jjack sync ${stack.path}`],
      }),
    ])

    // Usage errors, for options of the other source
    const usage = await rejection(land(ctx, { revision: b }, { upto: a }))
    expect(usage.code).toBe("usage")
  })

  it("land_close_and_sync", async ({ expect }) => {
    await using env = await TestEnv.create()
    const ctx = await context(env)
    const changes = [await change(env, "a"), await change(env, "b"), await change(env, "c")]
    const stack = new Stack(env)
    stack.entries(changes.map((tip, i) => ({ tip, title: `Change ${"ABC"[i]}` })))
    await submit(ctx, { file: stack.path })
    const prs = stack.prs()

    const landed = await land(ctx, { file: stack.path }, { upto: changes[0] })
    expect(landed).toEqual({
      landed: [prs[0]],
      notLanded: [],
      commit: env.branch("main"),
      retargeted: [],
      deletedBranches: [env.pr(prs[0]).headRef],
      sync: {
        dryRun: false,
        items: [0, 1, 2].map((i) => ({
          label: changes[i],
          changeIds: [changes[i].slice(0, 8)],
          number: prs[i],
          state: i === 0 ? "merged" : "open",
        })),
        abandoned: [prs[0]],
        rebased: true,
        markedMerged: [prs[0]],
        remaining: prs.slice(1),
        movedWorkingCopy: false,
      },
      syncError: null,
    })

    // Again, nothing has merged
    const synced = await sync(ctx, { file: stack.path })
    expect(synced).toMatchObject({ abandoned: [], rebased: false, remaining: prs.slice(1) })
    expect(synced.items.map((item) => item.state)).toEqual(["open", "open"])

    // Partway: B lands and C does not, and there is no sync
    env.gh.blocked.push(prs[2])
    const stopped = await rejection(land(ctx, { file: stack.path }))
    expect(stopped.code).toBe("blocked")
    expect(stopped.fix).toEqual([`jjack sync ${stack.path}`])
    expect(stopped.partial).toMatchObject({
      landed: [prs[1]],
      notLanded: [prs[2]],
      sync: null,
    })
    expect(await env.isVisible(changes[1])).toBe(true)
    await sync(ctx, { file: stack.path })
    env.gh.blocked.length = 0

    const closed = await close(ctx, { file: stack.path }, { all: true })
    expect(closed).toEqual({
      closed: [{ number: prs[2], branchDeleted: true, keptFor: [] }],
    })
    expect(stack.read().prs.map((e: { pr?: number }) => e.pr)).toEqual([
      prs[0],
      prs[1],
      undefined,
    ])
  })

  it("init_adopt_and_status", async ({ expect }) => {
    await using env = await TestEnv.create()
    const ctx = await context(env)
    const a = await change(env, "a")
    await env.jj(["git", "push", "--named", `feat-a=${a}`])
    const number = env.gh.openPrOutsideJjack("feat-a", "main", "Change a")
    const b = await change(env, "b")
    const stack = new Stack(env)

    // init needs no config
    const initialized = await init({ repo: ctx.repo, out: captureOut() }, stack.path, {
      tips: `${a} | ${b}`,
    })
    const bTip = initialized.entries[1].tip
    expect(b.startsWith(bTip), bTip).toBe(true)
    expect(initialized).toEqual({
      path: stack.path,
      entries: [
        { tip: "feat-a", title: "Change a" },
        { tip: bTip, title: "Change b" },
      ],
    })

    const adopted = await adopt(ctx, stack.path)
    expect(adopted).toEqual({
      dryRun: false,
      adopted: [{ tip: "feat-a", number, text: "matches" }],
      skipped: [
        {
          tip: bTip,
          reason: `'${bTip}' is not a local bookmark, so it has no branch to adopt.`,
        },
      ],
      untracked: ["feat-a"],
      rewritten: 1,
    })

    const checked = await status(ctx, stack.path)
    expect(checked.entries.map((e) => e.actions)).toEqual([
      [],
      [{ kind: "open", text: "open a pull request" }],
    ])
    expect(checked.entries[0]).toMatchObject({
      tip: "feat-a",
      pr: number,
      state: "open",
      title: "Change a",
      titleFrom: "key",
      members: [{ changeId: a, title: "Change a", sincePushed: "unchanged" }],
    })
  })

  it("reads_take_no_snapshot", async ({ expect }) => {
    await using env = await TestEnv.create()
    const [stack] = await threeEntries(env)
    const ctx = await context(env)
    await submit(ctx, { file: stack.path })
    // The newest operation, read without a snapshot
    const operation = () =>
      env.jj(["op", "log", "--ignore-working-copy", "--no-graph", "-n", "1", "-T", "id"])

    // An edit that no jj command has seen: a read would snapshot it
    const before = await operation()
    writeFileSync(join(env.work, "unsaved.txt"), "edited\n")
    const local = await openLocalContext(env.work, { env: env.env })
    const reads = {
      resolveStack: () => resolveStack(local, stack.path, { classify: true }),
      openContext: async () => resolveStack(await context(env), stack.path),
      status: () => status(ctx, stack.path),
      submit: () => submit(ctx, { file: stack.path }, { dryRun: true }),
    }
    for (const [name, read] of Object.entries(reads)) {
      await read()
      expect(await operation(), name).toBe(before)
    }

    // A sync's dry run fetches, which is an operation, but takes no snapshot
    await sync(ctx, { file: stack.path }, { dryRun: true })
    expect(await env.jj(["file", "list", "--ignore-working-copy"])).not.toContain("unsaved")

    // `snapshot` does, from a local context too
    await snapshot(local)
    expect(await operation()).not.toBe(before)
    writeFileSync(join(env.work, "later.txt"), "edited\n")

    // The command line snapshots first, so it sees the edit
    await env.jjack(["status", stack.path])
    expect(await env.jj(["file", "list", "--ignore-working-copy"])).toContain("later")
  })

  it("the_main_branch_comes_from_trunk", async ({ expect }) => {
    await using env = await TestEnv.create()
    const a = await change(env, "a")
    const stack = new Stack(env)
    stack.entries([{ tip: a, title: "Change A" }])
    const resolved = async () =>
      resolveStack(await openLocalContext(env.work, { env: env.env }), stack.path)

    expect(await resolved()).toMatchObject({ trunk: "main@origin", problems: [] })

    // A repository whose main branch is master: trunk() has it
    const main = await env.commitId("main@origin")
    await env.gitIn(env.work, ["update-ref", "refs/remotes/origin/master", main])
    await env.gitIn(env.work, ["update-ref", "-d", "refs/remotes/origin/main"])
    await env.jj(["git", "import"])
    await env.jj(["config", "set", "--repo", 'revset-aliases."trunk()"', "master@origin"])
    const master = await resolved()
    expect(master.trunk).toBe("master@origin")
    expect(master.entries[0].members).toHaveLength(1)

    // The setting wins. A main branch that is not there is a config error.
    await env.jj(["config", "set", "--repo", "jjack.mainBranch", "release 2"])
    const missing = await rejection(resolved())
    expect(missing.code).toBe("config")
    expect(missing.message).toContain('The main branch, "release 2"@origin, is not in')

    // trunk() on another remote: back to main
    await env.jj(["config", "unset", "--repo", "jjack.mainBranch"])
    await env.jj(["config", "set", "--repo", 'revset-aliases."trunk()"', "root()"])
    expect((await rejection(resolved())).message).toContain("main@origin, is not in")
  })

  it("resolve_stack_without_github", async ({ expect }) => {
    await using env = await TestEnv.create()
    const [stack, groups] = await threeEntries(env)
    await submit(await context(env), { file: stack.path })

    // Without a token, branch prefix, or repository, openContext refuses and
    // openLocalContext doesn't. A jj that logs each call counts them.
    writeFileSync(env.env.JJ_CONFIG, "")
    expect((await rejection(context(env))).code).toBe("config")
    const jj = join(env.root, "jj-logged")
    writeFileSync(jj, `#!/bin/sh\necho >> "$0.log"\nexec jj "$@"\n`)
    chmodSync(jj, 0o755)
    const ctx = await openLocalContext(env.work, { env: { ...env.env, JJ: jj } })
    const requests = env.gh.requests.length
    const jjCalls = async <T>(call: () => Promise<T>): Promise<[T, number]> => {
      writeFileSync(`${jj}.log`, "")
      const result = await call()
      return [result, readFileSync(`${jj}.log`, "utf8").length]
    }

    // Right after a submit, each change is exactly as pushed
    const [a, b, c] = [groups[0][0], groups[1], groups[2][0]]
    const [fresh, freshCalls] = await jjCalls(() => resolveStack(ctx, stack.path))
    expect(freshCalls).toBe(3)
    expect(fresh.problems).toEqual([])
    const commits = await Promise.all([a, ...b, c].map((id) => env.commitId(id)))
    expect(fresh.entries).toEqual([
      {
        tip: a,
        merged: false,
        commit: commits[0],
        tipKind: "change",
        pushed: commits[0],
        members: [
          { commit: commits[0], changeId: a, title: "Change a", pushedCommit: commits[0] },
        ],
      },
      {
        tip: "b",
        merged: false,
        commit: commits[3],
        tipKind: "bookmark",
        pushed: commits[3],
        members: b.map((changeId, i) => ({
          commit: commits[i + 1],
          changeId,
          title: `Change b${i + 1}`,
          pushedCommit: commits[i + 1],
        })),
      },
      expect.objectContaining({ tip: c, commit: commits[4], tipKind: "change" }),
    ])
    const [classified, classifiedCalls] = await jjCalls(() =>
      resolveStack(ctx, stack.path, { classify: true }),
    )
    expect(classifiedCalls).toBe(3)
    expect(classified.entries.flatMap((e) => e.members.map((m) => m.sincePushed))).toEqual(
      Array(5).fill("unchanged"),
    )

    // b2 edited, b4 new on top of b3, and b3 and c rebased
    await env.jj(["edit", b[1]])
    writeFileSync(join(env.work, "b2.txt"), "b2, revised\n")
    await env.jj(["new", "--insert-after", b[2], "-m", "Change b4"])
    writeFileSync(join(env.work, "b4.txt"), "b4\n")
    await env.jj(["bookmark", "set", "b", "-r", "@"])
    await env.jj(["new", c])
    const plain = await resolveStack(ctx, stack.path)
    const members = plain.entries[1].members
    expect(members.map((m) => m.title)).toEqual([1, 2, 3, 4].map((n) => `Change b${n}`))
    expect(members[0].pushedCommit).toBe(members[0].commit)
    for (const m of members.slice(1, 3)) {
      expect(m.pushedCommit).not.toBeNull()
      expect(m.pushedCommit).not.toBe(m.commit)
    }
    expect(members[3].pushedCommit).toBeNull()
    expect(plain.entries[1].pushed, "the pushed tip, now hidden").toBe(commits[3])
    expect(members.every((m) => m.sincePushed === undefined)).toBe(true)
    const edited = await resolveStack(ctx, stack.path, { classify: true })
    expect(edited.entries.map((e) => e.members.map((m) => m.sincePushed))).toEqual([
      ["unchanged"],
      ["unchanged", "edited", "unchanged", "new"],
      ["unchanged"],
    ])

    // A pushed commit that isn't in the repository, and one that isn't a
    // commit ID
    stack.edit(0, { pushed: "0123456789abcdef0123456789abcdef01234567" })
    stack.edit(2, { pushed: "not a commit" })
    const missing = await resolveStack(ctx, stack.path, { classify: true })
    for (const i of [0, 2]) {
      expect(missing.entries[i]).toMatchObject({ pushed: null })
      expect(missing.entries[i].members).toEqual([
        expect.objectContaining({ pushedCommit: null, sincePushed: "unknown" }),
      ])
    }

    // Tips not in a line still have their commits
    stack.entries([{ tip: c }, { tip: a }])
    const outOfLine = await resolveStack(ctx, stack.path)
    expect(outOfLine.problems.map((p) => [p.code, p.tip])).toEqual([
      ["tips_not_in_line", a],
    ])
    expect(outOfLine.entries.map((e) => [e.commit, e.tipKind, e.members.length])).toEqual([
      [await env.commitId(c), "change", 6],
      [commits[0], "change", 0],
    ])
    expect(env.gh.requests.length, "no GitHub requests").toBe(requests)
  })

  it("close_handles_list_and_delete_failures", async ({ expect }) => {
    await using env = await TestEnv.create()
    const ctx = await context(env)
    const a = await change(env, "a")
    const b = await change(env, "b")
    const stack = new Stack(env)
    stack.entries([
      { tip: a, title: "Change A" },
      { tip: b, title: "Change B" },
    ])
    await submit(ctx, { file: stack.path })
    const [prA, prB] = stack.prs()

    // Failing to list open PRs keeps the branch and warns, while still
    // clearing the closed entry from the stack file
    env.gh.failingQueries.push("OpenPullRequestBranchesQuery")
    const first = await close(ctx, { file: stack.path }, { pr: b })
    expect(first.closed).toEqual([{ number: prB, branchDeleted: false, keptFor: [] }])
    expect(env.pr(prB).state).toBe("closed")
    expect(env.branch(env.pr(prB).headRef)).toBeDefined()
    expect(stack.entry(1).pr).toBeUndefined()
    expect(ctx.out.warnings.at(-1)).toContain("Could not list the open pull requests")
    env.gh.failingQueries.length = 0

    // A rejected branch deletion reports branchDeleted: false and warns
    const hook = join(env.root, "remote.git/hooks/pre-receive")
    writeFileSync(
      hook,
      '#!/bin/sh\nwhile read old new ref; do\n  case $new in 0000000000000000000000000000000000000000)\n    echo "deletion denied" >&2; exit 1;;\n  esac\ndone\n',
    )
    chmodSync(hook, 0o755)
    const second = await close(ctx, { file: stack.path }, { pr: a })
    expect(second.closed).toEqual([{ number: prA, branchDeleted: false, keptFor: [] }])
    expect(env.pr(prA).state).toBe("closed")
    expect(stack.entry(0).pr).toBeUndefined()
    expect(ctx.out.warnings.at(-1)).toContain("Could not delete branch")
    expect(ctx.out.warnings.at(-1)).toContain("deletion denied")
  })

  it("publish_preserves_finish_error_in_message_and_json", async ({ expect }) => {
    await using env = await TestEnv.create()
    const ctx = await context(env)
    const a = await change(env, "a")
    const changes = await ctx.repo.changes(`main@origin..${a}`)
    env.gh.failingCreations.push("spr/change-a")
    const { publish } = await import("../src/publish.ts")
    const err = await rejection(
      publish(
        ctx,
        { revision: a },
        [{ label: a, changes, pullRequest: null, text: { title: "Change a", body: "" } }],
        {},
        {
          async published() {},
          async finish() {
            throw new JjackError("io", "could not save state")
          },
        },
      ),
    )
    expect(err.messages).toContain("could not save state")
    expect(err.message).toContain("could not save state")
    expect(err.toJSON().message).toContain("could not save state")
  })
})
