// Local resolution of a stack file against the jj repository: turn each entry's
// tip into its commit and member changes, find local problems, and compare
// against the last pushed commit. Needs no token or GitHub access.

import { reading, type LocalCtx } from "./context.ts"
import {
  JjackError,
  type Change,
  type LocalChange,
  type LocalEntry,
  type LocalStack,
  type Problem,
  type ProblemCode,
  type SincePushed,
} from "./model.ts"
import type { Repo } from "./repo.ts"
import { activeEntries, readStackFile, type StackFile } from "./stack_file.ts"
import { firstLine, hasLinkLine, quote, short, trunkRevset } from "./text.ts"

/** "<name> has N problems:" and one line for each, for an error message */
export function describeProblems(name: string, problems: Problem[]): string {
  const lines = problems.map((p) => `\n- ${p.message.replaceAll("\n", "\n  ")}`)
  return `${name} has ${problems.length} problem${problems.length === 1 ? "" : "s"}:${lines.join("")}`
}

/** Why a tip or an entry's changes can't be used */
type Why = { code: ProblemCode; problem: string }

type TipKind = "bookmark" | "change"

/** Resolve each of `tips` to the one visible change it names: a local
 * bookmark, or a change ID or a unique prefix of one. The problem says why a
 * tip can't be used. One jj call looks up every tip. */
async function resolveTips(
  repo: Repo,
  tips: string[],
): Promise<Map<string, { commit: string; kind: TipKind } | Why>> {
  const isChangeId = (tip: string) => /^[k-z]+$/.test(tip)
  const terms = (tip: string) => [
    `bookmarks(exact:${quote(tip)})`,
    ...(isChangeId(tip) ? [`change_id(${tip})`] : []),
  ]
  const lookups = [...new Set(tips)].filter((tip) => !tip.includes("@"))
  let rows: Awaited<ReturnType<Repo["commitsWithBookmarks"]>> = []
  /** jj's error for each tip it could not look up */
  const failed = new Map<string, string>()
  if (lookups.length > 0) {
    try {
      rows = await repo.commitsWithBookmarks(lookups.flatMap(terms).join(" | "))
    } catch {
      // jj refuses the whole revset when one change ID prefix in it is
      // ambiguous. Look up each tip alone: its bookmark, then its change ID.
      for (const tip of lookups) {
        for (const term of terms(tip)) {
          try {
            const found = await repo.commitsWithBookmarks(term)
            rows.push(...found)
            if (found.length > 0) break
          } catch (e) {
            failed.set(tip, (e as Error).message)
            break
          }
        }
      }
    }
  }
  const commits = (match: (row: (typeof rows)[number]) => boolean) => [
    ...new Set(rows.filter(match).map((row) => row.commit)),
  ]
  const why = (code: ProblemCode, problem: string): Why => ({ code, problem })
  const resolveTip = (tip: string): { commit: string; kind: TipKind } | Why => {
    if (tip.startsWith("@")) {
      return why(
        "tip_invalid",
        `The tip '${tip}' is relative to the working copy, so it moves. Use a local bookmark or a change ID.`,
      )
    }
    if (tip.includes("@")) {
      return why(
        "tip_invalid",
        `The tip '${tip}' is a remote bookmark. Use a local bookmark or a change ID.`,
      )
    }
    const error = failed.get(tip)
    if (error !== undefined) {
      return why("tip_invalid", `The tip '${tip}' could not be resolved: ${error}`)
    }
    const bookmarked = commits((row) => row.bookmarks.includes(tip))
    if (bookmarked.length === 1) return { commit: bookmarked[0], kind: "bookmark" }
    if (bookmarked.length > 1) {
      return why(
        "tip_conflicted",
        `The bookmark '${tip}' is conflicted: it points to ${bookmarked.length} changes. Resolve it with \`jj bookmark set\`.`,
      )
    }
    if (!isChangeId(tip)) {
      return why(
        "tip_not_found",
        `The tip '${tip}' is not a local bookmark or a change ID.`,
      )
    }
    const changes = commits((row) => row.changeId.startsWith(tip))
    if (changes.length === 1) return { commit: changes[0], kind: "change" }
    if (changes.length === 0) {
      return why(
        "tip_not_found",
        `The tip '${tip}' is not a local bookmark or a visible change. It may be missing or hidden (abandoned, or rewritten under a new change ID).`,
      )
    }
    return why(
      "tip_divergent",
      `The tip '${tip}' is divergent: its change ID has ${changes.length} visible commits. Keep one (abandon the others with \`jj abandon <commit ID>\`).`,
    )
  }
  return new Map(tips.map((tip) => [tip, resolveTip(tip)]))
}

