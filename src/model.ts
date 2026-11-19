// The types every layer shares: the error every command throws, and the
// results the commands return. Nothing here imports anything, so any module
// can use it.

/** Why a command refused or failed. Each refusal a caller would handle in its
 * own way has its own code. A problem's code is also an error's, for the
 * functions that check one thing, such as `entryText`, and for the checks of
 * the -r source. */
export type ErrorCode =
  | ProblemCode
  /** Bad arguments: exit code 2 on the command line */
  | "usage"
  /** Missing or invalid jjack.* settings, or no GitHub token */
  | "config"
  | "not_a_repository"
  /** A jj, git, or GitHub call failed */
  | "jj"
  | "git"
  | "github"
  /** Anything unexpected */
  | "internal"
  /** The stack file can't be read or parsed */
  | "stack_file"
  /** A local file can't be written */
  | "io"
  | "file_exists"
  /** The checks of a stack file found `problems` */
  | "problems"
  /** A `Pull Request:` line jjack can't use */
  | "invalid_pull_request_line"
  | "not_submitted"
  | "remote_changes"
  /** A pull request on GitHub is on a newer main commit than the local stack */
  | "needs_sync"
  | "head_not_fetched"
  | "stack_rebuild_incomplete"
  /** GitHub's stack has other pull requests below the top one than the source */
  | "stack_mismatch"
  /** A pull request targets a branch it can't be landed from */
  | "wrong_base"
  | "draft"
  /** A review is required, missing, or asks for changes */
  | "review"
  | "changed_externally"
  | "not_mergeable"
  /** GitHub blocks the merge, for required checks or reviews */
  | "blocked"
  /** GitHub added the pull request to its merge queue */
  | "merge_queued"
  /** GitHub did not finish in time; try again later */
  | "timeout"
  | "local_differs_from_merged"

/** What the checks of a stack file found wrong with an entry or the file */
export type ProblemCode =
  | "no_title"
  | "body_unreadable"
  /** A tip relative to the working copy, a remote bookmark, or a revset jj
   * can't read */
  | "tip_invalid"
  | "tip_not_found"
  /** A conflicted bookmark */
  | "tip_conflicted"
  | "tip_divergent"
  | "tips_not_in_line"
  /** The entry's changes are in the main branch already */
  | "no_changes"
  /** The entry's changes are not a line: a merge, or a separate branch */
  | "not_a_line"
  | "conflicts"
  | "no_description"
  | "has_pull_request_line"
  | "merged"
  | "closed"
  /** The title or body changed in the stack file and on GitHub */
  | "text_changed_both"
  /** A GitHub stack has an open pull request the file doesn't list */
  | "unlisted_in_stack"

export interface Problem {
  code: ProblemCode
  /** The entry's tip, or null for a problem with the whole file */
  tip: string | null
  message: string
  pr?: number
  /** Commands that fix it, in the order to run them */
  fix?: string[]
}

export interface ErrorDetails {
  /** For code "problems": what the checks found */
  problems?: Problem[]
  pr?: number
  tip?: string
  /** Commands that fix it, when jjack knows them, in the order to run them */
  fix?: string[]
  /** For code "github": the HTTP status */
  status?: number
  /** What the command did before it failed, in its result's shape */
  partial?: unknown
}

export class JjackError extends Error implements ErrorDetails {
  code: ErrorCode
  /** One line each, printed with 🛑: the message, then context lines */
  messages: string[]
  problems?: Problem[]
  pr?: number
  tip?: string
  fix?: string[]
  status?: number
  partial?: unknown

  constructor(code: ErrorCode, message: string, details: ErrorDetails = {}) {
    super(message)
    this.code = code
    this.messages = [message]
    Object.assign(this, details)
  }

  /** Add a line of context after the existing ones */
  context(message: string): this {
    this.messages.push(message)
    this.message = this.messages.join("\n")
    return this
  }

  toJSON(): ErrorJson {
    const { code, message, problems, pr, tip, fix, status } = this
    return { code, message, problems, pr, tip, fix, status }
  }
}

