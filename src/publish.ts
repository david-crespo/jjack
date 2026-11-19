// The push core: plan and publish a line of planned pull requests, bottom
// first. Planning is read-only (besides fetching remote branches) and decides
// what each pull request needs; `status` and dry runs stop after planning,
// while a real run executes the plan without force-pushing.

import type { Ctx } from "./context.ts"
import {
  JjackError,
  toJjackError,
  type Change,
  type GitHubStack,
  type Planned,
  type PullRequest,
  type PullRequestResult,
  type Source,
  type StackChange,
  type SubmitResult,
  type Text,
  type TextParts,
} from "./model.ts"
import {
  activePullRequests,
  chainSegments,
  planStackUpdates,
  planUnstacks,
  type PlannedBase,
  type StackAction,
} from "./stacks.ts"
import {
  descriptionText,
  differingParts,
  firstLine,
  formatPrList,
  githubText,
  hintsFor,
  newBranchName,
  pullRequestUrl,
} from "./text.ts"

export interface PushOptions {
  /** The message of the last commit of each update of an existing pull
   * request, in place of `Update` or `Merge …`. Commits of a pull request's
   * changes keep their descriptions. */
  message?: string
  draft?: boolean
  dryRun?: boolean
  discardRemoteChanges?: boolean
}

/** Where `executePublish` records what it did */
export interface PublishRecord {
  /** Created, updated, or found up to date */
  published(index: number, tipCommit: string, number: number): Promise<void>
  /** Publishing finished, or stopped at an error */
  finish(): Promise<void>
}

/** What `executeOne` published, and the commit the next one builds on */
interface Published {
  result: PullRequestResult
  oid: string
}

/** The trees a planned pull request's branch and base should have */
interface Trees {
  head: string
  base: string
}

/** One entry of a line of pull requests to plan */
export interface PlanEntryInput {
  changes: Change[]
  pullRequest: PullRequest | null
  /** The pull request's branch, or null for a new one whose branch has no name yet */
  branch: string | null
  /** The text the pull request should have, or null when it is not known */
  text: Text | null
}

/** What publishing one entry needs to do, computed without changing anything */
export type EntryPlan = {
  updates: PullRequestResult["updates"]
  /** The parts of an existing pull request's text that differ from GitHub's */
  text: TextParts | null
  trees: Trees
  /** Expected base branch name, or null when the entry below has none yet */
  expectedBase: string | null
} & (
  | { action: "create" }
  /** `head` is the local head of the pull request's branch */
  | { action: "none"; pr: PullRequest; head: string }
  | { action: "update"; pr: PullRequest; head: string; needsMergingMain: boolean }
  /** An update of a pull request whose head is not present locally, which
   * `status` can describe but `submit` can't make */
  | { action: "update"; pr: PullRequest; head: null }
)

/** One planned pull request in a full `PublishPlan` */
interface PlannedEntry {
  planned: Planned
  branch: string
  baseBranch: string
  plan: Exclude<EntryPlan, { head: null }>
  /** Temporarily pointed at main before pushing, so GitHub does not mark it
   * merged mid-reorder */
  retargetBeforePush: boolean
}

/** A complete read-only publish plan ready for dry-run reporting or execution */
export interface PublishPlan {
  masterBase: string
  /** GitHub stacks before the run, or null when stacks are not enabled */
  stacks: GitHubStack[] | null
  /** Stack numbers to dissolve before pushing */
  toDissolve: number[]
  entries: PlannedEntry[]
}

/** The merge base of two commits, which every caller here needs to exist */
async function mergeBase(ctx: Ctx, a: string, b: string): Promise<string> {
  const base = await ctx.repo.mergeBase(a, b)
  if (base === null) throw new JjackError("git", `${a} and ${b} have no common ancestor`)
  return base
}

/**
 * Plan publishing `entries`, a line of pull requests bottom first, against the
 * fetched remote branch OIDs `refs`, without changing anything. `masterBase` is
 * the merge base of the bottom entry and main. Null when there are no entries
 * or the bottom one has no common ancestor with main.
 */