/** One entry resolved against the repository */
export interface Resolved {
  /** The entry's index in the file */
  index: number
  /** The top change's commit, when the tip resolves */
  tip: string | null
  /** How the tip resolved, when it does */
  tipKind: TipKind | null
  /** The entry's changes, bottom first. Empty when they could not be worked out. */
  members: Change[]
}

/**
 * Resolve the entries at `indices` (bottom first) and their changes, and find
 * every problem with them that does not need GitHub: tips that don't resolve
 * or are not in a line, entries without changes, and changes that are
 * conflicted, have no description, or have a `Pull Request:` line. Two jj
 * calls cover every entry: one for the tips, and one for the changes from
 * trunk up to them.
 */
export async function resolve(
  ctx: LocalCtx,
  file: StackFile,
  indices: number[],
): Promise<{ resolved: Resolved[]; problems: Problem[] }> {
  const tips = await resolveTips(
    ctx.repo,
    indices.map((i) => file.prs[i].tip),
  )
  const commits = [
    ...new Set([...tips.values()].flatMap((t) => ("commit" in t ? [t.commit] : []))),
  ]
  // Every change from trunk up to the tips, by commit
  const trunk = trunkRevset(ctx.config)
  const graph = new Map(
    (commits.length === 0
      ? []
      : await ctx.repo.changes(`(${trunk})..(${commits.join(" | ")})`).catch((e) => {
          if (!String(e.message).includes(`\`${trunk}\` doesn't exist`)) throw e
          throw new JjackError(
            "config",
            `The main branch, ${trunk}, is not in this repository. Run \`jj git fetch\`, or ` +
              "set jjack.mainBranch and jjack.remote to the branch that pull requests target.",
          )
        })
    ).map((change) => [change.commit, change]),
  )
  const problems: Problem[] = []
  const resolved: Resolved[] = []
  // The tip of the entry below: null for trunk, undefined when not known
  let below: { commit: string; tip: string } | null | undefined = null
  for (const index of indices) {
    const tip = file.prs[index].tip
    const entry: Resolved = { index, tip: null, tipKind: null, members: [] }
    const found = tips.get(tip)!
    if ("commit" in found) {
      entry.tip = found.commit
      entry.tipKind = found.kind
    } else problems.push({ code: found.code, tip, message: found.problem })
    if (entry.tip !== null && below !== undefined) {
      const members = await membersOf(ctx, graph, tip, entry.tip, below)
      if ("problem" in members) {
        problems.push({ code: members.code, tip, message: members.problem })
      } else {
        problems.push(...(await checkMembers(ctx, tip, members.changes)))
        entry.members = members.changes
      }
    }
    // An entry whose tip is not above the one below still has a known tip
    // for the entry above it
    below = entry.tip === null ? undefined : { commit: entry.tip, tip }
    resolved.push(entry)
  }
  return { resolved, problems }
}

/** The changes of the entry with tip `tip` (at `commit`), bottom first, down
 * to `below` or trunk. They have to be a line, each with one parent. `graph`
 * has every change from trunk up to the tips, by commit. */
