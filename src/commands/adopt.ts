// `jjack adopt`: take over pull requests opened without jjack. For each entry
// without a pr key whose tip is a local bookmark, find the open pull request
// whose branch has the bookmark's name, and write the entry's pr, pushed, and
// synced keys, so that submit updates it instead of opening a new one. It
// changes nothing on GitHub. Since synced has the entry's current title and
// body, submit keeps GitHub's where they differ.

import { writeFile } from "node:fs/promises"
import { join } from "node:path"

import { reading, type Ctx } from "../context.ts"
import { JjackError, type AdoptResult, type Text } from "../model.ts"
import {
  activeEntries,
  baseDir,
  entryText,
  entryTextFrom,
  readStackFile,
  writeStackFile,
} from "../stack_file.ts"
import {
  differingParts,
  formatPrList,
  githubText,
  pullRequestUrl,
  quote,
  textHash,
  trunkRevset,
} from "../text.ts"

export interface AdoptOptions {
  /** Copy each pull request's title and body into its entry's body file */
  copyGithubText?: boolean
  dryRun?: boolean
}

export async function adopt(
  ctx: Ctx,
  path: string,
  options: AdoptOptions = {},
): Promise<AdoptResult> {
  if (options.dryRun) ctx = reading(ctx)
  const { repo, gh, config, out } = ctx
  const file = await readStackFile(path)
  const dir = baseDir(path)
  const remote = config.remote
  const result: AdoptResult = {
    dryRun: !!options.dryRun,
    adopted: [],
    skipped: [],
    untracked: [],
    rewritten: 0,
  }
  const skip = (tip: string, reason: string) => result.skipped.push({ tip, reason })
  for (const index of activeEntries(file)) {
    const entry = file.prs[index]
    if (entry.pr !== undefined) continue
    const tip = entry.tip
    const bookmarkCommits = await repo.bookmarkCommits(tip)
    if (bookmarkCommits.length !== 1) {
      const reason =
        bookmarkCommits.length > 1
          ? `'${tip}' is a conflicted bookmark: it points to ${bookmarkCommits.length} changes. Resolve it with \`jj bookmark set\` before adopting.`
          : `'${tip}' is not a local bookmark, so it has no branch to adopt.`
      out.line("➖", reason)
      skip(tip, reason)
      continue
    }
    // What was last pushed, from the local remote-tracking branch
    const pushed = await repo.ref(`refs/remotes/${remote}/${tip}`)
    const found = await gh.pullRequestsForBranch(tip)
    const open = found.filter((pr) => pr.state === "open").map((pr) => pr.number)
    if (open.length === 0) {
      for (const pr of found) {
        out.line(
          "➖",
          `#${pr.number}, from ${tip}, ${pr.state === "merged" ? "has merged" : "is closed"}.`,
        )
      }
      const none = found.length === 0 ? `No pull request has ${tip} as its branch. ` : ""
      const reason = `${none}Leaving '${tip}' alone: the next submit opens a new pull request for it.`
      out.line("➖", reason)
      skip(tip, reason)
      continue
    }
    if (open.length > 1) {
      const reason = `${formatPrList(open)} are open from ${tip}. Leaving '${tip}' alone: set the entry's pr to the right one.`
      out.warn(reason)
      skip(tip, reason)
      continue
    }
    const number = open[0]
    const pr = await gh.pullRequest(number)
    const github = githubText(pr)
    out.line(
      "#️⃣",
      `${options.dryRun ? "Would adopt" : "Adopted"} #${number} for '${tip}': ${pullRequestUrl(config, number)}`,
    )

    let text: Text | string
    const readText = async (read: () => Promise<{ text: Text }>) => {
      try {
        return (await read()).text
      } catch (e) {
        return (e as Error).message
      }
    }
    text = await readText(() => entryText(entry, dir))
    if (options.copyGithubText && entry.body !== undefined) {
      const markdown =
        github.body === "" ? `# ${github.title}\n` : `# ${github.title}\n\n${github.body}\n`
      const bodyPath = join(dir, entry.body)
      if (!options.dryRun) {
        try {
          await writeFile(bodyPath, markdown)
        } catch (e) {
          throw new JjackError("io", `Could not write ${bodyPath}: ${(e as Error).message}`)
        }
      }
      out.line(
        "📝",
        `${options.dryRun ? "Would copy" : "Copied"} GitHub's title and body to ${bodyPath}`,
      )
      text = await readText(async () => entryTextFrom(entry, markdown))
    } else if (options.copyGithubText) {
      out.warn(
        `The entry of '${tip}' has no body file to copy GitHub's title and body to. Add a body key and copy them by hand, since adopt now skips the entry.`,
      )
    }

    // The file's text as `synced`: submit keeps GitHub's while the file stays
    // as it is
    let synced: string | undefined
    let compared: AdoptResult["adopted"][number]["text"] = "unreadable"
    if (typeof text === "string") {
      out.warn(text)
    } else {
      const differ = differingParts(text, github)
      compared = differ === null ? "matches" : "differs"
      if (differ === null) out.line("✅", "The title and body match GitHub's.")
      else {
        const verb = differ === "title and body" ? "differ" : "differs"
        out.line(
          "✋",
          `The ${differ} ${verb} from GitHub's. The next submit keeps GitHub's unless it gets --overwrite-github.`,
        )
      }
      synced = textHash(text)
    }
    if (pushed === null) {
      out.warn(
        `There is no remote-tracking bookmark ${tip}@${remote}, so the entry gets no pushed key.`,
      )
    }
    entry.pr = number
    if (pushed === null) delete entry.pushed
    else entry.pushed = pushed
    if (synced === undefined) delete entry.synced
    else entry.synced = synced
    result.adopted.push({ tip, number, text: compared })
  }
  if (result.adopted.length > 0 && !options.dryRun) await writeStackFile(path, file)
  const adopted = result.adopted.map((a) => a.tip)
  Object.assign(result, await untrackAdopted(ctx, adopted, !!options.dryRun))
  return result
}