export async function planEntries(
  ctx: Ctx,
  entries: PlanEntryInput[],
  refs: Map<string, string | null>,
): Promise<{ masterBase: string; plans: EntryPlan[] } | null> {
  if (entries.length === 0) return null
  const main = await ctx.repo.main(ctx.config)
  const masterBase = await ctx.repo.mergeBase(entries[0].changes.at(-1)!.commit, main)
  if (masterBase === null) return null
  const plans: EntryPlan[] = []
  for (const [i, entry] of entries.entries()) {
    const expectedBase = i === 0 ? ctx.config.main : entries[i - 1].branch
    const below = plans.at(-1) ?? null
    plans.push(await planEntry(ctx, entry, below, expectedBase, refs, main, masterBase))
  }
  return { masterBase, plans }
}

/** Plan one entry of `planEntries`, given the plan of the entry below it */
async function planEntry(
  ctx: Ctx,
  entry: PlanEntryInput,
  below: EntryPlan | null,
  expectedBase: string | null,
  refs: Map<string, string | null>,
  main: string,
  masterBase: string,
): Promise<EntryPlan> {
  const { repo } = ctx
  const trees: Trees = {
    head: await repo.tree(entry.changes.at(-1)!.commit),
    base: await repo.tree(entry.changes[0].parents[0]),
  }
  const pr = entry.pullRequest
  if (pr === null) return { action: "create", updates: [], text: null, trees, expectedBase }

  const text = entry.text ? differingParts(entry.text, githubText(pr)) : null
  const existing = { pr, text, trees, expectedBase }
  const retarget = pr.base !== expectedBase
  const head = refs.get(pr.head) ?? null
  if (head === null || (await repo.treeIfPresent(head)) === null) {
    const updates: EntryPlan["updates"] = retarget ? ["push", "retarget"] : ["push"]
    return { ...existing, action: "update", updates, head: null }
  }

  const headTree = await repo.tree(head)
  const prBaseTree = await repo.tree(await mergeBase(ctx, head, refs.get(pr.base) ?? main))
  const needsMergingMain = (await mergeBase(ctx, head, main)) !== masterBase

  // Whether an update merges in the commit below. A pull request must already
  // contain the head of the one below. If the entry below will move, its new
  // head will not be in `head`, so this one will need a merge. At the bottom,
  // main is merged in when the base or main moved or the base branch changes.
  const merge =
    below === null
      ? prBaseTree !== trees.base || needsMergingMain || retarget
      : below.action !== "none" || !(await repo.isAncestor(below.head, head))
  if (
    !merge &&
    !needsMergingMain &&
    !retarget &&
    headTree === trees.head &&
    prBaseTree === trees.base
  ) {
    return { ...existing, action: "none", updates: [], head }
  }

  // Its own changes were edited unless the pull request's diff, moved onto
  // the local base, gives the local tree
  const updates: EntryPlan["updates"] = []
  if ((await repo.mergeTrees(prBaseTree, trees.base, headTree)) !== trees.head) {
    updates.push("push")
  }
  if (merge) updates.push("merge")
  if (retarget) updates.push("retarget")
  return { ...existing, action: "update", updates, head, needsMergingMain }
}

/**
 * Check preconditions and build a complete read-only `PublishPlan` for
 * `planned`, a line of pull requests bottom first.
 */
