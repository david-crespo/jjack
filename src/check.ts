// Validation of a resolved stack file against GitHub: entry titles and bodies,
// pull request states, text conflicts between the file and GitHub, and
// unlisted pull requests in the same GitHub stack.

import type { Ctx } from "./context.ts"
import {
  JjackError,
  type Problem,
  type ProblemCode,
  type PullRequest,
  type Text,
  type TextParts,
} from "./model.ts"
import type { Resolved } from "./resolve.ts"
import { entryText, type Entry, type EntryText, type StackFile } from "./stack_file.ts"
import { activePullRequests } from "./stacks.ts"
import {
  differingParts,
  fileHints,
  formatPrList,
  githubText,
  sameText,
  shellWord,
  textHash,
} from "./text.ts"

/** One entry checked against the repository and GitHub */
export interface Checked {
  resolved: Resolved
  /** The entry's title and body, when they can be read */
  text: EntryText | null
  pullRequest: PullRequest | null
  /** The title and body its pull request should have after `submit`: the
   * file's, or GitHub's when only GitHub's changed since the last push. null
   * when they can't be read or both changed. */
  wanted: Text | null
}

/** Whether `wanted` is the file's text, so `submit` records it in `synced` */
export const wantsFileText = (checked: Checked) =>
  checked.wanted !== null &&
  checked.text !== null &&
  sameText(checked.wanted, checked.text.text)

/** What `submit` keeps of GitHub's text in place of the file's, because only
 * GitHub's changed since the last submit */
export const keptFromGithub = (checked: Checked): TextParts | null =>
  checked.wanted === null || checked.text === null
    ? null
    : differingParts(checked.wanted, checked.text.text)

/**
 * Check the entries in `resolution` (bottom first) for everything `submit`
 * refuses on: the problems `resolve` finds, entries without a title, pull
 * requests that merged or were closed, open pull requests in their GitHub
 * stack that the file doesn't list, and titles and bodies that changed both
 * in the file and on GitHub since the last push (unless `overwriteGithub`).
 * `dir` is the stack file's directory, and `name` its path, for messages.
 */
export async function check(
  ctx: Ctx,
  file: StackFile,
  dir: string,
  name: string,
  resolution: { resolved: Resolved[]; problems: Problem[] },
  overwriteGithub: boolean,
): Promise<{ entries: Checked[]; problems: Problem[] }> {
  const { resolved } = resolution
  const problems = [...resolution.problems]
  const hints = fileHints(name)
  const pullRequests = await ctx.gh.pullRequests(
    resolved.map((r) => file.prs[r.index].pr ?? null),
  )
  const entries: Checked[] = []
  for (const [i, entryResolved] of resolved.entries()) {
    const entry = file.prs[entryResolved.index]
    const tip = entry.tip
    const pr = pullRequests[i]
    let text: EntryText | null = null
    try {
      text = await entryText(entry, dir)
    } catch (e) {
      // entryText throws only problems of the entry's text
      const { code, message } = e as JjackError
      problems.push({ code: code as ProblemCode, tip, message })
    }
    if (pr?.state === "merged") {
      problems.push({
        code: "merged",
        tip,
        pr: pr.number,
        message: `The pull request of '${tip}', #${pr.number}, has merged. Run \`${hints.sync}\` to abandon its changes and mark the entry merged.`,
        fix: [hints.sync],
      })
    } else if (pr?.state === "closed") {
      problems.push({
        code: "closed",
        tip,
        pr: pr.number,
        message: `The pull request of '${tip}', #${pr.number}, is closed. Remove the entry, or remove its pr and synced keys to open a new pull request.`,
      })
    }
    let wanted: Text | null = null
    if (text !== null && pr === null) wanted = text.text
    else if (text !== null && pr !== null) {
      wanted = wantedText(entry, text.text, pr)
      if (wanted === null && overwriteGithub) wanted = text.text
      else if (wanted === null) {
        problems.push({
          code: "text_changed_both",
          tip,
          pr: pr.number,
          message: `The title or body of '${tip}' changed both in the stack file and on GitHub (#${pr.number}) since the last submit. Copy GitHub's edits into the file, or pass --overwrite-github to replace them.`,
        })
      }
    }
    entries.push({ resolved: entryResolved, text, pullRequest: pr, wanted })
  }
  problems.push(...(await unlistedInStacks(ctx, file, name, entries)))
  return { entries, problems }
}

/** The title and body an existing pull request should have: the file's when
 * they changed since the last push (or match GitHub's), GitHub's when only
 * those changed, and null when both changed. Without `synced`, both count as
 * changed. */
function wantedText(entry: Entry, text: Text, pr: PullRequest): Text | null {
  const github = githubText(pr)
  const fileChanged = entry.synced !== textHash(text)
  const githubChanged = entry.synced !== textHash(github)
  if (sameText(github, text) || !githubChanged) return text
  if (!fileChanged) return github
  return null
}

/** Open pull requests in the GitHub stacks of the entries that the file
 * doesn't list */
async function unlistedInStacks(
  ctx: Ctx,
  file: StackFile,
  name: string,
  entries: Checked[],
): Promise<Problem[]> {
  const open = entries.flatMap((e) =>
    e.pullRequest?.state === "open" ? [e.pullRequest.number] : [],
  )
  if (open.length === 0) return []
  const listed = file.prs.flatMap((e) => (e.pr === undefined ? [] : [e.pr]))
  const problems: Problem[] = []
  for (const stack of (await ctx.gh.listStacks()) ?? []) {
    const active = activePullRequests(stack)
    if (!active.some((n) => open.includes(n))) continue
    const unlisted = active.filter((n) => !listed.includes(n))
    if (unlisted.length > 0) {
      problems.push({
        code: "unlisted_in_stack",
        tip: null,
        message: `GitHub stack #${stack.number} has ${formatPrList(unlisted)}, which ${unlisted.length === 1 ? "is" : "are"} not in ${name}. Put the entry back and close it with \`jjack close ${shellWord(name)} --pr <tip>\`, or close it on GitHub.`,
      })
    }
  }
  return problems
}
