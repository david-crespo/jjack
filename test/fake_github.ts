// A fake GitHub API for testing jjack's native stack support, ported from
// `tests/common/fake_github.rs` on papertigers/jj-spr's `native-stacks` branch
// (largely Mike Zeller, with additions from David Crespo's fork). It serves
// the REST and GraphQL calls jjack makes, backed by a bare Git repository that
// jjack pushes to, and models GitHub's stacked pull requests. There is no
// server: `fetch` calls `route` directly, and `listen` puts a server around it
// for the one test that needs real HTTP.
//
// The stack-validation and `merge-async` handlers are adapted from
// bos/jj-stack's `tests/support/fake_github.py`
// (https://github.com/bos/jj-stack, Apache-2.0), translated from Python by way
// of jj-spr's Rust port and modified. Notice from bos/jj-stack:
//   jj-stack
//   Copyright 2026 Voxel Labs, Inc.
//
// Stack behavior following bos/jj-stack's fake GitHub:
//
// - A stack needs two or more pull requests, each one's base must be the head
//   branch of the one below it, and a pull request can be in only one stack.
// - The base of a stacked pull request cannot be changed with PATCH (422).
// - Stacked pull requests are merged with `PUT .../merge-async` and polled
//   with `GET .../merge-async/{uuid}`. Merging one merges the stack prefix
//   below it, and GitHub then rebases the remaining members onto the new base.
// - Merged members stay listed in the stack as history.
//
// Additional behavior modeled in jj-spr's fake:
//
// - Stacks are numbered from the same sequence as pull requests and issues.
// - The ordinary merge endpoint refuses stacked pull requests (403), and so
//   does "update branch" (403).
// - After a stacked merge, GitHub rewrites the branches of the remaining
//   members: it replays each of their commits onto the new base, keeping
//   message and author, and drops merge commits and commits that the new base
//   makes empty. A member with no commits left to replay is reset to its new
//   base's head and closed.
// - When replaying a member's commits would conflict, GitHub rewrites no
//   branch at all. It still points the pull request above the merged ones at
//   the stack's base, and reports that pull request as `CONFLICTING`.
// - After a stacked merge, GitHub points the next pull request at the stack's
//   base a few seconds before it pushes the rebased head. In between, it can
//   report whether the old head can be merged (`staleHeadPolls`).
// - A draft cannot be merged: 405 from the ordinary endpoint, and a failed
//   merge (400) from `merge-async`.
// - A pull request in the middle of a stack can be closed. The stack still
//   lists it.
// - A pull request whose head becomes part of its base branch (as when a push
//   to the base branch brings in its head) is marked merged.
//
// Everything else (closing pull requests when their base or head branch is
// deleted, squash merges as a three-way merge, and "update branch" merging the
// base into an ordinary pull request) is ordinary GitHub behavior.

import { spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { join } from "node:path"

/** The fake's own identity for the commits it makes. No global or system git
 * config, so the user's settings (commit signing, say) stay out of it. */
const GIT_ENV = {
  GIT_AUTHOR_NAME: "Fake GitHub",
  GIT_AUTHOR_EMAIL: "fake-github@example.com",
  GIT_COMMITTER_NAME: "Fake GitHub",
  GIT_COMMITTER_EMAIL: "fake-github@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
}

export interface FakePullRequest {
  number: number
  title: string
  body: string
  headRef: string
  baseRef: string
  draft: boolean
  state: "open" | "closed"
  mergedAt: string | null
  mergeCommitSha: string | null
  lastHeadSha: string
  closedReason: string | null
  /** The latest review of each reviewer: [login, "APPROVED" | "CHANGES_REQUESTED"] */
  reviews: [string, string][]
}

/** A requested squash commit */
interface Commit {
  title: string
  message: string
}

interface MergeOperation {
  uuid: string
  prNumber: number
  method: string
  expectedHead: string
  /** `commit_title` and `commit_message`, which GitHub applies only to this
   * pull request's commit, not to the ones merged below it */
  commit: Commit | null
  status: string
  message: string
  sha: string | null
}

/** One recorded API request: method, path, and JSON body */
export interface Recorded {
  method: string
  path: string
  body: unknown
}

type Json = Record<string, any>

class ApiError extends Error {
  readonly status: number
  /** The `errors` of a 422 "Validation Failed" reply */
  readonly errors: Json[]

  constructor(status: number, message: string, errors: Json[] = []) {
    super(message)
    this.status = status
    this.errors = errors
  }
}

const now = () => new Date().toISOString().replace(/\.\d+Z$/, "Z")

const isOpen = (pr: FakePullRequest) => pr.state === "open"

function parseNumber(text: string | undefined): number {
  if (!/^\d+$/.test(text ?? "")) throw new ApiError(404, "Not Found")
  return Number(text)
}

/** The `commit_title` and `commit_message` of a merge request. GitHub uses its
 * default for whichever is missing. The fake uses its own default unless a
 * title is given. */
function requestedCommit(body: Json): Commit | null {
  if (typeof body.commit_title !== "string") return null
  const message = typeof body.commit_message === "string" ? body.commit_message : ""
  return { title: body.commit_title, message }
}

const pullRequestNumbers = (body: Json): number[] =>
  Array.isArray(body.pull_requests)
    ? body.pull_requests.filter((n: unknown) => Number.isInteger(n))
    : []

export class FakeGitHub {
  readonly owner: string
  readonly name: string
  readonly gitDir: string
  stacksEnabled: boolean
  prs = new Map<number, FakePullRequest>()
  stacks = new Map<number, number[]>()
  requests: Recorded[] = []
  /** GraphQL operations (by name) that answer with an error */
  failingQueries: string[] = []
  /** Head branches whose next pull request GitHub refuses to create, once */
  failingCreations: string[] = []
  /** How many more mergeability queries answer `UNKNOWN`, as GitHub does
   * while it is still computing mergeability */
  unknownMergeabilityPolls = 0
  /** After the next stack merge, how many mergeability queries see the pull
   * request above the merged ones already targeting the stack's base but still
   * at its old head, before the rebase of the rest of the stack lands. Live
   * GitHub leaves a gap of 2 to 7 seconds between the two. */
  staleHeadPolls = 0
  /** Pull requests whose merge GitHub blocks (for required checks or reviews)
   * although they have no conflicts */
  blocked: number[] = []
  /** The repository's settings. With `PR_BODY`, a squash merge without a
   * requested message gets the pull request's body. */
  squashMergeCommitTitle = "COMMIT_OR_PR_TITLE"
  squashMergeCommitMessage = "COMMIT_MESSAGES"
  #mergeOps = new Map<number, MergeOperation>()
  /** The rebase of the rest of the stack that `staleHeadPolls` holds back:
   * the members, the stack's base, and the old head of the top merged one */
  #heldRebase: { members: number[]; baseRef: string; oldBase: string } | null = null
  /** Pull requests and stacks share one sequence of numbers, as on GitHub */
  #nextNumber = 1

  constructor(options: {
    owner: string
    name: string
    gitDir: string
    stacksEnabled: boolean
  }) {
    this.owner = options.owner
    this.name = options.name
    this.gitDir = options.gitDir
    this.stacksEnabled = options.stacksEnabled
    refuseLongRefs(options.gitDir)
  }

  // -- git -------------------------------------------------------------------

  #spawn(args: string[], env: Record<string, string> = {}) {
    return spawnSync("git", ["--git-dir", this.gitDir, ...args], {
      encoding: "utf8",
      env: { ...process.env, ...GIT_ENV, ...env },
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    })
  }

  /** git on the bare repository: its output, trimmed. Throws on a nonzero exit. */
  git(args: string[], env: Record<string, string> = {}): string {
    const result = this.#spawn(args, env)
    if (result.status !== 0) {
      throw new Error(`fake github: git ${args.join(" ")} failed: ${result.stderr}`)
    }
    return result.stdout.trim()
  }

  /** `merge-tree --write-tree`, optionally with a merge base: the merged tree,
   * or null when the merge conflicts */
  #mergedTree(mergeBase: string | null, ours: string, theirs: string): string | null {
    const base = mergeBase === null ? [] : [`--merge-base=${mergeBase}`]
    const result = this.#spawn(["merge-tree", "--write-tree", ...base, ours, theirs])
    if (result.status === 0) return result.stdout.split("\n")[0]
    if (result.status === 1) return null
    throw new Error(
      `fake github: git merge-tree ${ours} ${theirs} failed: ${result.stderr}`,
    )
  }

  /** Commit `tree` onto `parents`, with the author of `authorOf` if given */
  #commitTree(tree: string, parents: string[], message: string, authorOf?: string): string {
    let env = {}
    if (authorOf !== undefined) {
      const format = "--format=%an%x00%ae%x00%aI"
      const [name, email, date] = this.git(["log", "-1", format, authorOf]).split("\0")
      env = { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_AUTHOR_DATE: date }
    }
    const parentArgs = parents.flatMap((parent) => ["-p", parent])
    return this.git(["commit-tree", tree, ...parentArgs, "-m", message], env)
  }

  #treeOf(commit: string): string {
    return this.git(["rev-parse", `${commit}^{tree}`])
  }

  /** Every branch's head, by name */
  branches(): Map<string, string> {
    const heads = new Map<string, string>()
    for (const line of this.#spawn(["show-ref", "--heads"]).stdout.split("\n")) {
      const [sha, name] = line.split(" ")
      if (name?.startsWith("refs/heads/")) heads.set(name.slice("refs/heads/".length), sha)
    }
    return heads
  }

  isAncestor(ancestor: string, descendant: string): boolean {
    return this.#spawn(["merge-base", "--is-ancestor", ancestor, descendant]).status === 0
  }

  // -- pull request state ----------------------------------------------------

  /** Apply what GitHub does on its own when branches change. Every request
   * does this before and after it is answered. */
  refresh(): void {
    const heads = this.branches()
    for (const pr of this.prs.values()) {
      if (!isOpen(pr)) continue
      const head = heads.get(pr.headRef)
      const base = heads.get(pr.baseRef)
      if (head !== undefined) pr.lastHeadSha = head
      if (base === undefined) {
        pr.state = "closed"
        pr.closedReason = `base branch ${pr.baseRef} was deleted`
      } else if (head === undefined) {
        pr.state = "closed"
        pr.closedReason = `head branch ${pr.headRef} was deleted`
      } else if (this.isAncestor(head, base)) {
        // GitHub marks a pull request merged once its head is in its base
        // branch, however it got there
        pr.state = "closed"
        pr.mergedAt = now()
        pr.mergeCommitSha = pr.lastHeadSha
        pr.closedReason = `its head is in ${pr.baseRef}`
      }
    }
  }

  /** The stack that lists pull request `number`, as a member in any state */
  stackOf(number: number): number | null {
    for (const [stack, members] of this.stacks) if (members.includes(number)) return stack
    return null
  }

  /** The open ones of `members` */
  active(members: number[]): number[] {
    return members.filter((n) => isOpen(this.prs.get(n)!))
  }

  #pr(number: number): FakePullRequest {
    const pr = this.prs.get(number)
    if (!pr) throw new ApiError(404, "Not Found")
    return pr
  }

  #headOid(pr: FakePullRequest): string {
    return this.branches().get(pr.headRef) ?? pr.lastHeadSha
  }

  /** Record a review, replacing the reviewer's earlier one */
  review(number: number, login: string, state: string): void {
    const pr = this.prs.get(number)!
    pr.reviews = pr.reviews.filter(([l]) => l !== login)
    pr.reviews.push([login, state])
  }

  // -- payloads --------------------------------------------------------------

  /** jjack reads only the number */
  #prPayload(pr: FakePullRequest) {
    return {
      number: pr.number,
      state: pr.state,
      head: { ref: pr.headRef },
      base: { ref: pr.baseRef },
    }
  }

  #stackPayload(number: number) {
    const members = this.stacks.get(number)!
    const pullRequests = members.map((n) => {
      const pr = this.prs.get(n)!
      return {
        number: n,
        state: pr.state,
        draft: pr.draft,
        merged_at: pr.mergedAt,
        head: { ref: pr.headRef, sha: this.#headOid(pr) },
      }
    })
    const base = members.length > 0 ? this.prs.get(members[0])!.baseRef : ""
    const open = members.some((n) => isOpen(this.prs.get(n)!))
    return {
      id: 1_000_000 + number,
      number,
      base: { ref: base },
      open,
      pull_requests: pullRequests,
    }
  }

  #graphqlState(pr: FakePullRequest): string {
    return pr.mergedAt !== null ? "MERGED" : pr.state.toUpperCase()
  }

  /** The fields of PullRequestQuery */
  #pullRequestNode(pr: FakePullRequest) {
    const has = (wanted: string) => pr.reviews.some(([, state]) => state === wanted)
    return {
      number: pr.number,
      state: this.#graphqlState(pr),
      reviewDecision: has("CHANGES_REQUESTED")
        ? "CHANGES_REQUESTED"
        : has("APPROVED")
          ? "APPROVED"
          : null,
      title: pr.title,
      body: pr.body,
      baseRefName: pr.baseRef,
      headRefName: pr.headRef,
      headRefOid: this.#headOid(pr),
      isDraft: pr.draft,
    }
  }

  /** The fields of PullRequestMergeabilityQuery */
  #mergeabilityNode(pr: FakePullRequest) {
    const conflicting = this.#isConflicting(pr)
    return {
      state: this.#graphqlState(pr),
      baseRefName: pr.baseRef,
      headRefOid: this.#headOid(pr),
      mergeable: conflicting ? "CONFLICTING" : "MERGEABLE",
      mergeStateStatus: conflicting
        ? "DIRTY"
        : this.blocked.includes(pr.number)
          ? "BLOCKED"
          : "CLEAN",
    }
  }

  /** Whether merging the pull request's head into its base conflicts */
  #isConflicting(pr: FakePullRequest): boolean {
    const heads = this.branches()
    const base = heads.get(pr.baseRef)
    const head = heads.get(pr.headRef)
    if (base === undefined || head === undefined || !isOpen(pr)) return false
    return this.#mergedTree(null, base, head) === null
  }

  // -- stacks ----------------------------------------------------------------

  #validateStack(admitted: number[], chained: number[], allowedStack: number | null): void {
    if (new Set(chained).size !== chained.length) {
      throw new ApiError(422, "Duplicate pull request.")
    }
    for (const n of admitted) {
      const pr = this.prs.get(n)
      if (!pr) throw new ApiError(422, "Pull request does not exist.")
      if (!isOpen(pr)) throw new ApiError(422, "Pull request is not admissible.")
    }
    for (let i = 1; i < chained.length; i++) {
      if (this.prs.get(chained[i])!.baseRef !== this.prs.get(chained[i - 1])!.headRef) {
        throw new ApiError(422, "Pull request bases do not form a chain.")
      }
    }
    for (const [number, members] of this.stacks) {
      if (number !== allowedStack && members.some((m) => admitted.includes(m))) {
        throw new ApiError(422, "Pull request already belongs to a stack.")
      }
    }
  }

  #createStack(members: number[]) {
    if (members.length < 2) throw new ApiError(422, "A stack requires two pull requests.")
    this.#validateStack(members, members, null)
    const number = this.#nextNumber++
    this.stacks.set(number, members)
    return this.#stackPayload(number)
  }

  #addToStack(number: number, added: number[]) {
    const existing = this.stacks.get(number)
    if (!existing) throw new ApiError(404, "Not Found")
    if (added.length === 0) throw new ApiError(422, "No pull requests to append.")
    // GitHub chains the added pull requests from the stack's last member, even
    // a closed one (seen live)
    this.#validateStack(added, [...existing.slice(-1), ...added], number)
    this.stacks.set(number, [...existing, ...added])
    return this.#stackPayload(number)
  }

  #unstack(number: number) {
    const members = this.stacks.get(number)
    if (!members) throw new ApiError(404, "Not Found")
    const retained = members.filter((n) => this.prs.get(n)!.mergedAt !== null)
    if (retained.length === 0) {
      this.stacks.delete(number)
      return null
    }
    this.stacks.set(number, retained)
    return this.#stackPayload(number)
  }

  // -- merging ---------------------------------------------------------------

  #squashMerge(number: number, commit: Commit | null): string | null {
    return this.#squashMergeFrom(number, this.prs.get(number)!.baseRef, null, commit)
  }

  /**
   * Squash-merge `number` onto branch `baseRef`. null, with nothing changed,
   * when that conflicts. `mergeBase` is where its own changes start, when that
   * is not the merge base with the base branch (a stacked pull request whose
   * parent was just squash-merged below it). `commit` is the requested title
   * and message. Without it, the title is the pull request's with its number,
   * and the message is its body under the `PR_BODY` setting and empty
   * otherwise (where GitHub would list the commits).
   */
  #squashMergeFrom(
    number: number,
    baseRef: string,
    mergeBase: string | null,
    commit: Commit | null,
  ): string | null {
    const heads = this.branches()
    const pr = this.prs.get(number)!
    const base = heads.get(baseRef)!
    const head = heads.get(pr.headRef)!
    const { title, message: body } = commit ?? {
      title: `${pr.title} (#${number})`,
      message: this.squashMergeCommitMessage === "PR_BODY" ? pr.body : "",
    }
    const tree = this.#mergedTree(mergeBase, base, head)
    if (tree === null) return null
    const merged = this.#commitTree(
      tree,
      [base],
      body === "" ? title : `${title}\n\n${body}`,
    )
    this.git(["update-ref", `refs/heads/${baseRef}`, merged])
    pr.mergedAt = now()
    pr.mergeCommitSha = merged
    pr.lastHeadSha = head
    pr.state = "closed"
    return merged
  }

  /** Replay the non-merge commits of `oldBase..head` onto `onto`, leaving out
   * those that `onto` makes empty. Returns the new tip, which is `onto` when no
   * commit is left, or null when a commit conflicts. */
  #replay(head: string, oldBase: string, onto: string): string | null {
    const commits = this.git([
      "rev-list",
      "--reverse",
      "--no-merges",
      `${oldBase}..${head}`,
    ])
    let tip = onto
    for (const commit of commits.split("\n").filter(Boolean)) {
      const tree = this.#mergedTree(`${commit}^`, tip, commit)
      if (tree === null) return null
      if (tree === this.#treeOf(tip)) continue
      const message = this.git(["log", "-1", "--format=%B", commit])
      tip = this.#commitTree(tree, [tip], message, commit)
    }
    return tip
  }

  /**
   * GitHub rebasing stack members, bottom first, after a merge below them or a
   * press of the rebase button: the first one's own commits (those not in
   * `oldBase`) are replayed onto the head of `baseRef`, and each later one's
   * onto the new head of the member below. A member left with no commits gets
   * its new base's head and is closed, as live GitHub did with a reordered
   * stack.
   *
   * When any replay conflicts, no branch is rewritten and this returns false,
   * as live GitHub did after a conflict-resolved update. (Seen with the
   * conflict in the first member. That a conflict further up also leaves the
   * lower members alone is an assumption.)
   */
  #rebaseMembers(members: number[], baseRef: string, oldBase: string): boolean {
    const heads = this.branches()
    const plan: { number: number; tip: string; emptied: boolean }[] = []
    let onto = heads.get(baseRef)!
    let old = oldBase
    for (const number of members) {
      const head = heads.get(this.prs.get(number)!.headRef)!
      const tip = this.#replay(head, old, onto)
      if (tip === null) return false
      plan.push({ number, tip, emptied: tip === onto })
      onto = tip
      old = head
    }
    let newBase = baseRef
    for (const { number, tip, emptied } of plan) {
      const pr = this.prs.get(number)!
      this.git(["update-ref", `refs/heads/${pr.headRef}`, tip])
      pr.lastHeadSha = tip
      if (emptied) {
        pr.state = "closed"
        pr.closedReason = "no commits left after the stack rebase"
      } else {
        pr.baseRef = newBase
      }
      newBase = pr.headRef
    }
    return true
  }

  #completeStackMerge(prNumber: number): void {
    const stack = this.stackOf(prNumber)
    const members = stack === null ? [prNumber] : this.active(this.stacks.get(stack)!)
    const cut = members.indexOf(prNumber) + 1
    const prefix = members.slice(0, cut)
    const survivors = members.slice(cut)
    const baseRef = this.prs.get(prefix[0])!.baseRef
    const oldTop = this.branches().get(this.prs.get(prefix[cut - 1])!.headRef)!
    const op = this.#mergeOps.get(prNumber)!
    let below: string | null = null
    // Every pull request of the prefix keeps its base branch, as on GitHub,
    // though each lands on the stack's base
    for (const number of prefix) {
      const head = this.branches().get(this.prs.get(number)!.headRef)!
      const commit = number === prNumber ? op.commit : null
      if (this.#squashMergeFrom(number, baseRef, below, commit) === null) {
        op.status = "failed"
        op.message = `Pull request #${number} is not mergeable.`
        return
      }
      below = head
    }
    const next = survivors[0]
    if (this.staleHeadPolls > 0 && next !== undefined) {
      this.prs.get(next)!.baseRef = baseRef
      this.#heldRebase = { members: survivors, baseRef, oldBase: oldTop }
    } else if (!this.#rebaseMembers(survivors, baseRef, oldTop) && next !== undefined) {
      this.prs.get(next)!.baseRef = baseRef
    }
    op.status = "merged"
    op.message = "Pull request successfully merged."
    op.sha = this.branches().get(baseRef)!
  }

  #mergeOperation(
    number: number,
    expectedHead: string,
    method: string,
    commit: Commit | null,
  ) {
    const op: MergeOperation = {
      uuid: `merge-${this.#mergeOps.size + 1}`,
      prNumber: number,
      method,
      expectedHead,
      commit,
      status: "pending",
      message: "Merge request enqueued.",
      sha: null,
    }
    this.#mergeOps.set(number, op)
    return op
  }

  static #mergePayload(op: MergeOperation) {
    return {
      status: op.status,
      details: {
        expected_head_sha: op.expectedHead,
        merge_action: "direct_merge",
        merge_method: op.method,
        message: op.message,
        sha: op.sha,
        uuid: op.uuid,
      },
    }
  }

  // -- what a person does on GitHub ------------------------------------------

  /** Merge a pull request the way someone would in GitHub's web UI: a stacked
   * one merges its stack prefix and GitHub rebases the rest. Any other one is
   * squash-merged into its base. */
  mergeOnGithub(number: number): void {
    if (this.stackOf(number) !== null) {
      const head = this.branches().get(this.prs.get(number)!.headRef)!
      const op = this.#mergeOperation(number, head, "squash", null)
      this.#completeStackMerge(number)
      if (op.status !== "merged") throw new Error(`fake github: #${number} did not merge`)
    } else if (this.#squashMerge(number, null) === null) {
      throw new Error(`fake github: #${number} is not mergeable`)
    }
  }

  /** The stack's rebase button in GitHub's web UI: replay every open member,
   * bottom first, onto the current head of the stack's base */
  rebaseStackOnGithub(number: number): void {
    const stack = this.stackOf(number)
    if (stack === null) throw new Error(`fake github: #${number} is not in a stack`)
    const members = this.active(this.stacks.get(stack)!)
    const bottom = this.prs.get(members[0])!
    const heads = this.branches()
    const fork = this.git([
      "merge-base",
      heads.get(bottom.headRef)!,
      heads.get(bottom.baseRef)!,
    ])
    this.#rebaseMembers(members, bottom.baseRef, fork)
  }

  /** Close a pull request without merging it, as in GitHub's web UI */
  closeOnGithub(number: number): void {
    const pr = this.prs.get(number)!
    pr.state = "closed"
    pr.closedReason = "closed on GitHub"
  }

  /** "Update branch": merge the base branch into an ordinary pull request's
   * branch */
  updateBranch(number: number): void {
    const pr = this.prs.get(number)!
    const heads = this.branches()
    const base = heads.get(pr.baseRef)!
    const head = heads.get(pr.headRef)!
    const tree = this.#mergedTree(null, head, base)
    if (tree === null)
      throw new Error(`fake github: #${number} conflicts with ${pr.baseRef}`)
    const message = `Merge branch '${pr.baseRef}' into ${pr.headRef}`
    const commit = this.#commitTree(tree, [head, base], message)
    this.git(["update-ref", `refs/heads/${pr.headRef}`, commit])
    pr.lastHeadSha = commit
  }

  /** Open a pull request the way someone using GitHub directly would, for
   * scenarios that do not start with jjack. Returns its number. */
  openPrOutsideJjack(head: string, base: string, title: string): number {
    const path = `/repos/${this.owner}/${this.name}/pulls`
    const { status, json } = this.route("POST", path, "", { head, base, title })
    if (status !== 201)
      throw new Error(`could not open a pull request from ${head} to ${base}`)
    return (json as Json).number
  }

  /** Register a stack the way someone using GitHub directly would */
  stackOutsideJjack(members: number[]): void {
    this.#createStack([...members])
  }

  // -- routing ---------------------------------------------------------------

  /** Answer one request. An error is `{message, status, errors?}` with its
   * status, as GitHub sends it. */
  route(
    method: string,
    path: string,
    query: string,
    body: unknown,
  ): { status: number; json: unknown } {
    try {
      const json = body !== null && typeof body === "object" ? (body as Json) : {}
      return this.#route(method, path, query, json)
    } catch (error) {
      if (!(error instanceof ApiError)) throw error
      const errors = error.errors.length > 0 ? { errors: error.errors } : {}
      return {
        status: error.status,
        json: { message: error.message, status: String(error.status), ...errors },
      }
    }
  }

  #route(
    method: string,
    path: string,
    query: string,
    body: Json,
  ): { status: number; json: unknown } {
    if (path === "/graphql" && method === "POST")
      return { status: 200, json: this.#graphql(body) }
    const prefix = `/repos/${this.owner}/${this.name}/`
    if (!path.startsWith(prefix)) throw new ApiError(404, "Not Found")
    const segments = path.slice(prefix.length).split("/").filter(Boolean)
    // The numbers and merge IDs are every other segment
    const shape = segments.map((s, i) => (i % 2 === 1 ? "*" : s)).join("/")
    if (segments[0] === "stacks") {
      if (!this.stacksEnabled) throw new ApiError(404, "Not Found")
      return this.#routeStacks(`${method} ${shape}`, segments, query, body)
    }
    switch (`${method} ${shape}`) {
      case "POST pulls":
        return { status: 201, json: this.#createPullRequest(body) }
      case "GET pulls/*":
        return { status: 200, json: this.#prPayload(this.#pr(parseNumber(segments[1]))) }
      case "PATCH pulls/*":
        return {
          status: 200,
          json: this.#prPayload(this.#updatePullRequest(segments[1], body)),
        }
      case "PUT pulls/*/merge":
        return this.#merge(parseNumber(segments[1]), body)
      case "PUT pulls/*/merge-async":
        return this.#mergeAsync(parseNumber(segments[1]), body)
      case "GET pulls/*/merge-async/*": {
        const n = parseNumber(segments[1])
        const op = this.#mergeOps.get(n)
        if (op?.uuid !== segments[3]) throw new ApiError(404, "Not Found")
        if (op.status === "pending") this.#completeStackMerge(op.prNumber)
        return { status: 200, json: FakeGitHub.#mergePayload(op) }
      }
      case "PUT pulls/*/update-branch": {
        const n = parseNumber(segments[1])
        this.#pr(n)
        if (this.stackOf(n) !== null) {
          throw new ApiError(
            403,
            "Updating a stacked PR's branch via this endpoint is not supported.",
          )
        }
        this.updateBranch(n)
        const url = `https://github.com/${this.owner}/${this.name}/pull/${n}`
        return { status: 202, json: { message: "Updating pull request branch.", url } }
      }
    }
    throw new ApiError(404, "Not Found")
  }

  #createPullRequest(body: Json) {
    const head = String(body.head ?? "")
    const base = String(body.base ?? "")
    const failing = this.failingCreations.indexOf(head)
    if (failing !== -1) {
      this.failingCreations.splice(failing, 1)
      throw new ApiError(500, "fake github: creating this pull request failed")
    }
    const heads = this.branches()
    for (const branch of [head, base]) {
      if (!heads.has(branch))
        throw new ApiError(422, `Branch ${JSON.stringify(branch)} does not exist.`)
    }
    // Live GitHub refused this for the same head and base. Other bases were
    // not tried.
    for (const pr of this.prs.values()) {
      if (isOpen(pr) && pr.headRef === head && pr.baseRef === base) {
        throw new ApiError(422, `A pull request already exists for ${this.owner}:${head}.`)
      }
    }
    const pr: FakePullRequest = {
      number: this.#nextNumber++,
      title: typeof body.title === "string" ? body.title : "",
      body: typeof body.body === "string" ? body.body : "",
      headRef: head,
      baseRef: base,
      draft: body.draft === true,
      state: "open",
      mergedAt: null,
      mergeCommitSha: null,
      lastHeadSha: heads.get(head)!,
      closedReason: null,
      reviews: [],
    }
    this.prs.set(pr.number, pr)
    return this.#prPayload(pr)
  }

  #updatePullRequest(segment: string, body: Json): FakePullRequest {
    const pr = this.#pr(parseNumber(segment))
    const newBase = body.base
    if (typeof newBase === "string" && newBase !== pr.baseRef) {
      if (this.stackOf(pr.number) !== null) {
        throw new ApiError(422, "Validation Failed", [
          {
            resource: "PullRequest",
            code: "invalid",
            field: "base",
            message:
              "Cannot change the base branch because the pull request is part of a stack.",
          },
        ])
      }
      if (!isOpen(pr)) {
        throw new ApiError(422, "Cannot change the base branch of a closed pull request.")
      }
      if (!this.branches().has(newBase)) {
        throw new ApiError(422, `Branch ${JSON.stringify(newBase)} does not exist.`)
      }
      pr.baseRef = newBase
    }
    if (typeof body.title === "string") pr.title = body.title
    if ("body" in body) pr.body = typeof body.body === "string" ? body.body : ""
    if (body.state === "closed" && isOpen(pr)) {
      pr.state = "closed"
      pr.closedReason = "closed by request"
    }
    return pr
  }

  #merge(n: number, body: Json) {
    const pr = this.#pr(n)
    if (this.stackOf(n) !== null) {
      throw new ApiError(
        403,
        "Merging stacked PRs via this endpoint is not supported. Use the asynchronous merge " +
          "endpoint instead.",
      )
    }
    if (pr.draft) throw new ApiError(405, "Pull request is still a draft")
    if (typeof body.sha === "string" && this.branches().get(pr.headRef) !== body.sha) {
      throw new ApiError(409, "Head branch was modified.")
    }
    const sha = this.#squashMerge(n, requestedCommit(body))
    if (sha === null) throw new ApiError(405, "Pull request is not mergeable")
    return {
      status: 200,
      json: { sha, merged: true, message: "Pull request successfully merged" },
    }
  }

  #mergeAsync(n: number, body: Json) {
    const pr = this.#pr(n)
    if (body.merge_action !== "direct_merge") {
      throw new ApiError(400, "Merge action does not match policy.")
    }
    const expected = typeof body.sha === "string" ? body.sha : ""
    if (this.branches().get(pr.headRef) !== expected)
      throw new ApiError(400, "Target head changed.")
    const stack = this.stackOf(n)
    const active = stack === null ? [n] : this.active(this.stacks.get(stack)!)
    if (pr.draft) {
      return {
        status: 400,
        json: { status: "failed", details: { message: "Pull request is in draft." } },
      }
    }
    if (!active.includes(n)) throw new ApiError(400, "Target is not mergeable.")
    const method = typeof body.merge_method === "string" ? body.merge_method : "merge"
    const op = this.#mergeOperation(n, expected, method, requestedCommit(body))
    return { status: 202, json: FakeGitHub.#mergePayload(op) }
  }

  #routeStacks(route: string, segments: string[], query: string, body: Json) {
    switch (route) {
      case "GET stacks": {
        const params = new URLSearchParams(query)
        const page = Number(params.get("page") ?? 1)
        const wanted = params.get("pull_request")
        const numbers =
          page === 1
            ? [...this.stacks]
                .filter(
                  ([, members]) => wanted === null || members.includes(Number(wanted)),
                )
                .map(([n]) => n)
            : []
        return { status: 200, json: numbers.map((n) => this.#stackPayload(n)) }
      }
      case "POST stacks":
        return { status: 201, json: this.#createStack(pullRequestNumbers(body)) }
      case "GET stacks/*": {
        const n = parseNumber(segments[1])
        if (!this.stacks.has(n)) throw new ApiError(404, "Not Found")
        return { status: 200, json: this.#stackPayload(n) }
      }
      case "POST stacks/*/add":
        return {
          status: 200,
          json: this.#addToStack(parseNumber(segments[1]), pullRequestNumbers(body)),
        }
      case "POST stacks/*/unstack": {
        const remaining = this.#unstack(parseNumber(segments[1]))
        return remaining === null
          ? { status: 204, json: null }
          : { status: 200, json: remaining }
      }
    }
    throw new ApiError(404, "Not Found")
  }

  #graphql(body: Json): Json {
    const name = String(body.operationName ?? "")
    const variables: Json = body.variables ?? {}
    if (this.failingQueries.includes(name)) {
      return { errors: [{ message: `fake github: ${name} failed` }] }
    }
    const pr =
      typeof variables.number === "number" ? this.prs.get(variables.number) : undefined
    switch (name) {
      case "PullRequestQuery":
        return {
          data: { repository: { pullRequest: pr ? this.#pullRequestNode(pr) : null } },
        }
      case "PullRequestMergeabilityQuery": {
        const held = this.#heldRebase
        if (held !== null) {
          if (this.staleHeadPolls > 0) {
            this.staleHeadPolls--
          } else {
            this.#heldRebase = null
            this.#rebaseMembers(held.members, held.baseRef, held.oldBase)
          }
        }
        const node: Json | null = pr ? this.#mergeabilityNode(pr) : null
        if (node && this.unknownMergeabilityPolls > 0) {
          this.unknownMergeabilityPolls--
          node.mergeable = "UNKNOWN"
          node.mergeStateStatus = "UNKNOWN"
        }
        return { data: { repository: { pullRequest: node } } }
      }
      case "RepositorySquashDefaultsQuery":
        return {
          data: {
            repository: {
              squashMergeCommitTitle: this.squashMergeCommitTitle,
              squashMergeCommitMessage: this.squashMergeCommitMessage,
            },
          },
        }
      case "OpenPullRequestBranchesQuery": {
        const nodes = [...this.prs.values()].filter(isOpen).map((pr) => ({
          number: pr.number,
          headRefName: pr.headRef,
          baseRefName: pr.baseRef,
        }))
        const pageInfo = { hasNextPage: false, endCursor: null }
        return { data: { repository: { pullRequests: { nodes, pageInfo } } } }
      }
      case "PullRequestsForBranchQuery": {
        const nodes = [...this.prs.values()]
          .filter((pr) => pr.headRef === variables.head)
          .map((pr) => ({
            number: pr.number,
            state: isOpen(pr) ? "OPEN" : pr.mergedAt !== null ? "MERGED" : "CLOSED",
            isCrossRepository: false,
          }))
        return { data: { repository: { pullRequests: { nodes } } } }
      }
    }
    return {
      errors: [{ message: `fake github: unknown operation ${JSON.stringify(name)}` }],
    }
  }

  // -- transport -------------------------------------------------------------

  /** Record a request, and answer it between two refreshes */
  #handle(method: string, url: URL, text: string): { status: number; text: string } {
    let body: unknown = null
    try {
      if (text !== "") body = JSON.parse(text)
    } catch {}
    this.requests.push({ method, path: url.pathname, body })
    this.refresh()
    const { status, json } = this.route(method, url.pathname, url.search.slice(1), body)
    this.refresh()
    return { status, text: json === null ? "" : JSON.stringify(json) }
  }

  /** Give this to `new GitHub({fetch})`. The URL's host is ignored. */
  readonly fetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init)
    const { status, text } = this.#handle(
      request.method,
      new URL(request.url),
      await request.text(),
    )
    return new Response(text === "" ? null : text, {
      status,
      headers: { "Content-Type": "application/json" },
    })
  }

  /** Serve the fake over HTTP on a free local port */
  async listen(): Promise<{ url: string; close(): Promise<void> }> {
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk)
      const url = new URL(req.url ?? "/", "http://localhost")
      try {
        const { status, text } = this.#handle(
          req.method ?? "GET",
          url,
          Buffer.concat(chunks).toString(),
        )
        res.writeHead(status, { "Content-Type": "application/json" }).end(text)
      } catch (error) {
        res.writeHead(500).end(String(error))
      }
    })
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(0, "127.0.0.1", resolve)
    })
    const { port } = server.address() as AddressInfo
    return {
      url: `http://127.0.0.1:${port}`,
      close: () =>
        new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
    }
  }
}

/** Make pushes to the repository at `gitDir` refuse a ref name longer than 255
 * bytes, as GitHub's pre-receive hook does (error GH005) */
function refuseLongRefs(gitDir: string): void {
  const hooks = join(gitDir, "hooks")
  mkdirSync(hooks, { recursive: true })
  const hook = join(hooks, "pre-receive")
  writeFileSync(
    hook,
    `#!/bin/sh
while read old new ref; do
  bytes=$(printf %s "$ref" | wc -c)
  if [ $bytes -gt 255 ]; then
    echo "error: GH005: Sorry, refs longer than 255 bytes are not allowed." >&2
    exit 1
  fi
done
`,
  )
  chmodSync(hook, 0o755)
}
