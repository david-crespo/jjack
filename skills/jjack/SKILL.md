---
name: jjack
description: "Open, update, land, and close a stack of GitHub pull requests from jj changes with jjack: `jjack init`, `status`, `adopt`, `submit`, `land`, `sync`, and `close`, from a stack file or from changes with `Pull Request:` lines (`-r`). Use when the user wants a stack of PRs pushed, updated, landed, or closed with jjack, when a jjack command refuses, or when taking over a stack that was pushed with `jj git push`."
---

# Stacks of PRs with jjack

jjack pushes a stack of jj changes as GitHub pull requests, bottom first.
Updates only add commits to a PR's branch. Nothing is force-pushed. PRs that
build on each other are registered as a GitHub stack (GitHub's native
stacked PRs), which GitHub merges and rebases together. The README has the
configuration, every command, and the JSON output. It is `README.md` at the
root of the jjack repository, which is `../../README.md` from this skill's
directory when the skill is read from inside the checkout. Each command's
`--help` has its flags.

A program that imports jjack as a library can call `resolveStack` for the
local part of `status`, without calling GitHub: the same entries, changes, and
problems, without a token. Its jj calls don't grow with the number of
entries, so a view can call it to redraw on every jj
operation. The README's
library section has the details.

## Before you start

- Check that `jjack --help` works.
- Pass `--json` to every command whose result you read. stdout then has one
  JSON document, with the result or the error, and the log goes to stderr.
  The exit code is 0 when the command did what it was asked, 1 when it
  refused or failed, and 2 for a usage error.
- Run `submit`, `land`, `close`, and `adopt` only when the user asks for
  them. `status`, `submit --dry-run`, `sync --dry-run`, and `adopt --dry-run`
  change nothing and are safe at any time. A dry run's result has the same
  shape as the real run's, so it is the plan to show the user.
- A `Pull Request:` line is the last line of a change's description, after a
  blank line, such as `Pull Request: https://github.com/owner/repo/pull/12`.
  `jjack submit -r` adds it. A change belongs to a stack file or has a
  `Pull Request:` line, never both. Never run `jj git push` on changes jjack
  manages.

## Which source

- Use **a stack file** (`jjack submit <file>`) for a PR of several changes,
  for titles and bodies drafted apart from the commits, or when the user has
  one already.
- Use **`Pull Request:` lines** (`jjack submit -r <rev>`) for a stack where
  each change is one PR, titled with its description's first line. Pass the
  top change. Each change from the main branch up to it is a PR of its own.

Pass the source to every command that takes one. There is no default.

## The stack file

Keep a stack in a directory of its own, with the body files next to the
stack file. jjack rewrites the file on every push, so it must not be checked
in. jj records every file it doesn't ignore in the working-copy change. Use
a directory outside the repository, or one inside it that is already
ignored, such as `.claude/notes/<YYYY-MM-DD>-<slug>-stack/` if `.claude/notes`
is ignored. Check the ignore rules before writing the file inside a
workspace: in a colocated repository, `git check-ignore <path>` prints the
path when it is ignored. If jj recorded the file anyway (`jj status` lists
it), ignore it and then run `jj file untrack <path>`.

```json
{
  "prs": [
    { "tip": "routes", "body": "routes.md" },
    { "tip": "kxqzwmvtnlop", "title": "Document the handlers" }
  ]
}
```

- `tip` is a local bookmark or a change ID for the PR's top change. The PR's
  changes run from its tip down to the tip below it, or to the main branch.
- `body` is a markdown file, relative to the stack file's directory. A `# `
  heading at its start is the PR's title, and the rest is the PR's
  description. `title` is for an entry without a body file or heading.
- jjack writes `pr`, `synced`, `pushed`, and `merged`. Don't add or edit
  them, except where an error's message says to remove one.
- Leave keys you don't recognize in place. jjack keeps them.

To start one, describe every change, put a bookmark on each PR's top change
or note its change ID, and write the file from the tips. `--tips` takes a jj
revset:

```sh
jjack init .claude/notes/2026-11-19-routes-stack/stack.json --tips 'routes | kxqzwmvtnlop'
```

Then write a body file for each entry and set `body`, or keep the `title`
that `init` wrote.

## The loop