export async function planPublish(
  ctx: Ctx,
  source: Source,
  planned: Planned[],
  options: Pick<PushOptions, "discardRemoteChanges">,
): Promise<PublishPlan> {
  const { repo, gh, config } = ctx
  const pullRequests = planned.map((p) => p.pullRequest)

  // Fetch the branches of open pull requests in one deduplicated batch so
  // everything below compares against the heads as GitHub reports them.
  const refs = await repo.fetchBranches(
    pullRequests.flatMap((pr) => (pr?.state === "open" ? [pr.head, pr.base] : [])),
  )
  const localRef = (branch: string) => refs.get(branch) ?? null
  for (const pr of pullRequests) {
    const headOid = pr === null ? null : localRef(pr.head)
    if (pr?.state === "open" && pr.headOid !== null && pr.headOid !== headOid) {
      throw new JjackError(
        "head_not_fetched",
        `Could not fetch the current head of pull request #${pr.number} (GitHub reports ` +
          `${pr.headOid}, the local copy of ${pr.head} is ${headOid ?? "missing"}). ` +
          "Run `jj git fetch` and try again.",
        { pr: pr.number },
      )
    }
  }

  // Pushing replaces a pull request's content with the local change's, so
  // stop before changing anything if that would drop someone else's work
  if (!options.discardRemoteChanges) {
    const changedRemotely: number[] = []
    for (const [i, pr] of pullRequests.entries()) {
      if (
        pr?.state === "open" &&
        (await hasRemoteChanges(ctx, planned[i], localRef(pr.head), localRef(pr.base)))
      ) {
        changedRemotely.push(pr.number)
      }
    }
    if (changedRemotely.length > 0) {
      const one = changedRemotely.length === 1
      throw new JjackError(
        "remote_changes",
        `${formatPrList(changedRemotely)} ${one ? "has" : "have"} commits that are not in ` +
          `the local change${one ? "" : "s"} (someone else pushed to ${one ? "it" : "them"}). ` +
          "Bring the edits you want into your changes (the pull request's commits are on " +
          "GitHub), or pass --discard-remote-changes to replace them with your version.",
        one ? { pr: changedRemotely[0] } : {},
      )
    }
  }

  const taken = await takenBranchNames(ctx, pullRequests)

  // GitHub refuses to change the base of a pull request in a stack. Work out
  // which stacks this run invalidates; they are dissolved before anything is
  // retargeted and rebuilt once every pull request is published. A stack with
  // members this run does not publish cannot be rebuilt, so that stops it.
  const stacks = await gh.listStacks()
  const toDissolve =
    stacks === null ? [] : planUnstacks(stacks, plannedBases(ctx, pullRequests))
  const midReorder = await findMidReorderRetargets(ctx, pullRequests, refs)

  const branches = planned.map((p) => {
    if (p.pullRequest !== null) return p.pullRequest.head
    const branch = newBranchName(config, taken, p.text.title)
    taken.add(branch)
    return branch
  })
  const line = await planEntries(
    ctx,
    planned.map((p, i) => ({ ...p, branch: branches[i] })),
    refs,
  )
  if (line === null) {
    const top = planned[0].changes.at(-1)!.commit
    throw new JjackError(
      "git",
      `${top} and ${await repo.main(config)} have no common ancestor`,
    )
  }

  // Stop if GitHub already moved a pull request onto a newer main (e.g.
  // "Update branch" or the stack's rebase button): pushing from an older base
  // would revert the commits that landed on main in between.
  const main = await repo.main(config)
  const behindMain: number[] = []
  for (const plan of line.plans) {
    if (plan.action === "update" && plan.head !== null && plan.needsMergingMain) {
      const remoteMain = await repo.mergeBase(plan.head, main)
      if (
        remoteMain !== null &&
        remoteMain !== line.masterBase &&
        (await repo.isAncestor(line.masterBase, remoteMain))
      ) {
        behindMain.push(plan.pr.number)
      }
    }
  }
  if (behindMain.length > 0) {
    const hints = hintsFor(source)
    const one = behindMain.length === 1
    throw new JjackError(
      "needs_sync",
      `${formatPrList(behindMain)} ${one ? "is" : "are"} already on a newer ${config.main} on GitHub than the local stack. ` +
        `Pushing from the older base would revert commits on ${config.main}. ` +
        `Run \`${hints.sync}\` to rebase the local stack, then run \`${hints.submit}\` again.`,
      {
        fix: [hints.sync, hints.submit],
        ...(one ? { pr: behindMain[0] } : {}),
      },
    )
  }

  const entries = line.plans.map((plan, i): PlannedEntry => {
    if (plan.action === "update" && plan.head === null) {
      throw new JjackError(
        "head_not_fetched",
        `Could not fetch the head of pull request #${plan.pr.number} (the local copy of ` +
          `${plan.pr.head} is missing). Run \`jj git fetch\` and try again.`,
        { pr: plan.pr.number },
      )
    }
    return {
      planned: planned[i],
      branch: branches[i],
      // Every entry here has a branch, so every one has an expected base
      baseBranch: plan.expectedBase!,
      plan,
      retargetBeforePush: plan.action !== "create" && midReorder.has(plan.pr.number),
    }
  })
  return { masterBase: line.masterBase, stacks, toDissolve, entries }
}

