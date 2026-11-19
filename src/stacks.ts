// Planning for GitHub's native stacks, without talking to GitHub.
//
// GitHub's Stacks API registers a chain of pull requests in which every pull
// request's base branch is the head branch of the one below it. These
// functions decide which stacks have to be dissolved before a run retargets
// pull requests (GitHub refuses to change the base of a stacked pull request)
// and which stacks to create or extend afterwards.
//
// Translated from `spr/src/stacks.rs` on papertigers/jj-spr's `native-stacks`
// branch (Mike Zeller).

import { JjackError, type GitHubStack } from "./model.ts"
import { formatPrList } from "./text.ts"

/** A pull request's number, or null for one a dry run would create */
type PrNumber = number | null

/** Merged and closed members stay listed in a stack as history */
const isActive = (member: GitHubStack["pull_requests"][number]) =>
  member.merged_at == null && (member.state ?? "open") === "open"

/** The open members of a stack, bottom first */
export const activePullRequests = (stack: GitHubStack) =>
  stack.pull_requests.filter(isActive).map((member) => member.number)

/** The stack that has pull request `number` as an active member */
export const stackContaining = (
  stacks: GitHubStack[],
  number: number,
): GitHubStack | null =>
  stacks.find((stack) => activePullRequests(stack).includes(number)) ?? null

/** One pull request of a run, bottom first, as it is about to be published */
export interface PlannedBase {
  /** null for a new one */
  number: number | null
  /** Its base on GitHub now, for an existing one */
  currentBase: string | null
  /** Its base after this run. null when that is a new pull request's branch. */
  expectedBase: string | null
}

/** Whether `needle` is in `haystack` as one contiguous run */
function isContiguousRun(haystack: PrNumber[], needle: PrNumber[]): boolean {
  if (needle.length === 0) return true
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    if (needle.every((n, j) => haystack[i + j] === n)) return true
  }
  return false
}

/**
 * The stacks to dissolve before the run publishes. A stack survives when its
 * members in the run keep their bases and order. Otherwise it is dissolved
 * and rebuilt afterwards, which is only possible when every open member is in
 * the run. Throws when one is not.
 */
export function planUnstacks(stacks: GitHubStack[], selection: PlannedBase[]): number[] {
  const selected = selection.flatMap((pr) => (pr.number === null ? [] : [pr.number]))
  const toDissolve: number[] = []
  for (const stack of stacks) {
    const active = activePullRequests(stack)
    const members = selection.filter(
      (pr) => pr.number !== null && active.includes(pr.number),
    )
    if (members.length === 0) continue
    const basesUnchanged = members.every(
      (pr) => pr.expectedBase !== null && pr.currentBase === pr.expectedBase,
    )
    const sameOrder = isContiguousRun(
      active,
      members.map((pr) => pr.number!),
    )
    if (basesUnchanged && sameOrder) continue

    const outside = active.filter((n) => !selected.includes(n))
    if (outside.length > 0) {
      const rebased = members
        .filter((pr) => pr.currentBase !== pr.expectedBase)
        .map(
          (pr) =>
            `#${pr.number} from ${pr.currentBase ?? ""} to ${pr.expectedBase ?? "the branch of a new pull request"}`,
        )
      const reason =
        rebased.length === 0
          ? "the order of its pull requests changes"
          : "GitHub does not allow changing the base of a stacked pull request, and this " +
            `run changes the base of ${rebased.join(", ")}`
      throw new JjackError(
        "stack_rebuild_incomplete",
        `Not submitting: GitHub stack #${stack.number} has to be rebuilt, because ${reason}. ` +
          `The stack also contains ${formatPrList(outside)}, which this run would not ` +
          "update. Run submit for the whole stack (without --upto, or with -r at its top " +
          "change) so every member is republished.",
      )
    }
    toDissolve.push(stack.number)
  }
  return toDissolve
}

/** A pull request after it was published. `number` is null for one a dry run
 * would create. */
export interface PublishedLink {
  number: number | null
  base: string | null
  head: string
}

/** Split published pull requests into chains: one continues the chain of the
 * one before it when its base is that one's head. Chains of one are left out. */
export function chainSegments(published: PublishedLink[]): PublishedLink[][] {
  const segments: PublishedLink[][] = []
  published.forEach((link, i) => {
    if (i > 0 && link.base === published[i - 1].head) segments.at(-1)!.push(link)
    else segments.push([link])
  })
  return segments.filter((segment) => segment.length >= 2)
}

export type StackAction =
  | { kind: "create"; pullRequests: PrNumber[] }
  | { kind: "add"; stack: number; pullRequests: PrNumber[] }
  /** Dissolve `stack` and create one of `pullRequests`: GitHub chains pull
   * requests added to a stack from its last member, so nothing can be added
   * above a closed one. */
  | { kind: "rebuild"; stack: number; pullRequests: PrNumber[] }
  | { kind: "warn"; message: string }

/** How to make GitHub's stacks match the published chains of numbers. A dry
 * run plans with null for the pull requests it would create, which are in no
 * stack. */
export function planStackUpdates(
  stacks: GitHubStack[],
  segments: PrNumber[][],
): StackAction[] {
  const actions: StackAction[] = []
  for (const segment of segments) {
    const touching = stacks.filter((stack) =>
      segment.some((n) => n !== null && activePullRequests(stack).includes(n)),
    )
    if (touching.length === 0) {
      actions.push({ kind: "create", pullRequests: segment })
      continue
    }
    if (touching.length > 1) {
      actions.push({
        kind: "warn",
        message:
          `Pull requests ${formatPrList(segment)} belong to several GitHub stacks ` +
          `(${touching.map((s) => `#${s.number}`).join(", ")}); leaving them unchanged.`,
      })
      continue
    }
    const stack = touching[0]
    const active: PrNumber[] = activePullRequests(stack)
    if (isContiguousRun(active, segment)) continue
    // The stack's top overlaps the start of the chain: append the rest. Only
    // pull requests that are in no stack yet can be appended.
    let overlap: number | null = null
    for (let k = Math.min(active.length, segment.length); k >= 1; k--) {
      if (active.slice(active.length - k).every((n, i) => n === segment[i])) {
        overlap = k
        break
      }
    }
    if (overlap !== null && segment.slice(overlap).some((n) => active.includes(n))) {
      overlap = null
    }
    const insertedBelowTop =
      active.includes(segment[0]) &&
      active.at(-1) !== segment[0] &&
      segment.slice(1).every((n) => !active.includes(n))
    const last = stack.pull_requests.at(-1)
    const endsClosed = last !== undefined && !isActive(last)
    if (overlap !== null && endsClosed) {
      actions.push({
        kind: "rebuild",
        stack: stack.number,
        pullRequests: [...active.slice(0, active.length - overlap), ...segment],
      })
    } else if (overlap !== null) {
      actions.push({
        kind: "add",
        stack: stack.number,
        pullRequests: segment.slice(overlap),
      })
    } else if (insertedBelowTop) {
      actions.push({
        kind: "warn",
        message:
          `${formatPrList(segment.slice(1))} now sit${segment.length === 2 ? "s" : ""} on ` +
          `#${segment[0]}, in the middle of GitHub stack #${stack.number} ` +
          `(${formatPrList(active)}). GitHub can only append to a stack. Run submit for ` +
          "the whole stack to rebuild it.",
      })
    } else {
      actions.push({
        kind: "warn",
        message:
          `GitHub stack #${stack.number} (${formatPrList(active)}) does not match the local ` +
          `order (${formatPrList(segment)}). Run submit for the whole stack to rebuild it.`,
      })
    }
  }
  return actions
}