1. Run `jjack status <file> --json`. Its result has each entry's changes,
   what changed since the last push (`sincePushed`), what `submit` would do
   (`actions`, each `{ kind, text }`, where `text` is the sentence `status`
   prints; empty when the entry is up to date, and absent when the entry is
   merged or a problem prevents planning it), any title or body edited only
   on GitHub (`keptFromGithub`), and `problems`. Each change has its full `changeId` and
   `commit`, and `pushedCommit`: the commit ID of its version as of the last
   `submit`,
   or null for a change that is new since then. Handle every problem before
   submitting, as "When a command refuses" says. `status` takes a stack file
   only. For `-r`, run `jjack submit -r <rev> --dry-run --json`.
2. Run `jjack submit <file> --json` when the user says to push. Each entry
   of `result.pullRequests` has its number, URL, branches, and `action`:
   `create`, `update`, or `none`. For an update, `updates` lists what it
   does: `push` (commits for edits), `merge` (of the PR below or the main
   branch), and `retarget` (a new base). `-m '<message>'` sets the message of each
   update's last commit, such as a summary of the review comments it
   addresses. Without it, that commit is `Update`, or `Merge …` for a merge.
   `--upto <tip>` pushes the entries up to that one and leaves the rest as
   they are.
3. Run `jjack land <file> --json` when the user says to land. It
   squash-merges the PRs bottom first, then syncs: it abandons the merged
   changes, rebases the rest onto the main branch, and marks the merged
   entries. `result.sync` has what the sync did. When the sync stops, the
   land still succeeded. `result.sync` is then null. `result.syncError` has
   the sync's error, with the sync command in `fix` when the error has none
   of its own. Handle it as below (most often `local_differs_from_merged`,
   which needs the user), then run the sync command.

Give `land` a long timeout. GitHub can take a minute after each merge to
rebase the rest of the stack, and `land` waits for that. It does not wait
for CI. When every PR in the stack has merged, the sync moves an empty
working copy with no description from the old main commit onto the new one.
`result.sync.movedWorkingCopy` is then true. When it is false, leave the
working copy where it is and tell the user.

If a PR merged on GitHub some other way, run `jjack sync`. `submit` refuses
until that sync has run.

## Changing a stack

There are no commands to add, move, or remove entries. Edit the JSON, then
run `status`.

- **Edit a change.** Edit it in jj as usual. `submit` adds an update commit
  to that PR's branch and a merge commit to each PR above it.
- **Add a change to a PR.** A change inserted below the tip is in the PR
  already. For one at the top, use `jj new --insert-after <tip>` so the PRs
  above are rebased onto it. jj leaves the bookmark where it was, so move it
  (`jj bookmark move <name> --to <rev>`) or put the new change ID in `tip`.
  Otherwise the new change is in the PR above.
- **Add a PR.** Add an entry with `tip` and `body` or `title` at its place
  in `prs`.
- **Reorder PRs.** Reorder the changes in jj and the entries in the file to
  match.
- **Change a title or body.** Edit the body file or `title`. `submit`
  updates GitHub. A title or body edited only on GitHub is kept.
- **Drop a PR.** If the PR is open, close it first, with the user's
  approval. With a stack file, run `jjack close <file> --pr <tip>`, then
  remove the entry. Ask the user whether to abandon the PR's changes or keep
  them as part of the PR above. To abandon them all, abandon the range from
  the tip below (`jj abandon '<tip below>..<tip>'`, or `'trunk()..<tip>'`
  for the bottom entry). `jj abandon <tip>` alone leaves the lower changes
  in the PR above. With `-r`, run `jjack close -r <rev>` on the change
  before abandoning it, since `close -r` needs the change. It also removes
  the change's `Pull Request:` line.

## Taking over a stack pushed with `jj git push`

`jjack adopt <file>` takes over open PRs whose branch has the same name as
the bookmark at an entry's tip. It changes nothing on GitHub.

1. Write the file with `jjack init`, with each PR's bookmark as its tip.
2. Run `jjack adopt <file> --dry-run` and show the user the output.
3. Tell the user what `adopt` does locally:
   - It untracks the bookmarks from their remote branches and rewrites the
     adopted changes so they stay editable.
   - After the first `submit` that adds commits to an adopted branch, jj
     shows each adopted change as divergent until its PR lands or is closed.
4. Once they agree, run `jjack adopt <file> --json`.
5. Run `jjack status <file> --json` and handle its problems.

Keep bookmarks as the tips of adopted entries. Once a change is divergent,
jj refuses its change ID, so you and the user both have to refer to it by
bookmark or commit ID.

## When a command refuses