/**
 * Publish `planned`, a line of pull requests, bottom first: the bottom one's
 * bottom change sits on the main branch, and each other one's bottom change
 * sits on the top change of the one below. A dry run stops after planning.
 * An error after the checks has the result so far as its `partial`.
 */
export async function publish(
  ctx: Ctx,
  source: Source,
  planned: Planned[],
  options: PushOptions,
  record: PublishRecord,
): Promise<SubmitResult> {
  const plan = await planPublish(ctx, source, planned, options)
  if (options.dryRun) return reportDryRun(ctx, plan, options)
  return executePublish(ctx, plan, options, record)
}

function entryResult(
  ctx: Ctx,
  entry: PlannedEntry,
  number: number | null,
  headOid: string | null,
): PullRequestResult {
  const { planned, branch, baseBranch, plan } = entry
  return {
    label: planned.label,
    number,
    url: number === null ? null : pullRequestUrl(ctx.config, number),
    action: plan.action,
    updates: plan.updates,
    text: plan.text,
    title: planned.text.title,
    commit: planned.changes.at(-1)!.commit,
    head: branch,
    base: baseBranch,
    headOid,
  }
}

/** Print what a dry run would do and return its `SubmitResult`. Changes nothing. */
async function reportDryRun(
  ctx: Ctx,
  plan: PublishPlan,
  options: Pick<PushOptions, "draft">,
): Promise<SubmitResult> {
  const { config, out } = ctx
  const result: SubmitResult = { dryRun: true, pullRequests: [], stacks: [] }

  for (const stack of plan.toDissolve) {
    const members = activePullRequests(plan.stacks!.find((s) => s.number === stack)!)
    out.line("🧱", `Would dissolve GitHub stack #${stack} to rebuild it`)
    result.stacks.push({ kind: "dissolve", stack, pullRequests: members })
  }

  for (const entry of plan.entries) {
    const number = entry.plan.action === "create" ? null : entry.plan.pr.number
    if (number !== null)
      out.line("#️⃣", `Pull request #${number}: ${pullRequestUrl(config, number)}`)
    if (entry.plan.action === "none") {
      out.line("✅", "No update necessary")
      if (entry.plan.text !== null) {
        out.line("  ", `Would update the ${entry.plan.text} of #${number} on GitHub`)
      }
    }
    const headOid = entry.plan.action === "none" ? entry.plan.head : null
    result.pullRequests.push(entryResult(ctx, entry, number, headOid))
  }

  const remainingStacks = async () =>
    plan.stacks?.filter((s) => !plan.toDissolve.includes(s.number)) ?? null
  for (const action of await stackUpdates(ctx, result.pullRequests, remainingStacks)) {
    if (action.kind === "warn") {
      out.warn(action.message)
      continue
    }
    const list = formatPrList(action.pullRequests)
    out.line(
      "🧱",
      action.kind === "create"
        ? `Would create a GitHub stack: ${list}`
        : action.kind === "add"
          ? `Would add ${list} to GitHub stack #${action.stack}`
          : `Would dissolve GitHub stack #${action.stack}, which ends with a closed pull request, and create one of ${list}`,
    )
    const stack = action.kind === "add" ? action.stack : null
    result.stacks.push({ kind: action.kind, stack, pullRequests: action.pullRequests })
  }

  const actions = result.pullRequests.flatMap((pr, i) =>
    pr.action === "none" && pr.text === null ? [] : [{ pr, i }],
  )
  out.raw("")
  out.line("📋", `Dry run complete. Would process ${actions.length} change(s):`)
  out.raw("")
  for (const { pr, i } of actions) {
    const what =
      pr.action === "none"
        ? `UPDATE PR #${pr.number} (${pr.text})`
        : pr.action === "update"
          ? `UPDATE PR #${pr.number}`
          : options.draft
            ? "CREATE (draft)"
            : "CREATE"
    out.line(`#${i + 1}`, `${what}  ${pr.commit.slice(0, 7)}  "${pr.title}"`)
    out.line("     ", `head: ${pr.head}`)
    out.line("     ", `base: ${pr.base}`)
    out.raw("")
  }
  return result
}

