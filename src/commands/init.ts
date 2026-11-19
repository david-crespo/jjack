// `jjack init`: write a new stack file with one entry per tip. It needs only
// the repository: no config and no token.

import type { Ctx } from "../context.ts"
import { JjackError, type InitResult } from "../model.ts"
import { createStackFile, type Entry } from "../stack_file.ts"

const INIT_TEMPLATE =
  `'{"commit":' ++ json(commit_id) ++ ',"changeId":' ++ json(change_id.short()) ++ ` +
  `',"bookmarks":' ++ json(local_bookmarks.map(|b| b.name())) ++ ` +
  `',"title":' ++ json(description.first_line()) ++ "}\\n"`

export async function init(
  ctx: Pick<Ctx, "repo" | "out">,
  path: string,
  options: { tips: string },
): Promise<InitResult> {
  const { repo, out } = ctx
  const revset = options.tips
  const tips = (await repo.commitIds(revset)).reverse()
  if (tips.length === 0) {
    throw new JjackError("no_changes", `--tips '${revset}' has no changes.`)
  }
  for (const [i, upper] of tips.entries()) {
    const lower = tips[i - 1]
    if (lower !== undefined && !(await repo.isAncestor(lower, upper))) {
      throw new JjackError(
        "tips_not_in_line",
        "The tips have to be in a line, each an ancestor of the next, but " +
          `${lower.slice(0, 7)} is not an ancestor of ${upper.slice(0, 7)}.`,
      )
    }
  }
  const listing = await repo.jj([
    "log",
    "--no-graph",
    "-r",
    tips.join(" | "),
    "-T",
    INIT_TEMPLATE,
  ])
  const entries = new Map<string, Entry>()
  for (const line of listing.split("\n")) {
    if (line === "") continue
    const { commit, changeId, bookmarks, title } = JSON.parse(line) as {
      commit: string
      changeId: string
      bookmarks: string[]
      title: string
    }
    const entry: Entry = {
      tip: bookmarks.length === 1 ? bookmarks[0] : changeId,
      other: {},
    }
    if (title.trim() !== "") entry.title = title.trim()
    entries.set(commit, entry)
  }
  const file = { prs: tips.flatMap((tip) => entries.get(tip) ?? []), other: {} }
  await createStackFile(path, file)
  out.raw(`Wrote ${path} with ${file.prs.length} entries, bottom first:`)
  for (const entry of file.prs) out.raw(`  ${entry.tip}  ${entry.title ?? "(no title)"}`)
  return {
    path,
    entries: file.prs.map((entry) => ({ tip: entry.tip, title: entry.title ?? null })),
  }
}