async function membersOf(
  ctx: LocalCtx,
  graph: Map<string, Change>,
  tip: string,
  commit: string,
  below: { commit: string; tip: string } | null,
): Promise<{ changes: Change[] } | Why> {
  const trunk = trunkRevset(ctx.config)
  const notAbove = (below: { tip: string }): Why => ({
    code: "tips_not_in_line",
    problem: `The tips are not in a line: '${tip}' is not above '${below.tip}', the tip of the entry below it.`,
  })
  const noChanges: Why = {
    code: "no_changes",
    problem: `'${tip}' has no changes: it is already in ${trunk}.`,
  }
  if (below?.commit === commit) {
    return {
      code: "tips_not_in_line",
      problem: `'${tip}' and the entry below it, '${below.tip}', point to the same change.`,
    }
  }
  // Down the parents from the tip, while they are a line, to the tip below
  // or to trunk
  const line: Change[] = []
  let at = commit
  while (at !== below?.commit) {
    const change = graph.get(at)
    if (change === undefined || change.parents.length !== 1) break
    line.unshift(change)
    at = change.parents[0]
  }
  if (at === below?.commit) return { changes: line }
  if (!graph.has(at)) {
    // `at` is in trunk
    if (below === null) return line.length === 0 ? noChanges : { changes: line }
    // A tip below that is not in trunk is not below a change in trunk
    if (graph.has(below.commit)) return notAbove(below)
  }
  // A merge, or a tip below that is in trunk: jj's listing of the changes
  // between the two tips decides. Such an entry has a problem, or some of
  // its changes are in trunk.
  if (below !== null && !(await ctx.repo.isAncestor(below.commit, commit))) {
    return notAbove(below)
  }
  const changes = await ctx.repo.changes(`(${below?.commit ?? trunk})..${commit}`)
  if (changes.length === 0) return noChanges
  for (const [i, change] of changes.entries()) {
    const follows = i === 0 || change.parents[0] === changes[i - 1].commit
    if (change.parents.length !== 1 || !follows) {
      const what = change.parents.length !== 1 ? "is a merge" : "is on a separate branch"
      return {
        code: "not_a_line",
        problem: `The changes of '${tip}' are not in a line: ${short(change.changeId)} ${what}.`,
      }
    }
  }
  return { changes }
}

/** Problems with an entry's changes: conflicts, no description, or a
 * `Pull Request:` line */
async function checkMembers(
  ctx: LocalCtx,
  tip: string,
  members: Change[],
): Promise<Problem[]> {
  const problems: Problem[] = []
  if (members.some((m) => m.conflict)) {
    const conflicted = await ctx.repo.conflicted(members.map((m) => m.commit).join(" | "))
    problems.push({
      code: "conflicts",
      tip,
      message: `These changes of '${tip}' have conflicts:\n${conflicted}\nResolve them (for example with \`jj resolve\`).`,
    })
  }
  const ids = (changes: Change[]) => changes.map((c) => short(c.changeId)).join(", ")
  const undescribed = members.filter((m) => firstLine(m.description) === "")
  if (undescribed.length > 0) {
    problems.push({
      code: "no_description",
      tip,
      message: `These changes of '${tip}' have no description: ${ids(undescribed)}. Each change becomes a commit on the pull request's branch. Describe them with \`jj describe\`.`,
    })
  }
  const linked = members.filter((m) => hasLinkLine(m.description))
  if (linked.length > 0) {
    problems.push({
      code: "has_pull_request_line",
      tip,
      message: `These changes of '${tip}' have a \`Pull Request:\` line: ${ids(linked)}. A change is submitted with a stack file or with \`Pull Request:\` lines (\`jjack submit -r\`), not both. Remove the line with \`jj describe\`, and close the pull request it links if it is no longer needed.`,
    })
  }
  return problems
}

/**
 * The entries of the stack file at `path` and their changes, from the
 * repository alone, with the problems `resolve` finds. It needs no token or
 * GitHub, and a fixed number of jj calls covers every entry, so ah can call
 * it on every jj operation. With `classify`, each change of an entry with
 * `pushed` also has what changed since the last submit (`sincePushed`).
 */
