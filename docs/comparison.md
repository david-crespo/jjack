# Differences from other stack tools

## `jj-spr`

This is the one my colleagues use. I started out by modifying a version of `jj-spr` that included Mike Zeller's work on the [`native-stacks` branch of `papertigers/jj-spr`](https://github.com/papertigers/jj-spr/tree/native-stacks). Once my modified version was nearly unrecognizable, I rewrote it in TypeScript. jjack pushes updates the same way, as described in the [README](../README.md#how-jjack-does-it-which-is-also-how-jj-spr-does-it). Compared to `jj-spr`'s `main` branch, what's different:

- **Stack files.** In `jj-spr`, each PR is a single jj change, and its title and body come from the change's description. In jjack, a JSON file lists the PRs. Each has a title and body or a pointer to a markdown file containing them. This lets me plan and edit a whole stack before any of it is on GitHub. Without a stack file, `jjack submit -r <rev>` works the `jj-spr` way: each change from the main branch up to `<rev>` becomes its own PR, titled with the first line of its description.
- **Multi-change PRs.** A stack file entry can cover several changes. Each one becomes a commit on the PR's branch.
- **No legacy code path.** On `jj-spr`'s `main` branch, stacks work by pushing an extra base branch for each PR. The `native-stacks` branch adds native GitHub stacks behind `spr.nativeStacks`. jjack only uses GitHub's native stacks, where each PR's base is the branch of the PR below it and GitHub merges and rebases the stack, without the base-branch code path.
- **`land` also syncs.** This matters when you land a PR at the bottom of a stack and keep working on the rest, as with `jjack land --upto <tip>`. `land` merges through GitHub, waits, and then runs `sync`, which abandons the merged changes and rebases the remaining ones onto the new main. On `jj-spr`'s `main` branch, you do that rebase by hand after `jj spr land`. The `native-stacks` branch has `jj spr sync` for the sync step.
- **Bunch of other stuff ripped out.** No independent (`--cherry-pick`) PRs, no reviewers, no `amend`, `format`, `list`, `patch`, or `cleanup`, and no interactive prompts.
- **It's a TypeScript library too.** Every command is a function that returns typed data. Passing `--json` to the CLI prints the same data. I built it this way for agents and for `ah`.

## `jj-ryu`

[`jj-ryu`](https://github.com/dmmulroy/jj-ryu) is built on bookmarks: each bookmark becomes a PR with the bookmark below it as its base, and every change between two bookmarks goes into that one PR, similar to a stack file entry in jjack. Working from bookmarks is closer to how most people use jj and works without an extra file. `jj-ryu` also supports GitLab.

Differences from jjack:

- It pushes your bookmarks the way `jj git push` does, which is a force-push with a lease. Amending a change replaces the commits on its PR's branch rather than adding commits like jjack does.
- It links a stack's PRs with a comment on each PR, while jjack registers a native GitHub stack.
- It creates a PR with a title and no body. The title is the first line of a change's description.
- It has no command that merges. You merge on GitHub, rebase the rest with jj, and submit again. `ryu sync` fetches and then submits. jjack has `land` for this.

## `jj-stack`

[`jj-stack`](https://github.com/bos/jj-stack) is written in Python and is close to jjack's workflow in several ways: it registers GitHub native stacks, manages PR branches for you, and has `merge` and `sync` commands. `jj-stack` also has its own [comparison of stack tools](https://github.com/bos/jj-stack/blob/main/docs/tool-comparison.md).

Differences from jjack:

- **One change per PR.** Each PR is a single jj change, and existing PRs follow their change IDs when you rewrite, split, squash, or reorder changes locally. jjack supports that mode with `-r`, and also supports multi-change PRs and separate title/body files through a stack file.
- **Force-pushes with a revision-history comment.** On update, `jj-stack` force-pushes the current version of each change and keeps a "Revision history" comment on the PR linking earlier versions and the differences between them. jjack (like `jj-spr`) never force-pushes and instead adds update and merge commits to the PR's branch.
- **Merging and setup.** `jj-stack merge` waits for GitHub (including its merge queue) and then updates your local stack and remaining PRs, and `jj-stack sync` does that follow-up work after a merge done on GitHub. That is close to jjack's `land` and `sync`, except that jjack stops with an error when GitHub puts a pull request in the merge queue. `jj-stack` also has `doctor --fix` to check repo setup and apply safe local fixes.