/** Execute a `PublishPlan`: dissolve invalidated stacks, push and update or
 * create each pull request, record each one, and register stacks. */
async function executePublish(
  ctx: Ctx,
  plan: PublishPlan,
  options: PushOptions,
  record: PublishRecord,
): Promise<SubmitResult> {
  const { gh, config, out } = ctx
  const result: SubmitResult = { dryRun: false, pullRequests: [], stacks: [] }
  let error: JjackError | null = null
  const published: Published[] = []
  try {
    for (const stack of plan.toDissolve) {
      const members = activePullRequests(plan.stacks!.find((s) => s.number === stack)!)
      out.line("🧱", `Dissolving GitHub stack #${stack} to rebuild it`)
      await gh.unstack(stack)
      result.stacks.push({ kind: "dissolve", stack, pullRequests: members })
    }

    for (const { plan: entryPlan, retargetBeforePush } of plan.entries) {
      if (!retargetBeforePush || entryPlan.action === "create") continue
      out.line(
        "↪️",
        `Pointing #${entryPlan.pr.number} at ${config.main} until its update, so that GitHub does not mark it merged`,
      )
      await gh.updatePullRequest(entryPlan.pr.number, { base: config.main })
    }

    for (const [index, entry] of plan.entries.entries()) {
      const top = entry.planned.changes.at(-1)!
      out.raw(`${top.commit.slice(0, 7)} ${firstLine(top.description)}`)
      const one = await executeOne(
        ctx,
        options,
        entry,
        plan.masterBase,
        published.at(-1) ?? null,
      )
      published.push(one)
      result.pullRequests.push(one.result)
      await record.published(index, top.commit, one.result.number!)
    }

    result.stacks.push(...(await registerStacks(ctx, result.pullRequests)))
  } catch (e) {
    error = toJjackError(e)
  }
  try {
    await record.finish()
  } catch (e) {
    const finishError = toJjackError(e)
    if (error === null) error = finishError
    else for (const message of finishError.messages) error.context(message)
  }
  if (error !== null) {
    error.partial = result
    throw error
  }
  return result
}

/** Each pull request's base before and after this run, for deciding which
 * GitHub stacks survive it */
function plannedBases(ctx: Ctx, pullRequests: (PullRequest | null)[]): PlannedBase[] {
  return pullRequests.map((pr, i) => ({
    number: pr?.number ?? null,
    currentBase: pr?.base ?? null,
    expectedBase: i === 0 ? ctx.config.main : (pullRequests[i - 1]?.head ?? null),
  }))
}

/**
 * GitHub marks a pull request merged once its head is in its base branch.
 * After a reorder, a pull request's new head can contain the old head of a
 * dependent one that is updated later: moving C below A and B puts B's old
 * head (already in C's branch) into A's branch while B still targets A. Return
 * the numbers of those dependent pull requests so execution can point them at
 * main until their own update sets their new base.
 */
async function findMidReorderRetargets(
  ctx: Ctx,
  pullRequests: (PullRequest | null)[],
  refs: Map<string, string | null>,
): Promise<Set<number>> {
  const { repo } = ctx
  const numbers = new Set<number>()
  for (const [i, pr] of pullRequests.entries()) {
    if (pr === null) continue
    for (const dependent of pullRequests.slice(i + 1)) {
      const depHead = dependent === null ? null : (refs.get(dependent.head) ?? null)
      if (dependent?.base !== pr.head || depHead === null) continue
      let contained = false
      for (const below of pullRequests.slice(0, i)) {
        const belowHead = below === null ? null : (refs.get(below.head) ?? null)
        if (belowHead && (await repo.isAncestor(depHead, belowHead))) {
          contained = true
        }
      }
      if (contained) numbers.add(dependent.number)
    }
  }
  return numbers
}

