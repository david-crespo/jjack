// The configuration, from flags, jj config, and the GitHub remote's URL, and
// the GitHub token. Each jjack.* key falls back to the spr.* key that jj-spr
// reads, so a repository set up for jj-spr works as it is.

import { JjackError, type Config } from "./model.ts"
import { run } from "./proc.ts"
import type { Repo } from "./repo.ts"
import { shellWord } from "./text.ts"

export interface Flags {
  token?: string
  repository?: string
  branchPrefix?: string
}

/** Each jjack.* key, without its prefix, and its spr.* fallback */
const FALLBACKS = {
  branchPrefix: "branchPrefix",
  repository: "githubRepository",
  remote: "githubRemoteName",
  mainBranch: "githubMasterBranch",
  requireApproval: "requireApproval",
  apiUrl: "githubApiUrl",
  token: "githubAuthToken",
} as const

type Key = keyof typeof FALLBACKS

/** A setting's value: the jjack.* key's, then the spr.* key's, or null.
 * Empty values count as unset. */
async function settings(repo: Repo): Promise<(key: Key) => string | null> {
  const listing = await repo
    .reading()
    .jj(["config", "list", "-T", 'name ++ "\\t" ++ json(value) ++ "\\n"'])
    .catch(() => "")
  const values = new Map<string, string>()
  for (const line of listing.split("\n")) {
    const tab = line.indexOf("\t")
    const name = line.slice(0, tab)
    if (tab === -1 || !/^(jjack|spr)\./.test(name)) continue
    const value = String(JSON.parse(line.slice(tab + 1))).trim()
    if (value !== "") values.set(name, value)
  }
  return (key) => values.get(`jjack.${key}`) ?? values.get(`spr.${FALLBACKS[key]}`) ?? null
}

/** The `owner/repo` of a github.com remote URL, in its HTTPS or SSH form. null
 * for anything else, such as an SSH host alias or a GitHub Enterprise host:
 * those need jjack.repository. */
export function repositoryFromRemoteUrl(url: string): string | null {
  return (
    url.match(/(?:^|[/@])github\.com[/:]([\w\-.]+\/[\w\-.]+?)(?:\.git)?\/?$/)?.[1] ?? null
  )
}

/** The settings that need no GitHub: the remote and the main branch */
async function localSettings(
  repo: Repo,
  setting: (key: Key) => string | null,
): Promise<Pick<Config, "main" | "remote">> {
  const remote = setting("remote") ?? "origin"
  return { remote, main: setting("mainBranch") ?? (await trunkBranch(repo, remote)) }
}

/**
 * The main branch when no setting has it: the bookmark on `remote` at jj's
 * `trunk()`, so a repository whose main branch is `master` needs no setting.
 * "main" when `trunk()` has no bookmark on `remote`, as when it is `root()`
 * or a bookmark on another remote. `trunk()` is never the revset itself: it
 * is an alias the user can change, and it falls back to `root()`, which
 * would put every commit in the bottom pull request.
 */
async function trunkBranch(repo: Repo, remote: string): Promise<string> {
  const listing = await repo
    .reading()
    .jj([
      "log",
      "--no-graph",
      "-r",
      "trunk()",
      "-T",
      'remote_bookmarks.map(|b| "[" ++ json(b.name()) ++ "," ++ json(b.remote()) ++ "]").join("\n")',
    ])
    .catch(() => "")
  const names = listing
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as [string, string])
    .flatMap(([name, on]) => (on === remote ? [name] : []))
  // Other branches can be at the same commit
  return (
    ["main", "master", "trunk"].find((name) => names.includes(name)) ??
    (names.length === 1 ? names[0] : "main")
  )
}

export const loadLocalConfig = async (repo: Repo) =>
  localSettings(repo, await settings(repo))

/** The configuration and the GitHub token, from one read of jj's config */
export async function loadConfig(
  repo: Repo,
  flags: Flags,
  env: Record<string, string> = {},
): Promise<{ config: Config; token: string }> {
  const setting = await settings(repo)
  const { remote, main } = await localSettings(repo, setting)
  let repository = flags.repository ?? setting("repository")
  if (repository === null) {
    const url = await repo.git(["remote", "get-url", remote])
    if (!url.success) {
      throw new JjackError(
        "config",
        `jjack.repository is not configured, and remote '${remote}' does not exist. ` +
          "Set jjack.repository to OWNER/REPO, or jjack.remote to the GitHub remote.",
      )
    }
    repository = repositoryFromRemoteUrl(url.stdout.trim())
    if (repository === null) {
      throw new JjackError(
        "config",
        `jjack.repository is not configured. The URL of remote '${remote}' ` +
          `(${url.stdout.trim()}) is not a github.com URL, so the repository can't be read ` +
          "from it. Set jjack.repository to OWNER/REPO.",
      )
    }
  }
  const parts = repository.match(/^([\w\-.]+)\/([\w\-.]+)$/)
  if (!parts) {
    throw new JjackError(
      "config",
      `GitHub repository must be given as 'OWNER/REPO', but given value was '${repository}'`,
    )
  }
  const branchPrefix = flags.branchPrefix ?? setting("branchPrefix")
  if (branchPrefix === null) throw await missingPrefix(repo)
  const config = {
    owner: parts[1],
    repo: parts[2],
    remote,
    main,
    branchPrefix,
    requireApproval: setting("requireApproval")?.toLowerCase() === "true",
    apiUrl: (setting("apiUrl") ?? "https://api.github.com").replace(/\/+$/, ""),
  }
  return { config, token: await authToken(flags, setting("token"), env) }
}

/** The error for a missing branch prefix, with a command that sets one: the
 * jj user's email address up to the @, or `jjack/` */
async function missingPrefix(repo: Repo): Promise<JjackError> {
  const email = await repo
    .reading()
    .jj(["config", "get", "user.email"])
    .catch(() => "")
  const name = email
    .trim()
    .split("@")[0]
    .replace(/[^\w.-]/g, "")
  const command = `jj config set --repo jjack.branchPrefix ${shellWord(`${name || "jjack"}/`)}`
  return new JjackError(
    "config",
    "jjack.branchPrefix must be configured: the start of the names of the branches " +
      `jjack pushes. Set it with \`${command}\`, or pass --branch-prefix.`,
    { fix: [command] },
  )
}

/** The flag, then jjack.token, then `gh auth token` */
async function authToken(
  flags: Flags,
  setting: string | null,
  env: Record<string, string>,
): Promise<string> {
  const flag = flags.token?.trim()
  const token = flag ? flag : setting
  if (token !== null) return token
  const gh = await run("gh", ["auth", "token"], {
    env: { ...process.env, ...env },
  }).catch(() => null)
  if (gh?.success && gh.stdout.trim() !== "") return gh.stdout.trim()
  throw new JjackError(
    "config",
    "No GitHub token: pass --token, set jjack.token, or log in with `gh auth login`.",
  )
}
