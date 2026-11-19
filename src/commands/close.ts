// `jjack close`: close pull requests and delete their branches. The stack
// file's entries stay, without their pr, synced, and pushed keys; the changes
// lose their `Pull Request:` lines. Either way, a later submit opens new pull
// requests.

import type { Ctx } from "../context.ts"
import { linkedNumber, readRange, removeLinks } from "../description.ts"
import { JjackError, type Change, type CloseResult, type Source } from "../model.ts"
import { findEntry, readStackFile, writeStackFile } from "../stack_file.ts"
import { fileHints, firstLine, formatPrList, revisionHints, trunkRevset } from "../text.ts"

export interface CloseOptions {
  /** A stack file's entry, by its tip */
  pr?: string
  /** Every pull request of the file, or up to the revision */
  all?: boolean
}

export function close(
  ctx: Ctx,
  source: Source,
  options: CloseOptions = {},
): Promise<CloseResult> {
  return "file" in source
    ? closeFile(ctx, source.file, options)
    : closeRevision(ctx, source.revision, options)
}

async function closeFile(ctx: Ctx, path: string, options: CloseOptions) {
  if ((options.pr !== undefined) === !!options.all) {
    throw new JjackError(
      "usage",
      options.all
        ? "Pass --pr <tip> or --all, not both."
        : "With a stack file, pass --pr <tip> to close one entry's pull request, or --all to close every one.",
    )
  }
  const file = await readStackFile(path)
  let targets: number[]
  if (options.pr !== undefined) {
    const index = findEntry(file, options.pr)
    const entry = file.prs[index]
    if (entry.pr === undefined || entry.merged) {
      throw new JjackError(
        entry.merged ? "merged" : "not_submitted",
        `'${options.pr}' has no open pull request to close.`,
        { tip: options.pr },
      )
    }
    targets = [index]
  } else {
    targets = file.prs.flatMap((e, i) => (e.pr !== undefined && !e.merged ? [i] : []))
  }
  const selection = targets.map((i) => file.prs[i].pr!)
  const result: CloseResult = { closed: [] }
  // Top first: deleting a branch closes the pull requests that target it
  for (const index of targets.reverse()) {
    const entry = file.prs[index]
    ctx.out.line("📄", entry.tip)
    const closed = await closePullRequest(ctx, entry.pr!, selection, fileHints(path).submit)
    result.closed.unshift(closed)
    delete entry.pr
    delete entry.synced
    delete entry.pushed
    await writeStackFile(path, file)
  }
  return result
}

async function closeRevision(ctx: Ctx, rev: string, options: CloseOptions) {
  if (options.pr !== undefined) throw new JjackError("usage", "--pr is for a stack file.")
  const result: CloseResult = { closed: [] }
  let targets: { change: Change; number: number }[]
  if (options.all) {
    const linked = await readRange(ctx, rev, "closing")
    if (linked.length === 0) {
      ctx.out.line(
        "👋",
        `No changes between ${trunkRevset(ctx.config)} and ${rev}. Nothing to close.`,
      )
      return result
    }
    targets = linked.flatMap(({ change, number }) =>
      number === null ? [] : [{ change, number }],
    )
  } else {
    const changes = await ctx.repo.changes(rev)
    if (changes.length !== 1) {
      throw new JjackError(
        "usage",
        "close -r needs one change, or --all to close every pull request up to it.",
      )
    }
    const number = linkedNumber(ctx, changes[0], "closing")
    if (number === null) {
      throw new JjackError("not_submitted", "This change does not refer to a pull request.")
    }
    targets = [{ change: changes[0], number }]
  }
  const selection = targets.map((t) => t.number)
  const closed: Change[] = []
  try {
    for (const { change, number } of [...targets].reverse()) {
      ctx.out.raw(`${change.commit.slice(0, 7)} ${firstLine(change.description)}`)
      const one = await closePullRequest(ctx, number, selection, revisionHints(rev).submit)
      result.closed.unshift(one)
      closed.unshift(change)
    }
  } finally {
    await removeLinks(ctx, closed)
  }
  return result
}

/** Close pull request `number` and delete its branch, unless another open
 * pull request outside `selection` (the ones this run closes) targets it */
async function closePullRequest(
  ctx: Ctx,
  number: number,
  selection: number[],
  submitCommand: string,
): Promise<CloseResult["closed"][number]> {
  const { repo, gh, out } = ctx
  out.line("#️⃣", `Pull request #${number}`)
  const pr = await gh.pullRequest(number)
  if (pr.state !== "open") {
    throw new JjackError("closed", "This pull request is already closed!", { pr: number })
  }
  out.line("📖", "Getting started...")
  try {
    await gh.updatePullRequest(number, { state: "closed" })
  } catch (e) {
    out.line("❌", "GitHub pull request close failed")
    throw e
  }
  out.line("📕", "Closed!")
  // Keep a branch that other open pull requests still use: GitHub closes a
  // pull request whose base branch is deleted, and a stacked pull request's
  // base is another one's branch
  let dependents: number[]
  try {
    dependents = (await gh.openPullRequests()).flatMap((open) =>
      open.number !== number && !selection.includes(open.number) && open.base === pr.head
        ? [open.number]
        : [],
    )
  } catch (e) {
    out.warn(
      `Could not list the open pull requests, so keeping ${pr.head} in case another pull request targets it: ${(e as Error).message}`,
    )
    return { number, branchDeleted: false, keptFor: [] }
  }
  if (dependents.length === 0) {
    // GitHub may delete the branch itself, in which case it is gone already
    const output = await repo.deleteBranch(pr.head)
    if (output.success || output.stderr.includes("remote ref does not exist")) {
      return { number, branchDeleted: true, keptFor: [] }
    }
    const stderr = output.stderr
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .join(" ")
    out.warn(`Could not delete branch ${pr.head}: ${stderr}`)
    return { number, branchDeleted: false, keptFor: [] }
  }
  const one = dependents.length === 1
  out.warn(
    `Keeping branch ${pr.head} because ${formatPrList(dependents)} still ${one ? "targets" : "target"} it. Run \`${submitCommand}\` to restack ${one ? "it" : "them"}.`,
  )
  return { number, branchDeleted: false, keptFor: dependents }
}
