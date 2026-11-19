// `jjack land`: merge the pull requests of a stack file's entries, or of the
// changes up to a revision, bottom first, then sync: abandon the landed
// changes and rebase the rest.

import type { Ctx } from "../context.ts"
import { readRange } from "../description.ts"
import {
  JjackError,
  toJjackError,
  type Hints,
  type LandResult,
  type PullRequest,
  type Source,
} from "../model.ts"
import { activePullRequests, stackContaining } from "../stacks.ts"
import { activeEntries, readStackFile } from "../stack_file.ts"
import { sync } from "../sync.ts"
import {
  fileHints,
  formatPrList,
  hintsFor,
  pullRequestUrl,
  revisionHints,
  short,
  trunkRevset,
} from "../text.ts"

const listOrNothing = (numbers: number[]) =>
  numbers.length === 0 ? "nothing" : formatPrList(numbers)

export interface LandOptions {
  /** A stack file's entries up to the one with this tip */
  upto?: string
  /** Sync after landing. Default true. */
  sync?: boolean
}

/** Land, then sync once every pull request asked for has landed. When the
 * sync refuses or fails, the landing is still done: warn, and put the error
 * in the result's `syncError`. */
export async function land(
  ctx: Ctx,
  source: Source,
  options: LandOptions = {},
): Promise<LandResult> {
  const result = await ("file" in source
    ? landFile(ctx, source.file, options)
    : landRevision(ctx, source.revision, options))
  if (result.landed.length === 0) return result
  const command = hintsFor(source).sync
  if (options.sync === false) {
    ctx.out.line(
      "👉",
      `Run \`${command}\` to abandon the landed changes and rebase the rest of the stack`,
    )
    return result
  }
  try {
    result.sync = await sync(ctx, source)
  } catch (e) {
    const error = toJjackError(e)
    result.syncError = { ...error.toJSON(), fix: error.fix ?? [command] }
    ctx.out.warn(
      [
        `Landed, but the sync after it stopped. Run \`${command}\` once this is fixed:`,
        ...error.messages,
      ].join("\n"),
    )
  }
  return result
}

async function landFile(ctx: Ctx, path: string, options: LandOptions) {
  const file = await readStackFile(path)
  const hints = fileHints(path)
  const numbers = activeEntries(file, options.upto).map((i) => {
    const entry = file.prs[i]
    if (entry.pr === undefined) {
      throw new JjackError(
        "not_submitted",
        `'${entry.tip}' has no pull request yet. Run \`${hints.submit}\` first.`,
        { tip: entry.tip, fix: [hints.submit] },
      )
    }
    return entry.pr
  })
  if (numbers.length === 0) {
    ctx.out.line("👋", "Every entry has merged. Nothing to land.")
    return landed([])
  }
  return landNumbers(ctx, numbers, path, hints)
}

async function landRevision(ctx: Ctx, rev: string, options: LandOptions) {
  if (options.upto !== undefined)
    throw new JjackError("usage", "--upto is for a stack file.")
  const trunk = trunkRevset(ctx.config)
  const hints = revisionHints(rev)
  const linked = await readRange(ctx, rev, "landing")
  if (linked.length === 0) {
    ctx.out.line("👋", `No changes between ${trunk} and ${rev}. Nothing to land.`)
    return landed([])
  }
  const numbers = linked.map(({ change, number }) => {
    if (number === null) {
      throw new JjackError(
        "not_submitted",
        `${short(change.changeId)} has no pull request yet. Run \`${hints.submit}\` first.`,
        { fix: [hints.submit] },
      )
    }
    return number
  })
  return landNumbers(ctx, numbers, `${trunk}..${rev}`, hints)
}

/** A result with nothing landed yet of `numbers` */
const landed = (numbers: number[]): LandResult => ({
  landed: [],
  notLanded: numbers,
  commit: null,
  retargeted: [],
  deletedBranches: [],
  sync: null,
  syncError: null,
})

/** Land pull requests `numbers`, bottom first. In a GitHub stack, that is one
 * landing of the top one, which merges the ones below it; the stack has to
 * have exactly those below it. Without one, each lands on its own. `source`
 * names where the numbers came from, for messages. An error after some landed
 * has the result as its `partial`. */
