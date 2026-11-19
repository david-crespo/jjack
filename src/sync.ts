// `jjack sync`: bring a local stack up to date after some of its pull requests
// merged. It fetches, abandons the local changes whose pull requests merged,
// and rebases the rest onto the main branch. Nothing is changed unless every
// merged change can be abandoned safely. When every change has merged, it
// moves an empty working copy left on the old main commit onto the new one.
//
// It also rebases when nothing merged but GitHub already moved the stack onto
// a newer main branch (the stack's rebase button, or "Update branch"): pushing
// from the old base would make the bottom pull request look like it reverts
// what landed in between. It never rebases only because main moved.
//
// It sits under the commands, beside the push core, since `land` runs it
// after landing.
//
// Largely translated from `spr/src/commands/sync.rs` and `spr/src/jj.rs` on
// papertigers/jj-spr's `native-stacks` branch (Mike Zeller).

import { reading, type Ctx } from "./context.ts"
import { assertLine, readRange } from "./description.ts"
import {
  JjackError,
  type Change,
  type Hints,
  type Source,
  type SyncItem,
  type SyncResult,
} from "./model.ts"
import { describeProblems, resolve } from "./resolve.ts"
import { activeEntries, readStackFile, writeStackFile } from "./stack_file.ts"
import { firstLine, formatPrList, hintsFor, short, trunkRevset } from "./text.ts"

export interface SyncOptions {
  dryRun?: boolean
}

export function sync(
  ctx: Ctx,
  source: Source,
  options: SyncOptions = {},
): Promise<SyncResult> {
  if (options.dryRun) ctx = reading(ctx)
  return "file" in source
    ? syncFile(ctx, source.file, options)
    : syncRevision(ctx, source.revision, options)
}

/** One pull request to sync: its changes, bottom first, its number, and the
 * entry's tip or the short change ID */
interface Item {
  label: string
  changes: Change[]
  number: number | null
}

async function fetchRemote(ctx: Ctx) {
  ctx.out.line("🔄", `Fetching from ${ctx.config.remote}`)
  await ctx.repo.jj(["git", "fetch", "--remote", ctx.config.remote])
}

const nothing = (options: SyncOptions): SyncResult => ({
  dryRun: !!options.dryRun,
  items: [],
  abandoned: [],
  rebased: false,
  markedMerged: [],
  remaining: [],
  movedWorkingCopy: false,
})

async function syncFile(ctx: Ctx, path: string, options: SyncOptions) {
  await fetchRemote(ctx)
  const file = await readStackFile(path)
  const indices = activeEntries(file)
  if (indices.length === 0) {
    ctx.out.line("👋", "Every entry has merged. Nothing to sync.")
    return nothing(options)
  }
  // Problems with the changes themselves don't matter here, as long as every
  // entry's changes are known
  const { resolved, problems } = await resolve(ctx, file, indices)
  if (resolved.some((r) => r.members.length === 0)) {
    throw new JjackError("problems", `Not syncing: ${describeProblems(path, problems)}`, {
      problems,
    })
  }
  const items = resolved.map((r) => ({
    label: file.prs[r.index].tip,
    changes: r.members,
    number: file.prs[r.index].pr ?? null,
  }))
  const result = await syncPlanned(ctx, items, options, { file: path })
  const merged = options.dryRun ? [] : result.abandoned
  if (merged.length === 0) return result
  for (const entry of file.prs) {
    if (entry.pr !== undefined && merged.includes(entry.pr)) entry.merged = true
  }
  await writeStackFile(path, file)
  ctx.out.line("📝", `Marked ${formatPrList(merged)} merged in ${path}`)
  return { ...result, markedMerged: merged }
}

async function syncRevision(ctx: Ctx, rev: string, options: SyncOptions) {
  await fetchRemote(ctx)
  const linked = await readRange(ctx, rev, "syncing")
  if (linked.length === 0) {
    ctx.out.line(
      "👋",
      `No changes between ${trunkRevset(ctx.config)} and ${rev}. Nothing to sync.`,
    )
    return nothing(options)
  }
  const items = linked.map(({ change, number }) => ({
    label: short(change.changeId),
    changes: [change],
    number,
  }))
  return syncPlanned(ctx, items, options, { revision: rev })
}

type Status =
  | { kind: "unsubmitted" }
  | { kind: "open"; number: number }
  | { kind: "merged"; number: number }
  | { kind: "differs"; number: number; why: string }
  | { kind: "closed"; number: number }

/** A revset for a change: its mutable version, when it has one. A change of
 * an adopted pull request has old versions in its branch's history once jjack
 * pushed to the branch, which jj shows as immutable commits with the same
 * change ID. */
