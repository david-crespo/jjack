// The description-line source: a change with a `Pull Request:` line is a pull
// request of that one change. The line is the only state: the branch name,
// the base, and the stack are read from GitHub.

import type { Ctx } from "./context.ts"
import { JjackError, type Change, type Source } from "./model.ts"
import {
  pullRequestUrl,
  readLink,
  short,
  trunkRevset,
  withLink,
  withoutLink,
} from "./text.ts"

export interface Linked {
  change: Change
  number: number | null
}

/** Check that `changes` form a single linear chain, each with one parent */
export function assertLine(changes: Change[], what: string, source: Source): void {
  for (const [i, change] of changes.entries()) {
    const why =
      change.parents.length !== 1
        ? "is a merge"
        : i > 0 && change.parents[0] !== changes[i - 1].commit
          ? "is on a separate branch"
          : null
    if (why !== null) {
      const detail =
        "file" in source
          ? `the changes of ${source.file} are not a single line of changes (${change.commit.slice(0, 7)} ${why}).`
          : `the changes up to the target are not a single line of changes (${change.commit.slice(0, 7)} ${why}). Pass \`-r <top of one stack>\` to pick one stack.`
      throw new JjackError("not_a_line", `Not ${what}: ${detail}`)
    }
  }
}

/**
 * The changes from the main branch up to `rev`, bottom first, with the pull
 * request each links. They have to be a line, each change linking at most one
 * pull request, and no pull request linked from two changes. `what` is the
 * command's verb for messages ("submitting", "landing", …).
 */
export async function readRange(ctx: Ctx, rev: string, what: string): Promise<Linked[]> {
  const changes = await ctx.repo.changes(`${trunkRevset(ctx.config)}..(${rev})`)
  assertLine(changes, what, { revision: rev })
  const linked = changes.map((change) => ({
    change,
    number: linkedNumber(ctx, change, what),
  }))
  const byNumber = new Map<number, Change[]>()
  for (const { change, number } of linked) {
    if (number !== null) byNumber.set(number, [...(byNumber.get(number) ?? []), change])
  }
  for (const [number, sharing] of byNumber) {
    if (sharing.length < 2) continue
    throw new JjackError(
      "invalid_pull_request_line",
      `Not ${what}: Pull request #${number} is linked from more than one change: ` +
        `${sharing.map((c) => short(c.changeId)).join(", ")}. Here a pull request is one ` +
        "change; use a stack file for a pull request of several changes. Keep the " +
        "`Pull Request:` line on one of them and remove it from the others (with " +
        "`jj describe`); they get pull requests of their own.",
      { pr: number },
    )
  }
  return linked
}

/** The pull request a change links. Refuses a line that links several or
 * that jjack cannot read: treating it as no link would open a new pull
 * request and orphan the old one. */
export function linkedNumber(ctx: Ctx, change: Change, what: string): number | null {
  const link = readLink(ctx.config, change.description)
  if (link.kind === "none") return null
  if (link.kind === "linked") return link.number
  const problem =
    link.kind === "several"
      ? "links more than one pull request (as after `jj squash` of two submitted changes)"
      : "has a `Pull Request:` line that jjack cannot read"
  throw new JjackError(
    "invalid_pull_request_line",
    `Not ${what}: ${short(change.changeId)} ${problem}:\n` +
      link.lines.map((line) => `  ${line}`).join("\n") +
      "\nKeep one `Pull Request:` line (with `jj describe`), and close the other pull " +
      "request on GitHub if it is no longer needed.",
  )
}

/** Describing a change rewrites its descendants, so the changes are
 * described top first: the commit IDs still to be used stay valid. */
async function describeTopFirst(ctx: Ctx, changes: Change[], edit: (c: Change) => string) {
  for (const change of [...changes].reverse()) {
    await ctx.repo.describe(change.commit, edit(change))
  }
}

/** Write a `Pull Request:` line into each change, bottom first */
export function writeLinks(ctx: Ctx, links: { change: Change; number: number }[]) {
  const urls = new Map(links.map((l) => [l.change, pullRequestUrl(ctx.config, l.number)]))
  return describeTopFirst(
    ctx,
    links.map((l) => l.change),
    (c) => withLink(c.description, urls.get(c)!),
  )
}

/** Remove the `Pull Request:` lines from `changes`, bottom first */
export function removeLinks(ctx: Ctx, changes: Change[]) {
  return describeTopFirst(ctx, changes, (c) => withoutLink(c.description))
}
