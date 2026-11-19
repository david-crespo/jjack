// `jjack status`: check a stack file and show what `submit` would do with it.
// It changes nothing. `ah` imports `status` for its stack view.

import { reading, type Ctx } from "../context.ts"
import type { Config, Status, StatusActionKind, StatusEntry } from "../model.ts"
import type { Out } from "../output.ts"
import { planEntries, type EntryPlan } from "../publish.ts"
import { check, keptFromGithub, type Checked } from "../check.ts"
import { localEntries, resolve } from "../resolve.ts"
import { activeEntries, baseDir, readStackFile } from "../stack_file.ts"
import { shellWord, short, trunkRevset } from "../text.ts"

/** The stack file at `path` checked against the repository and GitHub: the
 * entries of `resolveStack`, with what changed since the last submit, and
 * their pull requests. Throws only when the file can't be read or jj or
 * GitHub fails. */
export async function status(ctx: Ctx, path: string): Promise<Status> {
  ctx = reading(ctx)
  const file = await readStackFile(path)
  const resolution = await resolve(ctx, file, activeEntries(file))
  const [checked, local] = await Promise.all([
    check(ctx, file, baseDir(path), path, resolution, false),
    localEntries(ctx, file, resolution.resolved, true),
  ])
  const refs = await ctx.repo.fetchBranches(
    checked.entries.flatMap((e) =>
      e.pullRequest?.state === "open" ? [e.pullRequest.head, e.pullRequest.base] : [],
    ),
  )

  // Plan actions for the leading entries whose changes are known and whose
  // pull requests (if any) are open. Once an entry has a problem below or at
  // it, what `submit` would do depends on how the problem is fixed.
  const firstUnknown = checked.entries.findIndex(
    (c) =>
      c.resolved.members.length === 0 ||
      (c.pullRequest !== null && c.pullRequest.state !== "open"),
  )
  const plannable =
    firstUnknown === -1 ? checked.entries : checked.entries.slice(0, firstUnknown)
  const line = await planEntries(
    ctx,
    plannable.map((c) => ({
      changes: c.resolved.members,
      pullRequest: c.pullRequest,
      branch: c.pullRequest?.head ?? null,
      text: c.wanted,
    })),
    refs,
  )

  const entries: StatusEntry[] = []
  for (const [index, entry] of file.prs.entries()) {
    const row: StatusEntry = {
      ...local[index],
      pr: entry.pr ?? null,
      lastPushed: entry.pushed ?? null,
    }
    entries.push(row)
    const position = checked.entries.findIndex((c) => c.resolved.index === index)
    if (position === -1) continue
    const { text, pullRequest } = checked.entries[position]
    if (text !== null) {
      row.title = text.text.title
      row.titleFrom = text.source
    }
    if (pullRequest !== null) row.state = pullRequest.state
    const plan = line?.plans[position]
    if (!plan) continue
    row.actions = actionsFor(ctx.config, checked.entries, position, plan)
    const kept = keptFromGithub(checked.entries[position])
    if (kept !== null) row.keptFromGithub = kept
  }
  return { file: path, trunk: trunkRevset(ctx.config), entries, problems: checked.problems }
}

/** Describe what `submit` would do for the entry at `position` from its plan */
function actionsFor(
  config: Config,
  entries: Checked[],
  position: number,
  plan: EntryPlan,
): { kind: StatusActionKind; text: string }[] {
  const actions: { kind: StatusActionKind; text: string }[] = []
  const add = (kind: StatusActionKind, text: string) => actions.push({ kind, text })
  if (plan.action === "create") {
    add("open", "open a pull request")
    return actions
  }
  if (plan.updates.includes("push")) add("push", "push the changes")
  if (plan.updates.includes("merge")) {
    const below =
      position === 0
        ? config.main
        : entries[position - 1].pullRequest !== null
          ? `#${entries[position - 1].pullRequest!.number}`
          : "the new pull request below"
    add("merge", `merge ${below}`)
  }
  if (plan.updates.includes("retarget")) {
    add(
      "retarget",
      `retarget it from ${plan.pr.base} to ${plan.expectedBase ?? "the new pull request below"}`,
    )
  }
  if (plan.text !== null) add("update_text", `update the ${plan.text}`)
  return actions
}

/** Print `status` as text, ending with its problems */
export function printStatus(out: Out, status: Status): void {
  const name = status.file
  out.raw(`${name}: ${status.entries.length} entries, bottom first`)
  for (const [i, row] of status.entries.entries()) printRow(out, i + 1, row)
  const { problems } = status
  if (problems.length === 0) {
    out.raw(`\nNo problems: \`jjack submit ${shellWord(name)}\` would go ahead.`)
    return
  }
  out.raw("\nProblems (`jjack submit` refuses until they are fixed):")
  for (const problem of problems) {
    const [first, ...rest] = problem.message.split("\n")
    out.raw(`  - ${first}`)
    for (const line of rest) out.raw(`    ${line}`)
  }
  const count = problems.length
  out.raw(`\n${name} has ${count} problem${count === 1 ? "" : "s"}.`)
}

function printRow(out: Out, position: number, row: StatusEntry) {
  const pr =
    row.pr === null ? "" : row.state ? `  #${row.pr} (${row.state})` : `  #${row.pr}`
  if (row.merged) {
    out.raw(`\n${position}. ${row.tip}${pr}  merged`)
    return
  }
  out.raw(`\n${position}. ${row.tip}${pr}`)
  if (row.title !== undefined) {
    const from = row.titleFrom === "heading" ? "the body file's heading" : "the title key"
    out.raw(`   Title: ${row.title} (from ${from})`)
  }
  const { members } = row
  for (const [i, member] of members.entries()) {
    const what = member.sincePushed
    const changed =
      what === "new" || what === "edited" || what === "reworded"
        ? ` (${what} since the last submit)`
        : ""
    out.raw(
      `   ${i === 0 ? "Changes:" : "        "} ${short(member.changeId)} ${member.title}${changed}`,
    )
  }
  const since = members.flatMap((m) => (m.sincePushed ? [m.sincePushed] : []))
  if (since.length > 0 && since.every((s) => s === "unknown")) {
    out.raw(
      `   The last pushed commit, ${row.lastPushed?.slice(0, 12)}, is not in this repository, so what changed since then is unknown.`,
    )
  } else if (since.length > 0 && since.every((s) => s === "unchanged")) {
    out.raw("   No local changes since the last submit")
  }
  if (row.actions) {
    const would = row.actions.map((a) => a.text)
    if (row.keptFromGithub) would.push(`keep the ${row.keptFromGithub} edited on GitHub`)
    out.raw(`   Submit would: ${would.join(", ") || "nothing: it is up to date"}`)
  }
}