const live = (changeId: string) =>
  `coalesce(change_id(${changeId}) & mutable(), change_id(${changeId}))`

/**
 * Sync `items`, the pull requests between the main branch and the top of the
 * stack, bottom first. The result has no entries marked merged: that is for
 * the stack file's caller.
 */
async function syncPlanned(
  ctx: Ctx,
  items: Item[],
  options: SyncOptions,
  source: Source,
): Promise<SyncResult> {
  const { repo, gh, config, out } = ctx
  const trunk = trunkRevset(config)
  const hints = hintsFor(source)
  assertLine(
    items.flatMap((item) => item.changes),
    "syncing",
    source,
  )
  const pullRequests = await gh.pullRequests(items.map((item) => item.number))
  const classified: (Item & { status: Status; shown: string; headOid: string | null })[] =
    []
  for (const [i, item] of items.entries()) {
    const pr = pullRequests[i]
    const status: Status =
      pr === null
        ? { kind: "unsubmitted" }
        : pr.state === "open"
          ? { kind: "open", number: pr.number }
          : pr.state === "closed"
            ? { kind: "closed", number: pr.number }
            : await mergedStatus(ctx, item, pr.number, pr.headOid)
    const top = item.changes.at(-1)!
    const shown = `${short(top.changeId)} ${firstLine(top.description) || "(no title)"}`
    classified.push({ ...item, status, shown, headOid: pr?.headOid ?? null })
  }

  for (const { status, shown: label } of classified) {
    if (status.kind === "merged") out.line("🛬", `${label}: #${status.number} merged`)
    else if (status.kind === "open") out.line("📖", `${label}: #${status.number} is open`)
    else if (status.kind === "unsubmitted") out.line("📝", `${label}: not submitted`)
    else if (status.kind === "closed") {
      out.line("📕", `${label}: #${status.number} was closed without merging; keeping it`)
    } else out.warn(`${label}: #${status.number} merged, but ${status.why}`)
  }

  // Stop before changing anything if a merged change can't be abandoned
  const differ = classified.filter((c) => c.status.kind === "differs")
  if (differ.length > 0) {
    throw new JjackError(
      "local_differs_from_merged",
      `Not syncing: ${differ.map((c) => short(c.changes.at(-1)!.changeId)).join(", ")} merged, ` +
        "but the local version differs from what merged. Move any edits you want to keep " +
        "into another change (for example with `jj split` or `jj squash --into`), or " +
        `abandon the change with \`jj abandon\` if you don't need them, then run \`${hints.sync}\` again.`,
      differ.length === 1 ? { pr: differ[0].number! } : {},
    )
  }

  const merged = classified.filter((c) => c.status.kind === "merged")
  const remaining = classified.filter((c) => c.status.kind !== "merged")
  const root = remaining[0]
  // Every item but an unsubmitted one has a number
  const numberOf = (c: Item) => c.number!
  const result: SyncResult = {
    dryRun: !!options.dryRun,
    items: classified.map((c) => ({
      label: c.label,
      changeIds: c.changes.map((m) => short(m.changeId)),
      number: c.number,
      state: c.status.kind as SyncItem["state"],
    })),
    abandoned: merged.map(numberOf),
    rebased: false,
    markedMerged: [],
    remaining: remaining.filter((c) => c.status.kind === "open").map(numberOf),
    movedWorkingCopy: false,
  }
  const rebase = async () => {
    await repo.jj(["rebase", "-s", live(root.changes[0].changeId), "-d", trunk])
    const count = remaining.reduce((sum, item) => sum + item.changes.length, 0)
    out.line("⤴️", `Rebased ${count} change(s) onto ${trunk}`)
  }
  const wouldRebase = () =>
    out.line(
      "  ",
      `Would rebase ${short(root.changes[0].changeId)} and its descendants onto ${trunk}`,
    )

  if (merged.length === 0) {
    const moved =
      root.status.kind === "open" && root.headOid !== null
        ? await newerMainBase(ctx, root.changes[0].parents[0], root.headOid)
        : null
    if (moved === null || root.status.kind !== "open") {
      out.line("✅", "Nothing in this stack has merged. Nothing to do.")
      return result
    }
    out.line(
      "⚾",
      `Nothing has merged, but GitHub rebased #${root.status.number} onto a newer ${trunk} (${moved.slice(0, 8)}), and the local stack is still on an older one.`,
    )
    result.rebased = true
    if (options.dryRun) wouldRebase()
    else {
      await rebase()
      await checkRebased(ctx, remaining, hints)
    }
    return result
  }

  result.rebased = root !== undefined
  if (options.dryRun) {
    for (const change of merged) out.line("  ", `Would abandon ${change.shown}`)
    if (root) wouldRebase()
    return result
  }

  // Rebase before abandoning. Abandoning first would move what is left onto
  // the parent of the merged changes and then onto the main branch: two
  // rebases, and a change that undoes part of a merged one loses that part
  // (the first rebase drops it, as there is nothing there to undo).
  if (root) await rebase()
  await repo.jj([
    "abandon",
    ...merged.flatMap((c) => c.changes.map((m) => live(m.changeId))),
  ])
  for (const change of merged) {
    out.line(
      "🗑️",
      `Abandoned ${change.changes.map((m) => short(m.changeId)).join(", ")} (#${numberOf(change)})`,
    )
  }
  if (remaining.length === 0) {
    out.line("🎉", "Every change in this stack has merged.")
    // An empty working copy on the stack's top, or the one jj made for an
    // abandoned working copy, is now on the old main commit
    const idle = `@ & empty() & description(exact:"") & visible_heads() & children(::${trunk} ~ ${trunk})`
    if ((await repo.commitIds(idle)).length > 0) {
      await repo.jj(["rebase", "-r", "@", "-d", trunk])
      out.line("🏠", `Moved the empty working copy onto ${trunk}`)
      result.movedWorkingCopy = true
    }
    return result
  }
  await checkRebased(ctx, remaining, hints)
  return result
}