const changesText = (n: number) => `${n} change${n === 1 ? "" : "s"}`

/**
 * Stop tracking the remote branches of the adopted bookmarks: jjack adds
 * commits to the branch, and a tracked bookmark would move to those commits,
 * or become conflicted, on the next fetch. By default, jj treats the changes
 * on an untracked remote branch as immutable, so the changes that untracking
 * makes immutable are rewritten with the same content: the new commits are
 * editable, and the old ones are hidden. Returns the bookmarks untracked and
 * how many changes were rewritten, or would be in a dry run.
 */
async function untrackAdopted(
  ctx: Ctx,
  adopted: string[],
  dryRun: boolean,
): Promise<{ untracked: string[]; rewritten: number }> {
  const { repo, config, out } = ctx
  const remote = config.remote
  const bookmarks: string[] = []
  for (const tip of adopted) {
    const listing = await repo.jj([
      "bookmark",
      "list",
      "--all-remotes",
      "-T",
      `if(remote == ${quote(remote)}, tracked ++ "\\n")`,
      `exact:${tip}`,
    ])
    if (listing.trim() === "true") bookmarks.push(tip)
  }
  if (bookmarks.length === 0) return { untracked: [], rewritten: 0 }
  const tips = bookmarks.map((b) => `bookmarks(exact:${quote(b)})`).join(" | ")
  const remotes = bookmarks
    .map((b) => `remote_bookmarks(exact:${quote(b)}, exact:${quote(remote)})`)
    .join(" | ")
  const pushed = await repo.commitIds(
    `(${trunkRevset(config)}..(${tips})) & ::(${remotes}) & mutable()`,
  )
  if (dryRun) {
    for (const bookmark of bookmarks) out.line("🔖", `Would untrack ${bookmark}@${remote}`)
    if (pushed.length > 0) {
      out.line(
        "♻️",
        `Would rewrite ${changesText(pushed.length)} with the same content if untracking makes them immutable, as it does by default`,
      )
    }
    return { untracked: bookmarks, rewritten: pushed.length }
  }
  await repo.jj([
    "bookmark",
    "untrack",
    "--quiet",
    "--remote",
    remote,
    ...bookmarks.map((b) => `exact:${b}`),
  ])
  for (const bookmark of bookmarks) {
    out.line(
      "🔖",
      `Untracked ${bookmark}@${remote}, so that ${bookmark} stays on your changes when jjack adds commits to the branch.`,
    )
  }
  if (pushed.length === 0) return { untracked: bookmarks, rewritten: 0 }
  const nowImmutable = await repo.commitIds(`(${pushed.join(" | ")}) & immutable()`)
  if (nowImmutable.length === 0) return { untracked: bookmarks, rewritten: 0 }
  await repo.jj([
    "metaedit",
    "--force-rewrite",
    "--ignore-immutable",
    "--quiet",
    nowImmutable.join(" | "),
  ])
  out.line(
    "♻️",
    `Rewrote ${changesText(nowImmutable.length)} with the same content, so that they stay editable: jj treats the changes on an untracked remote branch as immutable.`,
  )
  return { untracked: bookmarks, rewritten: nowImmutable.length }
}