/** An error as the JSON output has it, with every line in `message` */
export type ErrorJson = Pick<ErrorDetails, "problems" | "pr" | "tip" | "fix" | "status"> & {
  code: ErrorCode
  message: string
}

/** `e` as a JjackError: unexpected errors get code "internal" */
export const toJjackError = (e: unknown) =>
  e instanceof JjackError
    ? e
    : new JjackError("internal", e instanceof Error ? e.message : String(e))

export interface Config {
  owner: string
  repo: string
  /** jjack.remote, default "origin" */
  remote: string
  /** jjack.mainBranch. By default the bookmark on the remote at jj's
   * `trunk()`, or "main". */
  main: string
  /** jjack.branchPrefix, required */
  branchPrefix: string
  /** jjack.requireApproval, default false */
  requireApproval: boolean
  /** jjack.apiUrl, default "https://api.github.com", no trailing slash */
  apiUrl: string
}

export type PrState = "open" | "merged" | "closed"
export type ReviewDecision = "approved" | "changes_requested" | "required" | "none"

/** A pull request as GitHub reports it. */
export interface PullRequest {
  number: number
  state: PrState
  title: string
  body: string
  /** Branch names */
  base: string
  head: string
  /** headRefOid from GitHub, known even after the branch is deleted */
  headOid: string | null
  isDraft: boolean
  reviewDecision: ReviewDecision
}

/** One change, as jj lists it. */
export interface Change {
  /** Full commit ID */
  commit: string
  /** Full change ID */
  changeId: string
  /** Commit IDs */
  parents: string[]
  description: string
  /** Whether it has conflicts */
  conflict: boolean
}

/** A normalized title and body (text.ts). */
export interface Text {
  title: string
  body: string
}

/** One pull request for the push core. */
export interface Planned {
  /** How messages refer to it: the entry's tip, or a short change ID */
  label: string
  /** Its changes, bottom first, a line, at least one */
  changes: Change[]
  /** The existing pull request, already fetched, or null for a new one */
  pullRequest: PullRequest | null
  /** The title and body it should have on GitHub after the run */
  text: Text
}

export interface GitHubStack {
  number: number
  pull_requests: { number: number; state?: string | null; merged_at?: string | null }[]
}

/** The commands a message suggests, as the user types them for this source */
export interface Hints {
  sync: string
  submit: string
  land: string
  /** How to open a new pull request for a change whose old one was closed */
  reopen: string
}

// -- results ------------------------------------------------------------------

/** Where a command finds its pull requests: a stack file, or the changes with
 * `Pull Request:` lines from the main branch up to a revision */
export type Source = { file: string } | { revision: string }

/** The parts of a title and body that differ */
export type TextParts = "title" | "body" | "title and body"

export interface PullRequestResult {
  /** The entry's tip, or the short change ID */
  label: string
  /** null only for one a dry run would create */
  number: number | null
  url: string | null
  /** Done, or planned in a dry run */
  action: "create" | "update" | "none"
  /** For an update, what it does. "push" adds commits for edits to its own
   * changes, "merge" merges the pull request below or the main branch into
   * its branch, and "retarget" changes its base. Empty for a create or none. */
  updates: ("push" | "merge" | "retarget")[]
  /** What changed, or would change, on GitHub besides commits */
  text: TextParts | null
  /** The title it has after the run */
  title: string
  /** The local commit at the top of its changes */
  commit: string
  /** Branches */
  head: string
  base: string
  /** null in a dry run for a create or update */
  headOid: string | null
}

export interface StackChange {
  kind: "dissolve" | "create" | "add" | "rebuild"
  /** The stack: the new one for create and rebuild, null in a dry run */
  stack: number | null
  /** Bottom first: the members dissolved, the stack's members after create or
   * rebuild, or the ones added. null for one a dry run would create. */
  pullRequests: (number | null)[]
}

export interface SubmitResult {
  dryRun: boolean
  pullRequests: PullRequestResult[]
  stacks: StackChange[]
}

export interface SyncItem {
  label: string
  /** Short change IDs, bottom first */
  changeIds: string[]
  number: number | null
  state: "merged" | "open" | "closed" | "unsubmitted"
}