async function landNumbers(
  ctx: Ctx,
  numbers: number[],
  source: string,
  hints: Hints,
): Promise<LandResult> {
  const pullRequests = await ctx.gh.pullRequests(numbers)
  const merged = pullRequests.flatMap((pr) => (pr?.state === "merged" ? [pr.number] : []))
  if (merged.length > 0) {
    throw new JjackError(
      "merged",
      `Not landing: ${listOrNothing(merged)} merged already. Run \`${hints.sync}\` first.`,
      { fix: [hints.sync], ...(merged.length === 1 ? { pr: merged[0] } : {}) },
    )
  }
  const top = numbers.at(-1)!
  const below = numbers.slice(0, -1)
  const stack = stackContaining((await ctx.gh.listStacks()) ?? [], top)
  let toLand = numbers
  if (stack !== null) {
    const active = activePullRequests(stack)
    const stacked = active.slice(0, active.indexOf(top))
    if (stacked.join() !== below.join()) {
      throw new JjackError(
        "stack_mismatch",
        `Not landing: below #${top}, GitHub stack #${stack.number} has ` +
          `${listOrNothing(stacked)}, but ${source} has ${listOrNothing(below)}. Run ` +
          `\`${hints.submit}\` to bring GitHub up to date.`,
        { fix: [hints.submit] },
      )
    }
    toLand = [top]
  }
  for (const pr of pullRequests) checkLandable(ctx, pr!)
  const result = landed(numbers)
  try {
    for (const number of toLand) {
      ctx.out.line("#️⃣", `Pull request #${number}`)
      await landPullRequest(ctx, number, hints, result)
    }
  } catch (e) {
    const error = toJjackError(e)
    if (result.landed.length === 0) throw error
    result.notLanded = numbers.filter((n) => !result.landed.includes(n))
    error.partial = result
    if (!error.fix?.includes(hints.sync)) error.fix = [hints.sync, ...(error.fix ?? [])]
    throw error.context(
      `Run \`${hints.sync}\` to abandon the landed changes and rebase the rest of the stack.`,
    )
  }
  result.notLanded = []
  return result
}

/** Refuse a pull request that GitHub would not merge, or that is not approved
 * when approval is required */
function checkLandable(ctx: Ctx, pr: PullRequest) {
  const n = pr.number
  if (pr.state !== "open") {
    throw new JjackError("closed", `Pull request #${n} is already closed!`, { pr: n })
  }
  if (pr.isDraft) {
    throw new JjackError(
      "draft",
      `Pull request #${n} is a draft. Mark it ready for review first (for example with \`gh pr ready ${n}\`).`,
      { pr: n },
    )
  }
  const reason =
    pr.reviewDecision === "changes_requested"
      ? "has changes requested"
      : pr.reviewDecision === "required"
        ? "still requires a review"
        : pr.reviewDecision === "none" && ctx.config.requireApproval
          ? "has not been approved"
          : null
  if (reason !== null) {
    throw new JjackError("review", `Pull request #${n} ${reason} on GitHub.`, { pr: n })
  }
}

/** Land pull request `number`, with every open pull request below it in its
 * GitHub stack, and add what it did to `result` */