The error has a `code`, a `message` that says how to fix it, and often `pr`
and `tip`. `fix` lists the commands that fix the problem, in order, when
there is a known fix. A `jjack sync` in `fix` is safe to run. Ask before
running a `jj config set`, or a `submit`, `land`, `close`, or `adopt` that
isn't the command the user already asked for. After a `submit` that stopped
partway or a `land` that landed some of the PRs, `partial` has what was
done. After fixing a refusal, run the refused command again.

When the code is `problems`, the stack file has problems, each with its own
`code`, `tip`, and `message`. `status` lists the same ones.

Fix these yourself:

- `no_title`, `body_unreadable`: give the entry a `title`, or a body file
  that starts with a `# ` heading.
- `no_description`: describe the change with `jj describe`.
- `tip_invalid`, `tip_not_found`, `tip_conflicted`, `tip_divergent`: set
  `tip` to a local bookmark or to the change ID of one visible change. A tip
  stops resolving when its bookmark was deleted, its change was abandoned,
  or it is the change ID of an adopted change that became divergent.
- `tips_not_in_line`, `not_a_line`, `no_changes`: the entries don't match
  the changes. Two tips are the same change, a tip is below the one before
  it, an entry's changes branch, or a tip is already on the main branch. Fix
  the tips or the order of the entries. If the changes themselves need
  rebasing, ask the user first.
- `merged`, `needs_sync`: run the `jjack sync` in `fix`.
- `head_not_fetched`: run `jj git fetch`.
- `timeout`: GitHub was slow. Try again in a minute.

These need the user's decision:

- `config`: a setting or the GitHub token is missing. For a missing branch
  prefix, `fix` has a `jj config set` command with a suggested prefix. Ask
  the user which prefix they want. For the token, ask them to run
  `gh auth login`.
- `conflicts`: resolve the conflicts with the user.
- `closed`: a PR was closed. Ask whether to drop the entry (see "Drop a PR")
  or open a new PR. For a new one, remove the keys the message lists, or the
  `Pull Request:` line, and then `submit` opens it. From `close`, the PR is
  closed already: remove the entry, or the change's `Pull Request:` line.
- `text_changed_both`: the title or body changed in the file and on GitHub.
  Ask the user which to keep before changing either. To keep GitHub's, copy
  it into the file (`gh pr view <n> --json title,body`). To keep the file's,
  or a mix of both written into the file, pass `--overwrite-github`.
- `unlisted_in_stack`: an open PR in the GitHub stack has no entry. Ask
  whether to put the entry back or close the PR. `jjack close` can't close a
  PR without an entry, so close it with `gh pr close <n>` once they approve.
- `remote_changes`: someone else may have pushed to the branch. Show the
  user the PR's commits (`gh pr view <n> --json commits`). Bring the edits
  they want to keep into the local changes, or pass
  `--discard-remote-changes` with their approval.
- `has_pull_request_line`, `invalid_pull_request_line`: a change has a
  `Pull Request:` line jjack can't use here. Ask which line to keep, or
  which source the change belongs to.
- `local_differs_from_merged`: a merged PR's change has local edits that
  never reached GitHub. Ask whether to move them into another change
  (`jj split` or `jj squash --into`) or abandon them, then sync.
- `not_submitted`: a PR doesn't exist yet. From `land`, `fix` has the
  `submit` that opens it. From `close`, there is nothing to close: remove
  the entry if the user wants it dropped, or do nothing for `-r`. Don't open
  a PR only to close it.
- `stack_rebuild_incomplete`: the GitHub stack has to be rebuilt, which
  needs every PR in it, including ones this `submit --upto` leaves out. Ask
  before running `submit` without `--upto`, which republishes every PR in
  the stack.
- `stack_mismatch`, `wrong_base`: GitHub's PRs don't match the source. Run
  the `submit` in `fix` once the user agrees, or land the PR below first.
- `draft`, `review`, `blocked`, `merge_queued`: GitHub won't merge the PR
  yet. Tell the user which PR and why, and run `land` again once they say
  it is ready. If some PRs landed first, run the `jjack sync` in `fix` now.
- `not_mergeable`: the PR conflicts with the main branch. Run `sync` and
  resolve the conflicts with the user. Then ask to run `submit`, and `land`
  again after it.
- `changed_externally`: the PR's branch changed on GitHub while `land` ran.
  Tell the user, and run `land` again once they agree.

`jj`, `git`, `github`, and `internal` are failures of the tools underneath.
Show the user the message. A `github` error has the HTTP `status`.
`usage` means the arguments were wrong.
