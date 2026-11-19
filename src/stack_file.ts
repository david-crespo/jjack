// Stack files: a stack's pull requests, bottom first, before any of them
// exist. Each entry has where its pull request ends (`tip`) and its title and
// body. `submit` pushes them and writes back what it did.
//
//   { "prs": [
//       { "tip": "diff-paths", "body": "diff-paths.md", "pr": 51, "synced": "sha256:…" },
//       { "tip": "kxqzwmvt", "title": "Run jj and git in the diff's directory" } ] }
//
// An entry's changes run from its tip down to the tip of the entry below, or
// to trunk for the bottom entry. Keys the tool doesn't know are kept, and the
// file is always written in one layout.

import { randomBytes } from "node:crypto"
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises"
import { basename, dirname, join } from "node:path"

import { JjackError, type Text } from "./model.ts"
import { normalizeText, splitHeading } from "./text.ts"

/** One pull request of a stack file. People and agents write `tip`, `title`,
 * and `body`; jjack writes the rest. */
export interface Entry {
  /** A bookmark or a change ID: the pull request's top change */
  tip: string
  /** The title, used when there is no body file or it has no heading */
  title?: string
  /** A markdown file, relative to the stack file, with the body. A leading `#`
   * heading is the title. */
  body?: string
  pr?: number
  /** The hash of the title and body last pushed (`textHash`) */
  synced?: string
  /** The local commit at the tip when `submit` last pushed the branch or
   * found it up to date */
  pushed?: string
  /** Set by `sync` once the pull request merged. Every command skips merged
   * entries. */
  merged?: boolean
  /** Keys jjack does not know, kept as they are */
  other: Record<string, unknown>
}

export interface StackFile {
  /** Bottom first */
  prs: Entry[]
  other: Record<string, unknown>
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Parse a stack file's text. Throws the reason it is not valid. */
export function parseStackFile(text: string): StackFile {
  const value: unknown = JSON.parse(text)
  if (!isObject(value)) throw new Error("expected an object")
  const { prs, ...other } = value
  if (!Array.isArray(prs)) throw new Error("missing field `prs`")
  return { prs: prs.map(parseEntry), other }
}

function parseEntry(value: unknown, index: number): Entry {
  const where = `entry ${index + 1}`
  if (!isObject(value)) throw new Error(`${where}: expected an object`)
  const { tip, title, body, pr, synced, pushed, merged, ...other } = value
  if (typeof tip !== "string") throw new Error(`${where}: missing or invalid field \`tip\``)
  const entry: Entry = { tip, other }
  for (const [key, field] of Object.entries({ title, body, synced, pushed })) {
    if (field === undefined || field === null) continue
    if (typeof field !== "string") throw new Error(`${where}: \`${key}\` must be a string`)
    entry[key as "title"] = field
  }
  if (pr !== undefined && pr !== null) {
    if (typeof pr !== "number" || !Number.isInteger(pr) || pr < 0) {
      throw new Error(`${where}: \`pr\` must be a non-negative integer`)
    }
    entry.pr = pr
  }
  if (merged !== undefined) {
    if (typeof merged !== "boolean")
      throw new Error(`${where}: \`merged\` must be a boolean`)
    if (merged) entry.merged = true
  }
  return entry
}

/** Objects with their keys sorted at every depth for stable output */
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted)
  if (!isObject(value)) return value
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sorted(value[key])]),
  )
}

/** The file's text: two-space indent, the keys of each entry in a fixed
 * order, and unknown keys after them */
export function stackFileText(file: StackFile): string {
  const prs = file.prs.map((entry) => ({
    tip: entry.tip,
    title: entry.title,
    body: entry.body,
    pr: entry.pr,
    synced: entry.synced,
    pushed: entry.pushed,
    merged: entry.merged || undefined,
    ...(sorted(entry.other) as object),
  }))
  return JSON.stringify({ prs, ...(sorted(file.other) as object) }, null, 2) + "\n"
}