/**
 * Whether a pull request has edits that its local changes lack, so that
 * pushing them would drop the edits. Edits made locally since the last push
 * must not count, so this is not a plain comparison of trees. The pull
 * request is fine if the local change contains its diff, or if its diff is
 * that of a version of the local change from `jj evolog` (the one last
 * pushed: after a stacked merge GitHub rebases that onto a new base, so the
 * trees can differ). It is also fine if the local parent contains the diff:
 * GitHub's stack rebase can leave a branch holding only the content of the
 * pull request below it, which the local change need not contain (it may
 * undo some of it), but which pushing does not lose.
 */
async function hasRemoteChanges(
  ctx: Ctx,
  planned: Planned,
  headOid: string | null,
  baseOid: string | null,
): Promise<boolean> {
  const { repo } = ctx
  if (headOid === null) return false
  const headTree = await repo.treeIfPresent(headOid)
  if (headTree === null) return false
  const forkPoint = await mergeBase(ctx, headOid, baseOid ?? (await repo.main(ctx.config)))
  const forkTree = await repo.tree(forkPoint)
  const top = planned.changes.at(-1)!.commit
  if (await repo.treeContainsDiff(await repo.tree(top), forkTree, headTree)) return false
  const parentTree = await repo.tree(planned.changes[0].parents[0])
  if (await repo.treeContainsDiff(parentTree, forkTree, headTree)) return false
  for (const version of await repo.evolog(top)) {
    const tree = await repo.tree(version)
    if (tree === headTree) return false
    const parent = await repo.treeIfPresent(`${version}^`)
    if (parent === null) continue
    if (
      (await repo.treeContainsDiff(headTree, parent, tree)) &&
      (await repo.treeContainsDiff(tree, forkTree, headTree))
    ) {
      return false
    }
  }
  return true
}

/** The branch names a new pull request's branch must not take: those with
 * the prefix on GitHub and in this repository, and those of the existing pull
 * requests. Empty when every pull request exists. */
async function takenBranchNames(
  ctx: Ctx,
  pullRequests: (PullRequest | null)[],
): Promise<Set<string>> {
  if (pullRequests.every((pr) => pr !== null)) return new Set()
  const [onGithub, tracking] = await Promise.all([
    ctx.repo.remoteHeads([`refs/heads/${ctx.config.branchPrefix}*`]),
    ctx.repo.remoteTrackingBranches(),
  ])
  return new Set([
    ...onGithub.keys(),
    ...tracking,
    ...pullRequests.flatMap((pr) => (pr ? [pr.head] : [])),
  ])
}

/** The title and body to change on an existing pull request, comparing against
 * GitHub's normalized strings */
function textUpdate(planned: Planned, pr: PullRequest): { title?: string; body?: string } {
  const current = githubText(pr)
  return {
    ...(planned.text.title !== current.title ? { title: planned.text.title } : {}),
    ...(planned.text.body !== current.body ? { body: planned.text.body } : {}),
  }
}

/**
 * The tree GitHub's rebase of a stacked pull request would give the branch at
 * `head` on a base at `base`: the branch's non-merge commits that are not in
 * `base`, oldest first, replayed onto `base`. null when one conflicts.
 */
async function replayedTree(ctx: Ctx, head: string, base: string): Promise<string | null> {
  let tree: string | null = await ctx.repo.tree(base)
  for (const commit of await ctx.repo.nonMergeCommits(head, base)) {
    tree = await ctx.repo.mergeTrees(await ctx.repo.tree(commit.parent), tree, commit.tree)
    if (tree === null) return null
  }
  return tree
}

/** Execute one planned entry on top of `parent`, the one published just below
 * it (null for the bottom one) */