async function landPullRequest(ctx: Ctx, number: number, hints: Hints, result: LandResult) {
  const { gh, config, out } = ctx
  const pullRequest = await gh.pullRequest(number)
  checkLandable(ctx, pullRequest)
  out.line("🛫", "Getting started...")

  // A pull request in a GitHub stack lands together with every open one below
  // it. Any other has to target main: squash-merging one based on another
  // open pull request's branch would merge both as one commit.
  const stack = stackContaining((await gh.listStacks()) ?? [], number)
  if (stack === null && pullRequest.base !== config.main) {
    const base = pullRequest.base
    const below = (await gh.openPullRequests()).find((pr) => pr.head === base)
    throw new JjackError(
      "wrong_base",
      below
        ? `Pull request #${number} targets ${base}, the branch of open pull request #${below.number}, and is not in a GitHub stack, so landing it would merge both as one commit. Land #${below.number} first.`
        : `Pull request #${number} targets ${base}, not ${config.main}. Run \`${hints.submit}\` to retarget it before landing it.`,
      { pr: number, ...(below ? {} : { fix: [hints.submit] }) },
    )
  }

  // The pull requests below this one that merge with it, bottom first
  const mergedBelow: PullRequest[] = []
  if (stack !== null) {
    const active = activePullRequests(stack)
    for (const pr of await gh.pullRequests(active.slice(0, active.indexOf(number)))) {
      checkLandable(ctx, pr!)
      mergedBelow.push(pr!)
    }
    const bottom = mergedBelow[0] ?? pullRequest
    if (bottom.base !== config.main) {
      throw new JjackError(
        "wrong_base",
        `GitHub stack #${stack.number} targets ${bottom.base}, not ${config.main}.`,
        { pr: bottom.number },
      )
    }
    if (mergedBelow.length === 0) {
      out.line("🧱", `Merging from the bottom of GitHub stack #${stack.number}`)
    } else {
      const merging = [...mergedBelow.map((pr) => pr.number), number]
      out.line(
        "🧱",
        `Landing #${number} merges ${formatPrList(merging)} from GitHub stack #${stack.number} (bottom first)`,
      )
    }
  }

  // When the repository's default squash commit for a pull request is its
  // title and body, one merge of the top one lands the stack: GitHub
  // squash-merges each one below with that default, with no rebase in
  // between. Otherwise merge bottom first, one at a time, so each gets
  // jjack's title and message (GitHub applies them only to the pull request
  // named in the merge call). After each merge GitHub retargets the next one
  // to main and then replaces its head with a rebased one, so only the first
  // one still has the head read above.
  const merging = [...mergedBelow, pullRequest]
  const oneMerge = stack !== null && (await gh.squashDefaultsToPullRequest())
  if (stack !== null && !oneMerge && merging.length > 1) {
    out.line(
      "💡",
      "Setting the repository's default squash commit message to the pull request title and description lets jjack land a stack in one merge.",
    )
  }
  const numbersOf = (prs: PullRequest[]) => formatPrList(prs.map((pr) => pr.number))
  const landed: PullRequest[] = []
  const record = (prs: PullRequest[], commit: string | null) => {
    if (merging.length > 1) out.line("🛬", `Landed ${numbersOf(prs)}`)
    landed.push(...prs)
    result.landed.push(...prs.map((pr) => pr.number))
    result.commit = commit
  }
  const requireHead = (pr: PullRequest): string => {
    if (pr.headOid === null) {
      throw new JjackError(
        "github",
        `GitHub did not report the current head of pull request #${pr.number}.`,
        { pr: pr.number },
      )
    }
    return pr.headOid
  }
  let failure: JjackError | null = null
  try {
    if (oneMerge) {
      // One merge of a stack goes straight to GitHub, which checks the head
      // and every pull request in the merge, and says why if it refuses
      record(merging, await merge(ctx, pullRequest, requireHead(pullRequest), true, false))
    } else {
      for (const pr of merging) {
        const head = requireHead(pr)
        const wait = landed.length === 0 ? { expected: head } : { replaced: head }
        const current = await waitUntilMergeable(ctx, pr.number, wait, hints)
        record([pr], await merge(ctx, pr, current, stack !== null, true))
      }
    }
  } catch (e) {
    failure = toJjackError(e)
  }
  if (failure !== null && landed.length === 0) {
    out.line("❌", "GitHub pull request merge failed")
    throw failure
  }
  // Each landed pull request is a whole commit on main, so clean up after
  // those and report the rest
  if (failure !== null) {
    out.line(
      "❌",
      `Landed ${numbersOf(landed)}, but not ${numbersOf(merging.slice(landed.length))}`,
    )
  } else {
    out.line("🛬", "Landed!")
  }

  await cleanUp(ctx, landed, result)
  if (failure !== null) throw failure
}

/** Retarget open pull requests from landed branches to main and delete the
 * landed branches */
async function cleanUp(ctx: Ctx, landed: PullRequest[], result: LandResult) {
  const { repo, gh, config, out } = ctx
  // Other open pull requests may target a landed one's branch, as stacked
  // ones do. GitHub closes a pull request whose base branch is deleted, so
  // move them to main first, and keep any branch another one still uses.
  const landedHeads = landed.map((pr) => pr.head)
  let toDelete: string[] = []
  try {
    const open = (await gh.openPullRequests()).filter(
      (pr) => !landed.some((l) => l.number === pr.number),
    )
    const kept: string[] = []
    for (const dependent of open) {
      if (!landedHeads.includes(dependent.base)) continue
      try {
        await gh.updatePullRequest(dependent.number, { base: config.main })
        out.line("↪️", `Pull request #${dependent.number} now targets ${config.main}`)
        result.retargeted.push(dependent.number)
      } catch {
        kept.push(dependent.base)
        out.warn(
          `Pull request #${dependent.number} still targets ${dependent.base}; keeping that branch`,
        )
      }
    }
    toDelete = landedHeads.filter((head) => !kept.includes(head))
  } catch (e) {
    // Without the list, a branch that another pull request targets can't be
    // told apart from an unused one, and deleting it would close that one
    out.warn(
      `Could not list the open pull requests, so keeping ${landedHeads.join(", ")} in case another pull request targets them: ${(e as Error).message}`,
    )
  }
  const deletions = await Promise.all(
    toDelete.map(async (branch) => ({
      branch,
      output: await repo.deleteBranch(branch),
    })),
  )

  // GitHub may be configured to delete the branch itself, in which case it is
  // gone already and the push fails harmlessly; report any other failure
  for (const { branch, output } of deletions) {
    if (output.success || output.stderr.includes("remote ref does not exist")) {
      result.deletedBranches.push(branch)
    } else {
      const stderr = output.stderr
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "")
        .join(" ")
      out.warn(`Could not delete branch ${branch}: ${stderr}`)
    }
  }
}

