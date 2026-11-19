// `jjack submit`: push the pull requests of a stack file, or of the changes
// with `Pull Request:` lines up to a revision. Both check everything first,
// then hand the pull requests to the push core, and record what it did: in
// the stack file as each one is published, or in the changes' descriptions
// at the end.

import { reading, type Ctx } from "../context.ts"
import { readRange, writeLinks } from "../description.ts"
import {
  JjackError,
  type Change,
  type Planned,
  type Source,
  type SubmitResult,
} from "../model.ts"
import { publish, type PushOptions } from "../publish.ts"
import { check, keptFromGithub, wantsFileText } from "../check.ts"
import { describeProblems, resolve } from "../resolve.ts"
import { activeEntries, baseDir, readStackFile, writeStackFile } from "../stack_file.ts"
import {
  descriptionText,
  firstLine,
  formatPrList,
  revisionHints,
  short,
  textHash,
  trunkRevset,
} from "../text.ts"

export interface SubmitOptions extends PushOptions {
  /** A stack file's entries up to the one with this tip */
  upto?: string
  /** Replace titles and bodies edited on GitHub with the stack file's */
  overwriteGithub?: boolean
}

export function submit(
  ctx: Ctx,
  source: Source,
  options: SubmitOptions = {},
): Promise<SubmitResult> {
  if (options.dryRun) ctx = reading(ctx)
  return "file" in source
    ? submitFile(ctx, source.file, options)
    : submitRevision(ctx, source.revision, options)
}

const nothing = (options: SubmitOptions): SubmitResult => ({
  dryRun: !!options.dryRun,
  pullRequests: [],
  stacks: [],
})

async function submitFile(ctx: Ctx, path: string, options: SubmitOptions) {
  const file = await readStackFile(path)
  const indices = activeEntries(file, options.upto)
  if (indices.length === 0) {
    ctx.out.line("👋", "Every entry has merged. Nothing to submit.")
    return nothing(options)
  }
  const checked = await check(
    ctx,
    file,
    baseDir(path),
    path,
    await resolve(ctx, file, indices),
    !!options.overwriteGithub,
  )
  if (checked.problems.length > 0) {
    throw new JjackError(
      "problems",
      `Not submitting: ${describeProblems(path, checked.problems)}`,
      { problems: checked.problems },
    )
  }
  for (const entry of checked.entries) {
    const kept = keptFromGithub(entry)
    if (kept !== null && entry.pullRequest !== null) {
      ctx.out.line(
        "✋",
        `${options.dryRun ? "Would keep" : "Keeping"} the ${kept} of #${entry.pullRequest.number} as edited on GitHub (unchanged in the stack file since the last submit)`,
      )
    }
  }
  const planned: Planned[] = checked.entries.map((entry) => ({
    label: file.prs[entry.resolved.index].tip,
    changes: entry.resolved.members,
    pullRequest: entry.pullRequest,
    text: entry.wanted!,
  }))
  return publish(ctx, { file: path }, planned, options, {
    async published(i, tipCommit, number) {
      const entry = file.prs[checked.entries[i].resolved.index]
      const before = JSON.stringify(entry)
      entry.pr = number
      entry.pushed = tipCommit
      if (wantsFileText(checked.entries[i]))
        entry.synced = textHash(checked.entries[i].wanted!)
      if (JSON.stringify(entry) !== before) await writeStackFile(path, file)
    },
    async finish() {},
  })
}

async function submitRevision(ctx: Ctx, rev: string, options: SubmitOptions) {
  if (options.upto !== undefined || options.overwriteGithub) {
    throw new JjackError("usage", "--upto and --overwrite-github are for a stack file.")
  }
  const trunk = trunkRevset(ctx.config)
  const hints = revisionHints(rev)
  const linked = await readRange(ctx, rev, "submitting")
  if (linked.length === 0) {
    ctx.out.line("👋", `No changes between ${trunk} and ${rev}. Nothing to submit.`)
    return nothing(options)
  }
  const changes = linked.map((l) => l.change)
  const conflicted = await ctx.repo.conflicted(changes.map((c) => c.commit).join(" | "))
  if (conflicted !== "") {
    throw new JjackError(
      "conflicts",
      `Not submitting: these changes have conflicts:\n${conflicted}\nResolve them (for ` +
        `example with \`jj resolve\`) and run \`${hints.submit}\` again.`,
    )
  }
  const undescribed = changes.filter((c) => firstLine(c.description) === "")
  if (undescribed.length > 0) {
    const one = undescribed.length === 1
    throw new JjackError(
      "no_description",
      `Not submitting: ${undescribed.map((c) => short(c.changeId)).join(", ")} ` +
        `${one ? "has" : "have"} no description. A change's first line is its pull ` +
        `request's title. Describe ${one ? "it" : "them"} with \`jj describe\`.`,
    )
  }

  const pullRequests = await ctx.gh.pullRequests(linked.map((l) => l.number))
  const merged = pullRequests.flatMap((pr) => (pr?.state === "merged" ? [pr.number] : []))
  if (merged.length > 0) {
    throw new JjackError(
      "merged",
      `${formatPrList(merged)} ${merged.length === 1 ? "has" : "have"} already merged. Run ` +
        `\`${hints.sync}\` to abandon the merged change(s) and rebase the rest of the ` +
        `stack onto ${trunk}, then run \`${hints.submit}\` again.`,
      {
        fix: [hints.sync, hints.submit],
        ...(merged.length === 1 ? { pr: merged[0] } : {}),
      },
    )
  }
  const closed = pullRequests.flatMap((pr) => (pr?.state === "closed" ? [pr.number] : []))
  if (closed.length > 0) {
    throw new JjackError(
      "closed",
      `Not submitting: ${closed.length === 1 ? `Pull request #${closed[0]} is` : `Pull requests ${formatPrList(closed)} are`} ` +
        "closed. If you want to open a new one, remove the `Pull Request:` line from the " +
        "change's description.",
      closed.length === 1 ? { pr: closed[0] } : {},
    )
  }

  // The description always wins: an existing pull request gets its title and
  // body, with no check of what changed on GitHub
  const planned: Planned[] = linked.map(({ change }, i) => ({
    label: short(change.changeId),
    changes: [change],
    pullRequest: pullRequests[i],
    text: descriptionText(change.description),
  }))
  const created: { change: Change; number: number }[] = []
  return publish(ctx, { revision: rev }, planned, options, {
    async published(i, _tipCommit, number) {
      if (linked[i].number === null) {
        created.push({ change: linked[i].change, number })
      }
    },
    // Also after an error, so every pull request that was created has its line
    async finish() {
      await writeLinks(ctx, created)
    },
  })
}