async function executeOne(
  ctx: Ctx,
  options: PushOptions,
  entry: PlannedEntry,
  masterBase: string,
  parent: Published | null,
): Promise<Published> {
  const { repo, gh, config, out } = ctx
  const { planned: p, branch, baseBranch, plan } = entry
  const top = p.changes.at(-1)!
  if (plan.action !== "create") {
    out.line(
      "#️⃣",
      `Pull request #${plan.pr.number}: ${pullRequestUrl(config, plan.pr.number)}`,
    )
  }

  if (plan.action === "none") {
    out.line("✅", "No update necessary")
    if (plan.text !== null) {
      await gh.updatePullRequest(plan.pr.number, textUpdate(p, plan.pr))
      out.line("✍", `Updated the ${plan.text} of #${plan.pr.number} on GitHub`)
    }
    return { result: entryResult(ctx, entry, plan.pr.number, plan.head), oid: plan.head }
  }

  // The commit below: the new head of the pull request below, or the bottom's
  // merge base with main. A new pull request starts on it. An update merges it
  // in when it needs changes to the local changes' parent. Merging the head of
  // the branch below keeps GitHub's diff, which is against the merge base, down
  // to this pull request's changes.
  const below = parent?.oid ?? masterBase
  let parents = plan.action === "create" ? [below] : [plan.head]
  if (plan.action === "update" && plan.updates.includes("merge") && below !== plan.head) {
    parents.push(below)
  }
  const mergeMessage =
    parent === null
      ? `Merge ${config.main}`
      : `Merge #${parent.result.number} (${parent.result.head})`

  // After a stacked merge, GitHub rebases the remaining pull requests by
  // replaying the non-merge commits of each branch that are not on its old
  // base, and drops merge commits. A pull request left with nothing to replay
  // is reset to its base and closed. So an update has to leave the changes in
  // non-merge commits. When the old head is in the new head, as for a pull
  // request that moved above the one that had its commits, the update goes
  // straight onto the new head; when the new head is in the old one, onto the
  // old head. Otherwise the merge commit gets the tree that replaying the
  // branch's non-merge commits onto the new head would give, and an ordinary
  // commit on top brings it to the local tree. When the replay gives the local
  // tree, or conflicts, the update stays one merge commit.
  if (parents.length === 2) {
    const [oldHead, newHead] = parents
    if (await repo.isAncestor(oldHead, newHead)) parents = [newHead]
    else if (await repo.isAncestor(newHead, oldHead)) parents = [oldHead]
    else {
      const replayed = await replayedTree(ctx, oldHead, newHead)
      if (replayed !== null && replayed !== plan.trees.head) {
        parents = [await repo.commitTree(top.commit, mergeMessage, replayed, parents)]
      }
    }
  }

  // A pull request of several changes gets a commit for each change when its
  // branch has the tree of the base or of one of its changes: one for each
  // change above that one. Otherwise it gets one commit with the top tree.
  let steps: { commit: string; description: string; tree: string }[] = []
  if (p.changes.length > 1 && parents.length === 1) {
    const changeTrees = await Promise.all(p.changes.map((c) => repo.tree(c.commit)))
    const done = [plan.trees.base, ...changeTrees].lastIndexOf(await repo.tree(parents[0]))
    if (done !== -1) {
      steps = p.changes.slice(done).map((c, i) => ({ ...c, tree: changeTrees[done + i] }))
    }
  }

  let newHead: string
  if (steps.length > 0) {
    for (const step of steps) {
      const { title, body } = descriptionText(step.description)
      const stepMessage = body === "" ? title : `${title}\n\n${body}`
      parents = [await repo.commitTree(step.commit, stepMessage, step.tree, parents)]
    }
    newHead = parents[0]
  } else {
    // A new pull request's commit is named for its change. An update's last
    // commit is a merge, or brings the branch to the local tree.
    const message =
      plan.action === "create"
        ? firstLine(top.description)
        : (options.message ?? (parents.length === 2 ? mergeMessage : "Update"))
    newHead = await repo.commitTree(top.commit, message, plan.trees.head, parents)
  }

  if (plan.action === "update") {
    const { pr, needsMergingMain } = plan
    out.line(
      needsMergingMain ? "⚾" : "🔁",
      `Commit was ${needsMergingMain ? "rebased" : "changed"} - updating pull request #${pr.number}`,
    )
    const update: { title?: string; body?: string; base?: string } = textUpdate(p, pr)
    await repo.push(newHead, branch)
    // Retarget it if the pull request below changed, it was temporarily
    // pointed at main mid-reorder, or it has none any more
    const currentBase = entry.retargetBeforePush ? config.main : pr.base
    if (currentBase !== baseBranch) update.base = baseBranch
    if (Object.keys(update).length > 0) {
      try {
        await gh.updatePullRequest(pr.number, update)
      } catch (e) {
        if (update.base === undefined) throw e
        throw toJjackError(e).context(
          "GitHub does not allow changing the base of a pull request in a stack. Run submit " +
            "for the whole stack so jjack can rebuild it.",
        )
      }
    }
    return { result: entryResult(ctx, entry, pr.number, newHead), oid: newHead }
  }

  // The base, the branch below or main, is on GitHub already
  await repo.push(newHead, branch)
  let number: number
  try {
    number = await gh.createPullRequest({
      title: p.text.title,
      body: p.text.body,
      base: baseBranch,
      head: branch,
      draft: !!options.draft,
    })
  } catch (e) {
    throw toJjackError(e).context(
      `The branch ${branch} was pushed and has no pull request. A rerun uses a new branch ` +
        `name; delete this one with \`git push ${config.remote} --delete ${branch}\`.`,
    )
  }
  out.line("✨", `Created new pull request #${number}: ${pullRequestUrl(config, number)}`)
  return { result: entryResult(ctx, entry, number, newHead), oid: newHead }
}