export async function readStackFile(path: string): Promise<StackFile> {
  let text: string
  try {
    text = await readFile(path, "utf8")
  } catch (e) {
    throw new JjackError("stack_file", `Could not read ${path}: ${(e as Error).message}`)
  }
  try {
    return parseStackFile(text)
  } catch (e) {
    throw new JjackError(
      "stack_file",
      `${path} is not a valid stack file: ${(e as Error).message}`,
    )
  }
}

/** Replace the file at `path`. A rename, so that a failure leaves the old
 * file whole. */
export async function writeStackFile(path: string, file: StackFile): Promise<void> {
  const suffix = `${process.pid}.${randomBytes(6).toString("hex")}`
  const temporary = join(dirname(path), `.${basename(path)}.${suffix}.tmp`)
  try {
    await writeFile(temporary, stackFileText(file))
    await rename(temporary, path)
  } catch (e) {
    await unlink(temporary).catch(() => {})
    throw new JjackError("io", `Could not write ${path}: ${(e as Error).message}`)
  }
}

/** Write a new file at `path`, refusing to replace one */
export async function createStackFile(path: string, file: StackFile): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true })
  } catch (e) {
    throw new JjackError("io", `Could not create ${path}: ${(e as Error).message}`)
  }
  let handle
  try {
    handle = await open(path, "wx")
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") {
      throw new JjackError("file_exists", `${path} already exists.`)
    }
    throw new JjackError("io", `Could not create ${path}: ${(e as Error).message}`)
  }
  try {
    await handle.writeFile(stackFileText(file))
  } catch (e) {
    throw new JjackError("io", `Could not create ${path}: ${(e as Error).message}`)
  } finally {
    await handle.close()
  }
}

/** The index of the entry whose tip is `tip`, as written in the file */
export function findEntry(file: StackFile, tip: string): number {
  const index = file.prs.findIndex((entry) => entry.tip === tip)
  if (index === -1) {
    throw new JjackError(
      "usage",
      `No entry has the tip '${tip}'. The tips are: ${file.prs.map((e) => e.tip).join(", ")}.`,
    )
  }
  return index
}

/** The entries a command works on, bottom first: those not merged, up to and
 * including the one whose tip is `upto` */
export function activeEntries(file: StackFile, upto?: string): number[] {
  let last = file.prs.length - 1
  if (upto !== undefined) {
    last = findEntry(file, upto)
    if (file.prs[last].merged) {
      throw new JjackError("usage", `The entry '${upto}' has merged already.`, {
        tip: upto,
      })
    }
  }
  return file.prs.flatMap((entry, i) => (i <= last && !entry.merged ? [i] : []))
}

/** The directory that body paths are relative to: the stack file's */
export const baseDir = (path: string) => dirname(path)

export type TitleSource = "heading" | "key"

export interface EntryText {
  text: Text
  source: TitleSource
}

/** The entry's title and body if its body file had `markdown`. Throws a
 * JjackError with code "no_title" when it has none. */
export function entryTextFrom(entry: Entry, markdown: string): EntryText {
  const { heading, body } = splitHeading(markdown)
  if (heading !== null) return { text: normalizeText(heading, body), source: "heading" }
  if (entry.title !== undefined && entry.title.trim() !== "") {
    return { text: normalizeText(entry.title, body), source: "key" }
  }
  throw new JjackError(
    "no_title",
    `'${entry.tip}' has no title. Give it a title key, or start its body file with a \`# \` heading.`,
  )
}

/** The entry's title and body: the body file, whose leading `#` heading is
 * the title, with the `title` key when it has no heading. Without a body
 * file, the body is empty. `dir` is the stack file's directory. */
export async function entryText(entry: Entry, dir: string): Promise<EntryText> {
  let markdown = ""
  if (entry.body !== undefined) {
    const path = join(dir, entry.body)
    try {
      markdown = await readFile(path, "utf8")
    } catch (e) {
      throw new JjackError(
        "body_unreadable",
        `The body file of '${entry.tip}', ${path}, could not be read: ${(e as Error).message}`,
      )
    }
  }
  return entryTextFrom(entry, markdown)
}