/** A merged pull request's local changes can be abandoned only if what merged
 * has everything they do */
async function mergedStatus(
  ctx: Ctx,
  item: Item,
  number: number,
  head: string | null,
): Promise<Status> {
  const { repo } = ctx
  if (head === null)
    return { kind: "differs", number, why: "GitHub did not report its final version" }
  // Not in the local repository (for example, it was pushed from another
  // machine). GitHub still serves it by ID.
  if ((await repo.treeIfPresent(head)) === null) await repo.fetch([head])
  const headTree = await repo.treeIfPresent(head)
  if (headTree === null) {
    return {
      kind: "differs",
      number,
      why: "its final version could not be fetched to compare with",
    }
  }
  // Comparing whole trees is not enough: a pull request whose branch was
  // updated from main on GitHub has a different tree even though nothing is
  // unpublished. Check that the local changes' diff is in the merged tree.
  const contains = await repo.treeContainsDiff(
    headTree,
    await repo.tree(item.changes[0].parents[0]),
    await repo.tree(item.changes.at(-1)!.commit),
  )
  return contains
    ? { kind: "merged", number }
    : {
        kind: "differs",
        number,
        why: "the local change has edits that are not in the merged pull request",
      }
}

/** The newer main commit a pull request's head is on, if GitHub moved it
 * there and `localBase`, the parent of the local changes, is older. null when
 * only the main branch moved, so that a stack is never rebased only because
 * main has new commits. */
async function newerMainBase(ctx: Ctx, localBase: string, remoteHead: string) {
  const { repo } = ctx
  // Fetch GitHub's head by ID when it is not in the repository
  if ((await repo.treeIfPresent(remoteHead)) === null) await repo.fetch([remoteHead])
  if ((await repo.treeIfPresent(remoteHead)) === null) return null
  // jj's main, which the fetch at the start of sync moved. git's
  // remote-tracking ref can be behind it.
  const main = (await repo.commitIds(trunkRevset(ctx.config)))[0] ?? null
  if (main === null) return null
  // No common history: GitHub did not move it onto main
  const remoteBase = await repo.mergeBase(remoteHead, main)
  if (remoteBase === null || remoteBase === localBase) return null
  return (await repo.isAncestor(localBase, remoteBase)) ? remoteBase : null
}

/** After a rebase: stop on conflicts, or say what to do next */
async function checkRebased(
  ctx: Ctx,
  remaining: { changes: Change[]; status: Status }[],
  hints: Hints,
) {
  const top = remaining.at(-1)!.changes.at(-1)!
  const conflicted = await ctx.repo.conflicted(
    `${trunkRevset(ctx.config)}..(${live(top.changeId)})`,
  )
  if (conflicted !== "") {
    throw new JjackError(
      "conflicts",
      `The rebase left conflicts in:\n${conflicted}\nResolve them (for example with \`jj resolve\`) before running \`${hints.submit}\`, or undo the sync with \`jj undo\`.`,
    )
  }
  if (remaining.some((c) => c.status.kind === "open")) {
    ctx.out.line("👉", `Run \`${hints.submit}\` to update the remaining pull requests.`)
  }
}