/** Register the published chains of pull requests as GitHub stacks, and
 * return what changed. The pull requests are correct by now, so a problem here
 * is a warning. */
async function registerStacks(
  ctx: Ctx,
  published: PullRequestResult[],
): Promise<StackChange[]> {
  const { gh, out } = ctx
  const changes: StackChange[] = []
  const warn = (what: string, e: unknown) =>
    out.warn([what, ...toJjackError(e).messages].join("\n"))
  for (const action of await stackUpdates(ctx, published, () => gh.listStacks())) {
    if (action.kind === "warn") {
      out.warn(action.message)
      continue
    }
    const list = formatPrList(action.pullRequests)
    const pullRequests = action.pullRequests as number[]
    if (action.kind === "create") {
      try {
        const stack = await gh.createStack(pullRequests)
        out.line("🧱", `Created GitHub stack #${stack.number}: ${list}`)
        changes.push({ kind: "create", stack: stack.number, pullRequests })
      } catch (e) {
        warn("Creating the GitHub stack failed", e)
      }
    } else if (action.kind === "add") {
      try {
        await gh.addToStack(action.stack, pullRequests)
        out.line("🧱", `Added ${list} to GitHub stack #${action.stack}`)
        changes.push({ kind: "add", stack: action.stack, pullRequests })
      } catch (e) {
        warn(`Adding to GitHub stack #${action.stack} failed`, e)
      }
    } else {
      out.line(
        "🧱",
        `Dissolving GitHub stack #${action.stack}, which ends with a closed pull request, to rebuild it`,
      )
      try {
        await gh.unstack(action.stack)
        const stack = await gh.createStack(pullRequests)
        out.line("🧱", `Created GitHub stack #${stack.number}: ${list}`)
        changes.push({ kind: "rebuild", stack: stack.number, pullRequests })
      } catch (e) {
        warn("Rebuilding the GitHub stack failed", e)
      }
    }
  }
  return changes
}

/** The updates that register the chains of `published` as GitHub stacks,
 * given the stacks `listStacks` returns. Empty when there are no chains.
 * When stacks are not enabled (null from `listStacks`), it prints a notice
 * and returns none. */
async function stackUpdates(
  ctx: Ctx,
  published: PullRequestResult[],
  listStacks: () => Promise<GitHubStack[] | null>,
): Promise<StackAction[]> {
  const { config, out } = ctx
  const segments = chainSegments(published)
  if (segments.length === 0) return []
  const stacks = await listStacks()
  if (stacks === null) {
    out.line(
      "ℹ️",
      `Stacked pull requests are not enabled for ${config.owner}/${config.repo}; the pull ` +
        "requests target each other but are not registered as a GitHub stack.",
    )
    return []
  }
  return planStackUpdates(
    stacks,
    segments.map((segment) => segment.map((l) => l.number)),
  )
}