/** Squash-merge `pr` at `head`, with jjack's title and message when
 * `ownMessage` is set and GitHub's default otherwise. A pull request in a
 * stack has to go through GitHub's stack merge. */
async function merge(
  ctx: Ctx,
  pr: PullRequest,
  head: string,
  stacked: boolean,
  ownMessage: boolean,
) {
  const message =
    `${pr.body.trim()}\n\nPull Request: ${pullRequestUrl(ctx.config, pr.number)}`.trim()
  try {
    if (!stacked) {
      return await ctx.gh.squashMerge(pr.number, { title: pr.title, message, sha: head })
    }
    const commit = ownMessage ? { title: pr.title, message } : undefined
    return await ctx.gh.mergeStacked(pr.number, { sha: head, commit }, ctx.sleep)
  } catch (e) {
    const error = toJjackError(e)
    error.pr ??= pr.number
    throw error.context(`squash-merging PR #${pr.number} (head ${head})`)
  }
}

/** How many times `land` asks GitHub whether a pull request can be merged,
 * one second apart: GitHub has taken over a minute after a stack rebase */
const MERGEABILITY_POLLS = 120

/** How many polls `land` waits for GitHub to replace a pull request's head
 * after a merge below it, about 30 seconds. Until then GitHub may report
 * whether the old head can be merged. GitHub pushes no new head when its
 * rebase conflicts, so after this the old head's mergeability counts. */
const REBASE_POLLS = 30

/**
 * Wait until GitHub has worked out whether pull request `number` can be
 * merged, and refuse if it cannot or GitHub blocks it. `expected` is a head
 * the pull request must still have. `replaced` is the head before a merge
 * below it in this run, which GitHub replaces with a rebased one: that is
 * settled once it targets main and has a new head, or after `REBASE_POLLS`
 * polls without one. Returns the head to merge.
 */
async function waitUntilMergeable(
  ctx: Ctx,
  number: number,
  head: { expected: string } | { replaced: string },
  hints: Hints,
): Promise<string> {
  const { config } = ctx
  for (let poll = 0; poll < MERGEABILITY_POLLS; poll++) {
    const status = await ctx.gh.mergeability(number)
    if (status.state === "merged") {
      throw new JjackError(
        "merged",
        `Pull request #${number} was already merged. Run \`${hints.sync}\` to abandon its changes and rebase the rest.`,
        { pr: number, fix: [hints.sync] },
      )
    }
    // GitHub closes a stacked pull request whose rebase after a merge below it
    // leaves no commits
    if (status.state === "closed") {
      throw new JjackError(
        "closed",
        `Pull request #${number} was closed without being merged, so it cannot be landed. Abandon its change, or open a new pull request for it (${hints.reopen}).`,
        { pr: number },
      )
    }
    let settled: boolean
    if ("expected" in head) {
      if (head.expected !== status.headOid) {
        throw new JjackError(
          "changed_externally",
          `Pull request #${number} seems to have been updated externally. Please try again!`,
          { pr: number },
        )
      }
      settled = true
    } else {
      settled =
        status.base === config.main &&
        (status.headOid !== head.replaced || poll >= REBASE_POLLS)
    }
    if (settled && status.mergeable !== null) {
      if (!status.mergeable) {
        throw new JjackError(
          "not_mergeable",
          "expected" in head
            ? `GitHub concluded pull request #${number} is not mergeable at this point. Please rebase your changes and try again!`
            : `Pull request #${number} conflicts with ${config.main} after the merge below it. Run \`${hints.sync}\`, resolve the conflict, and run \`${hints.submit}\` again.`,
          { pr: number },
        )
      }
      if (status.blocked) {
        throw new JjackError(
          "blocked",
          `Pull request #${number} can't be merged yet: GitHub is blocking it (required checks or review). Run \`${hints.land}\` again when it is ready.`,
          { pr: number },
        )
      }
      return status.headOid
    }
    if (poll === 0) {
      ctx.out.line("⏳", `Waiting for GitHub to work out whether #${number} can be merged`)
    }
    await ctx.sleep(1000)
  }
  throw new JjackError(
    "timeout",
    `GitHub has not finished computing whether pull request #${number} can be merged. Try again in a minute.`,
    { pr: number },
  )
}
