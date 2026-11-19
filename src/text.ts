// Pure string functions: titles and bodies, branch names, the `Pull Request:`
// line, and the small formatting helpers every layer uses.

import { createHash } from "node:crypto"

import type { Config, Hints, PullRequest, Source, Text, TextParts } from "./model.ts"

/** The revset of the main branch as jj sees it, e.g. `main@origin`. A name
 * that jj can't read as a bare symbol is quoted: `"my branch"@origin`. */
export function trunkRevset(config: Pick<Config, "main" | "remote">): string {
  const symbol = (name: string) =>
    /^\w+([-+./]\w+)*$/.test(name) ? name : JSON.stringify(name)
  return `${symbol(config.main)}@${symbol(config.remote)}`
}

/** The main branch's remote-tracking ref */
export const mainRef = (config: Config) => `refs/remotes/${config.remote}/${config.main}`

export const pullRequestUrl = (config: Config, number: number) =>
  `https://github.com/${config.owner}/${config.repo}/pull/${number}`

/** `arg` as one shell word, quoted when it has to be */
export const shellWord = (arg: string) =>
  /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`

/** The commands messages suggest for a stack file */
export function fileHints(name: string): Hints {
  const path = shellWord(name)
  return {
    sync: `jjack sync ${path}`,
    submit: `jjack submit ${path}`,
    land: `jjack land ${path}`,
    reopen: `remove the entry's pr and synced keys and run \`jjack submit ${path}\``,
  }
}

/** The commands messages suggest for the changes up to a revision */
export function revisionHints(rev: string): Hints {
  const r = shellWord(rev)
  return {
    sync: `jjack sync -r ${r}`,
    submit: `jjack submit -r ${r}`,
    land: `jjack land -r ${r}`,
    reopen: `remove the change's \`Pull Request:\` line and run \`jjack submit -r ${r}\``,
  }
}

/** The commands messages suggest for `source` */
export const hintsFor = (source: Source): Hints =>
  "file" in source ? fileHints(source.file) : revisionHints(source.revision)

/** The first eight characters of a change ID, for messages */
export const short = (changeId: string) => changeId.slice(0, 8)

/** "#1, #2", with null for a pull request a dry run would create */
export const formatPrList = (numbers: (number | null)[]) =>
  numbers.map((n) => (n === null ? "a new pull request" : `#${n}`)).join(", ")

/** `text` as a string literal in a revset */
export const quote = (text: string) =>
  `"${text.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`

/** A change's title: the first line of its description */
export const firstLine = (description: string) => description.split("\n")[0].trim()

/**
 * A title and body normalized so they compare equal to GitHub's copy: a
 * trimmed title, and a body with `\n` line endings, without whitespace at the
 * end or blank lines at the start.
 */
export function normalizeText(title: string, body: string): Text {
  let rest = body.replaceAll("\r\n", "\n").trimEnd()
  for (;;) {
    const newline = rest.indexOf("\n")
    if (newline === -1 || rest.slice(0, newline).trim() !== "") break
    rest = rest.slice(newline + 1)
  }
  return { title: title.trim(), body: rest }
}

export const sameText = (a: Text, b: Text) => a.title === b.title && a.body === b.body

/** A pull request's title and body normalized like local text */
export const githubText = (pr: Pick<PullRequest, "title" | "body">): Text =>
  normalizeText(pr.title, pr.body)

/** Which of the title and body differ between `a` and `b`, or null */
export function differingParts(a: Text, b: Text): TextParts | null {
  const title = a.title !== b.title
  const body = a.body !== b.body
  return title && body ? "title and body" : title ? "title" : body ? "body" : null
}

/** The value of a stack file's `synced` key for a title and body: SHA-256 of
 * the JSON array `[title, body]`. */
export function textHash(text: Text): string {
  const json = JSON.stringify([text.title, text.body])
  return "sha256:" + createHash("sha256").update(json).digest("hex")
}

/**
 * Split a leading `# ` heading off markdown: the heading's text, and the
 * rest. Blank lines before the heading are allowed.
 */