export interface SyncResult {
  dryRun: boolean
  items: SyncItem[]
  /** Pull requests whose changes were, or would be, abandoned */
  abandoned: number[]
  /** The rest moved, or would move, onto the main branch */
  rebased: boolean
  /** Entries marked merged in the stack file */
  markedMerged: number[]
  /** Open pull requests left, which the next submit updates */
  remaining: number[]
  /** Whether, with everything merged, the sync moved an empty working copy
   * from the old main commit onto the new one */
  movedWorkingCopy: boolean
}

export interface LandResult {
  landed: number[]
  /** Asked for, and still open */
  notLanded: number[]
  /** The last merge's commit on main */
  commit: string | null
  /** Other open pull requests moved to main */
  retargeted: number[]
  deletedBranches: string[]
  /** The sync after a landing, or null when it did not run or stopped */
  sync: SyncResult | null
  /** Why the sync stopped, with the sync command in `fix` when the error has
   * no fix of its own. `null` when it finished or did not run. */
  syncError: ErrorJson | null
}

export interface CloseResult {
  closed: {
    number: number
    branchDeleted: boolean
    /** The open pull requests that target the branch, so it was kept */
    keptFor: number[]
  }[]
}

export interface AdoptResult {
  dryRun: boolean
  adopted: { tip: string; number: number; text: "matches" | "differs" | "unreadable" }[]
  skipped: { tip: string; reason: string }[]
  /** Bookmarks whose remote-tracking bookmarks were, or would be, untracked */
  untracked: string[]
  /** Changes rewritten, or that would be, to stay editable */
  rewritten: number
}

export interface InitResult {
  path: string
  entries: { tip: string; title: string | null }[]
}

export type SincePushed = "new" | "edited" | "reworded" | "unchanged" | "unknown"

export type StatusActionKind = "open" | "push" | "merge" | "retarget" | "update_text"

/** One change of an entry, from the repository alone */
export interface LocalChange {
  /** Full commit ID */
  commit: string
  /** Full change ID */
  changeId: string
  /** The first line of the description */
  title: string
  /** The commit of this change's earlier version among the pushed commit's
   * ancestors: the one with its change ID. null when it is new since the
   * last submit, or the pushed commit isn't known. Equal to `commit` when
   * the change is exactly as pushed. */
  pushedCommit: string | null
  /** Only with `classify`, and only when the entry has `pushed` in the file */
  sincePushed?: SincePushed
}

/** One entry of a stack file, resolved against the repository alone */
export interface LocalEntry {
  /** As written in the file */
  tip: string
  merged: boolean
  /** The tip's commit. null when it doesn't resolve, and for a merged entry. */
  commit: string | null
  /** How the tip resolved: a local bookmark or a change ID */
  tipKind: "bookmark" | "change" | null
  /** The entry's `pushed` when that commit is still in the repository. null
   * for a merged entry. */
  pushed: string | null
  /** Bottom first. Empty when they could not be worked out. */
  members: LocalChange[]
}

export interface LocalStack {
  file: string
  /** The revset of the main branch on the remote, such as `main@origin`:
   * what the bottom entry's changes are counted from. It has no spaces
   * unless a name does, and then that name is in double quotes. */
  trunk: string
  entries: LocalEntry[]
  /** The problems found without GitHub */
  problems: Problem[]
}

export interface StatusEntry extends LocalEntry {
  pr: number | null
  /** The entry's `pushed` as the file has it, even when that commit is no
   * longer in the repository */
  lastPushed: string | null
  // The rest only for an entry that was checked (not merged):
  title?: string
  titleFrom?: "heading" | "key"
  state?: PrState
  /** What submit would do, each with the sentence `status` prints. Empty
   * when the entry is up to date. Absent when the entry wasn't planned: it is
   * merged, or it or an entry below it has a problem. */
  actions?: { kind: StatusActionKind; text: string }[]
  /** Which of the title and body were edited on GitHub and not in the file.
   * Submit leaves them as they are on GitHub. */
  keptFromGithub?: TextParts
}

export interface Status {
  file: string
  /** As in `LocalStack` */
  trunk: string
  entries: StatusEntry[]
  problems: Problem[]
}
