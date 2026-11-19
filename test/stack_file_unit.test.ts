import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { assertLine } from "../src/description.ts"
import { JjackError, type Change } from "../src/model.ts"
import {
  activeEntries,
  baseDir,
  createStackFile,
  entryText,
  parseStackFile,
  readStackFile,
  stackFileText,
  writeStackFile,
  type Entry,
} from "../src/stack_file.ts"
import { normalizeText, splitHeading, textHash } from "../src/text.ts"

const dirs: string[] = []
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "jjack-stack-file-"))
  dirs.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

const entry = (title?: string, body?: string): Entry => ({
  tip: "a",
  title,
  body,
  other: {},
})

describe("stack file", () => {
  it("writes keys in a fixed order and keeps unknown ones", () => {
    const text = `{"zeta": 1, "prs": [
      {"merged": true, "x-note": "kept", "pushed": "c0ffee", "synced": "sha256:00",
       "pr": 51, "body": "a.md", "title": "A", "tip": "a"},
      {"tip": "b"}
    ]}`
    const file = parseStackFile(text)
    const written = stackFileText(file)
    expect(written).toBe(`{
  "prs": [
    {
      "tip": "a",
      "title": "A",
      "body": "a.md",
      "pr": 51,
      "synced": "sha256:00",
      "pushed": "c0ffee",
      "merged": true,
      "x-note": "kept"
    },
    {
      "tip": "b"
    }
  ],
  "zeta": 1
}
`)
    // Reading what was written gives the same text.
    expect(stackFileText(parseStackFile(written))).toBe(written)
  })

  it("rejects entries without a tip", () => {
    expect(() => parseStackFile(`{"prs": [{"title": "A"}]}`)).toThrow()
    expect(() => parseStackFile(`{"prs": [{"tip": "a", "pr": "51"}]}`)).toThrow()
    expect(() => parseStackFile(`{}`)).toThrow()
  })

  it("skips merged entries and stops at upto", () => {
    const file = parseStackFile(
      `{"prs": [{"tip": "a", "merged": true}, {"tip": "b"}, {"tip": "c"}]}`,
    )
    expect(activeEntries(file)).toEqual([1, 2])
    expect(activeEntries(file, "b")).toEqual([1])
    expect(() => activeEntries(file, "a")).toThrow(JjackError)
    expect(() => activeEntries(file, "d")).toThrow(JjackError)
  })

  it("takes the title from the heading", () => {
    expect(splitHeading("# Title\n\nBody.\n")).toEqual({
      heading: "Title",
      body: "\nBody.\n",
    })
    expect(splitHeading("\n# Title")).toEqual({ heading: "Title", body: "" })
    expect(splitHeading("## Not a title\n")).toEqual({
      heading: null,
      body: "## Not a title\n",
    })
    expect(splitHeading("Body only")).toEqual({ heading: null, body: "Body only" })
    expect(splitHeading("#\nBody")).toEqual({ heading: null, body: "#\nBody" })
  })

  it("reads text from the body file or the title key", async () => {
    const dir = tempDir()
    writeFileSync(join(dir, "h.md"), "# From heading\n\nThe body.\n")
    writeFileSync(join(dir, "plain.md"), "Just a body.\r\nTwo lines.\n")

    const heading = await entryText(entry("Key", "h.md"), dir)
    expect(heading.text).toEqual({ title: "From heading", body: "The body." })
    expect(heading.source).toBe("heading")

    const plain = await entryText(entry("Key", "plain.md"), dir)
    expect(plain.text).toEqual({ title: "Key", body: "Just a body.\nTwo lines." })
    expect(plain.source).toBe("key")

    expect((await entryText(entry("Key"), dir)).text).toEqual({ title: "Key", body: "" })

    await expect(entryText(entry(undefined, "plain.md"), dir)).rejects.toThrow(JjackError)
    await expect(entryText(entry("  "), dir)).rejects.toThrow(JjackError)
    await expect(entryText(entry("Key", "missing.md"), dir)).rejects.toThrow(/missing\.md/)
  })

  it("hashes normalized text alike", () => {
    const a = normalizeText(" Title ", "\n\nBody\r\nmore\n\n")
    const b = normalizeText("Title", "Body\nmore")
    expect(a).toEqual(b)
    expect(textHash(a)).toBe(textHash(b))
    expect(textHash(a)).toMatch(/^sha256:/)
    expect(textHash({ title: "Title", body: "Body" })).not.toBe(
      textHash({ title: "Title\nBody", body: "" }),
    )
  })

  it("writes and creates", async () => {
    const dir = tempDir()
    const path = join(dir, "stack", "stack.json")
    const file = { prs: [entry("A")], other: {} }
    await createStackFile(path, file)
    await expect(createStackFile(path, file)).rejects.toThrow(JjackError) // refuses to replace
    const read = await readStackFile(path)
    read.prs[0].pr = 7
    await writeStackFile(path, read)
    expect((await readStackFile(path)).prs[0].pr).toBe(7)
    expect(baseDir(path)).toBe(join(dir, "stack"))
    expect(baseDir("stack.json")).toBe(".")

    // Parent path that cannot be created throws JjackError("io")
    await expect(createStackFile(join(path, "nested.json"), file)).rejects.toMatchObject({
      code: "io",
    })
  })

  it("assertLine adapts its error message to the source", () => {
    const merge: Change = {
      commit: "abcdef1234567890",
      changeId: "kkkkkkkk",
      parents: ["1111111", "2222222"],
      description: "Merge",
      conflict: false,
    }
    expect(() => assertLine([merge], "syncing", { file: "stack.json" })).toThrow(
      "Not syncing: the changes of stack.json are not a single line of changes (abcdef1 is a merge).",
    )
    expect(() => assertLine([merge], "syncing", { revision: "@" })).toThrow(
      "Not syncing: the changes up to the target are not a single line of changes (abcdef1 is a merge). Pass `-r <top of one stack>` to pick one stack.",
    )
  })
})