export async function resolveStack(
  ctx: LocalCtx,
  path: string,
  options: { classify?: boolean } = {},
): Promise<LocalStack> {
  ctx = reading(ctx)
  const file = await readStackFile(path)
  const { resolved, problems } = await resolve(ctx, file, activeEntries(file))
  const entries = await localEntries(ctx, file, resolved, !!options.classify)
  return { file: path, trunk: trunkRevset(ctx.config), entries, problems }
}

/** Every entry of `file`, with the commits and changes of the ones in
 * `resolved` and their earlier versions. One jj call finds the earlier
 * versions of every entry. */
export async function localEntries(
  ctx: LocalCtx,
  file: StackFile,
  resolved: Resolved[],
  classify: boolean,
): Promise<LocalEntry[]> {
  const pushed = resolved.flatMap(({ index }) => {
    const commit = file.prs[index].pushed
    return commit !== undefined && /^[0-9a-f]{40}$/.test(commit) ? [commit] : []
  })
  // The pushed commits still in the repository, hidden ones too, and their
  // ancestors down to trunk
  const ids = pushed.map((commit) => `commit_id(${commit})`).join(" | ")
  const old = new Map(
    (pushed.length === 0
      ? []
      : await ctx.repo.changes(`(${ids}) | (::(${ids}) ~ ::(${trunkRevset(ctx.config)}))`)
    ).map((change) => [change.commit, change]),
  )
  return Promise.all(
    file.prs.map(async (entry, index): Promise<LocalEntry> => {
      const found = resolved.find((r) => r.index === index)
      const local: LocalEntry = {
        tip: entry.tip,
        merged: !!entry.merged,
        commit: found?.tip ?? null,
        tipKind: found?.tipKind ?? null,
        pushed:
          found !== undefined && entry.pushed !== undefined && old.has(entry.pushed)
            ? entry.pushed
            : null,
        members: [],
      }
      // The earlier version of each change: the first with its change ID on
      // the way down from the pushed commit
      const before = new Map<string, Change>()
      const seen = new Set<string>()
      const todo = local.pushed === null ? [] : [local.pushed]
      for (let at = todo.pop(); at !== undefined; at = todo.pop()) {
        const change = old.get(at)
        if (change === undefined || seen.has(at)) continue
        seen.add(at)
        if (!before.has(change.changeId)) before.set(change.changeId, change)
        todo.push(...change.parents)
      }
      local.members = await Promise.all(
        (found?.members ?? []).map(async (member) => {
          const earlier = before.get(member.changeId)
          const change: LocalChange = {
            commit: member.commit,
            changeId: member.changeId,
            title: firstLine(member.description),
            pushedCommit: earlier?.commit ?? null,
          }
          if (classify && entry.pushed !== undefined) {
            change.sincePushed =
              local.pushed === null
                ? "unknown"
                : await sincePushed(ctx.repo, earlier, member)
          }
          return change
        }),
      )
      return local
    }),
  )
}

/** What changed in `member` since `before`, its earlier version among the
 * ancestors of the commit `submit` last pushed. A change on a new parent with
 * the same diff is unchanged. */
async function sincePushed(
  repo: Repo,
  before: Change | undefined,
  member: Change,
): Promise<SincePushed> {
  if (before === undefined) return "new"
  if (before.commit === member.commit) return "unchanged"
  if (before.parents.length !== 1) return "edited"
  const [oldParent, newParent, oldTree, newTree] = await Promise.all([
    repo.tree(before.parents[0]),
    repo.tree(member.parents[0]),
    repo.tree(before.commit),
    repo.tree(member.commit),
  ])
  // Each diff, applied to the other's parent, gives the other's tree
  const sameDiff =
    (await repo.mergeTrees(oldParent, newParent, oldTree)) === newTree &&
    (await repo.mergeTrees(newParent, oldParent, newTree)) === oldTree
  if (!sameDiff) return "edited"
  return before.description !== member.description ? "reworded" : "unchanged"
}