export function splitHeading(markdown: string): { heading: string | null; body: string } {
  const start = markdown.trimStart()
  if (start.startsWith("# ")) {
    const rest = start.slice(2)
    const newline = rest.indexOf("\n")
    const line = newline === -1 ? rest : rest.slice(0, newline)
    const heading = line.trim().replace(/#+$/, "").trimEnd()
    if (heading !== "")
      return { heading, body: newline === -1 ? "" : rest.slice(newline + 1) }
  }
  return { heading: null, body: markdown }
}

export function slugify(text: string): string {
  return text
    .trim()
    .normalize("NFD")
    .replace(/\s/g, "-")
    .replace(/[^A-Za-z0-9_-]/g, "")
    .toLowerCase()
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
}

/** The longest slug in a new branch name. GitHub refuses a ref name longer
 * than 255 bytes. */
const MAX_SLUG_LEN = 100

/** `slug` cut to `MAX_SLUG_LEN`, after its last whole word when that keeps at
 * least half of it */
export function capSlug(slug: string): string {
  if (slug.length <= MAX_SLUG_LEN) return slug
  const cut = slug.slice(0, MAX_SLUG_LEN)
  let words = cut
  if (slug[MAX_SLUG_LEN] !== "-") {
    const end = cut.lastIndexOf("-")
    if (end >= MAX_SLUG_LEN / 2) words = cut.slice(0, end)
  }
  return words.replace(/-+$/, "")
}

/** A name for a new pull request's branch: the prefix and a slug of `title`,
 * with a number added while the name is in `taken` */
export function newBranchName(config: Config, taken: Set<string>, title: string): string {
  const base = config.branchPrefix + (capSlug(slugify(title)) || "pr")
  let name = base
  for (let suffix = 1; taken.has(name); suffix++) name = `${base}-${suffix}`
  return name
}

/** The number a `Pull Request:` value names: `123`, `#123`, or this
 * repository's pull request URL */
export function parsePullRequestField(config: Config, value: string): number | null {
  const number = value.match(/^\s*#?\s*(\d+)\s*$/)
  if (number) return Number(number[1])
  const url = value.match(
    /^\s*https?:\/\/github\.com\/([\w\-.]+)\/([\w\-.]+)\/pull\/(\d+)([/?#].*)?\s*$/,
  )
  if (url && url[1] === config.owner && url[2] === config.repo) return Number(url[3])
  return null
}

const PULL_REQUEST_LINE = /^\s*pull request\s*:\s*(.*)$/i

/** Whether line `index` of a description is a `Pull Request:` line: any line
 * but the first (the title) */
const isLinkLine = (line: string, index: number) =>
  index > 0 && PULL_REQUEST_LINE.test(line)

/** The values of a description's `Pull Request:` lines, leaving out empty ones */
const linkValues = (description: string) =>
  description
    .split("\n")
    .filter(isLinkLine)
    .map((line) => line.match(PULL_REQUEST_LINE)![1].trim())
    .filter((value) => value !== "")

/** Whether a description has a `Pull Request:` line, whatever it links */
export const hasLinkLine = (description: string) => linkValues(description).length > 0

export type Link =
  | { kind: "none" }
  | { kind: "linked"; number: number }
  | { kind: "several"; lines: string[] }
  | { kind: "unreadable"; lines: string[] }

/** The pull request a change's description links in its `Pull Request:`
 * lines. `jj squash` of two changes keeps both lines, so the same number on
 * two lines is one link. */
export function readLink(config: Config, description: string): Link {
  const values = linkValues(description)
  if (values.length === 0) return { kind: "none" }
  const parsed = values.map((value) => parsePullRequestField(config, value))
  const numbers = [...new Set(parsed.filter((n) => n !== null))]
  if (numbers.length > 1) {
    return { kind: "several", lines: values.filter((_, i) => parsed[i] !== null) }
  }
  if (parsed.includes(null)) return { kind: "unreadable", lines: values }
  return { kind: "linked", number: numbers[0] }
}

/** The description without its `Pull Request:` lines and trailing whitespace */
const withoutLinkLines = (description: string) =>
  description
    .split("\n")
    .filter((line, i) => !isLinkLine(line, i))
    .join("\n")
    .trimEnd()

/** A change's title and body as its pull request has them: the first line, and
 * the rest without the `Pull Request:` lines */
export function descriptionText(description: string): Text {
  const [title, ...rest] = withoutLinkLines(description).split("\n")
  return normalizeText(title, rest.join("\n"))
}

/** The description with its `Pull Request:` line set to `url`, as the last
 * line after a blank line, matching jj-spr's format */
export const withLink = (description: string, url: string) =>
  `${withoutLinkLines(description)}\n\nPull Request: ${url}\n`

export function withoutLink(description: string): string {
  const rest = withoutLinkLines(description)
  return rest === "" ? "" : rest + "\n"
}
