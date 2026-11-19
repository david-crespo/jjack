import { describe, expect, it } from "vitest"
import { repositoryFromRemoteUrl } from "../src/config.ts"
import type { Config } from "../src/model.ts"
import {
  capSlug,
  descriptionText,
  newBranchName,
  parsePullRequestField,
  readLink,
  slugify,
  textHash,
  withLink,
  withoutLink,
} from "../src/text.ts"

const config: Config = {
  owner: "acme",
  repo: "codez",
  remote: "origin",
  main: "master",
  branchPrefix: "spr/foo/",
  requireApproval: false,
  apiUrl: "https://api.github.com",
}

const url = "https://github.com/acme/codez/pull/123"

describe("repositoryFromRemoteUrl", () => {
  it("reads github urls", () => {
    for (const u of [
      "https://github.com/acme/widgets",
      "https://github.com/acme/widgets.git",
      "git@github.com:acme/widgets.git",
      "ssh://git@github.com/acme/widgets",
    ]) {
      expect(repositoryFromRemoteUrl(u), u).toBe("acme/widgets")
    }
    expect(repositoryFromRemoteUrl("git@github.com:a-b/c.d.git")).toBe("a-b/c.d")
  })

  it("rejects other urls", () => {
    for (const u of [
      "work:acme/widgets.git",
      "https://github.example.com/acme/widgets",
      "https://gitlab.com/acme/widgets.git",
      "/tmp/repos/widgets",
      "https://github.com/acme",
    ]) {
      expect(repositoryFromRemoteUrl(u), u).toBeNull()
    }
  })
})

describe("branch names", () => {
  it("skip taken ones", () => {
    const taken = new Set(["spr/foo/add-a", "spr/foo/add-a-1"])
    expect(newBranchName(config, taken, "Add A")).toBe("spr/foo/add-a-2")
    expect(newBranchName(config, taken, "Add B")).toBe("spr/foo/add-b")
  })

  it("cut long slugs after a word", () => {
    const slug = capSlug(slugify("word ".repeat(30)))
    expect(slug).toBe("word-".repeat(20).replace(/-+$/, ""))
    // Ending on a whole word
    expect(capSlug("x".repeat(100) + "-more")).toBe("x".repeat(100))
    // One long word is cut where it has to be
    expect(capSlug("y".repeat(150))).toBe("y".repeat(100))
    expect(capSlug("short-slug")).toBe("short-slug")
  })
  it("falls back when a title has no slug characters", () => {
    const taken = new Set(["spr/foo/pr"])
    expect(newBranchName(config, new Set(), "🎉 日本語")).toBe("spr/foo/pr")
    expect(newBranchName(config, taken, "...")).toBe("spr/foo/pr-1")
  })
})

describe("slugify", () => {
  it("handles empty text", () => expect(slugify("")).toBe(""))
  it("collapses and trims", () => {
    expect(slugify(" Hello  World! ")).toBe("hello-world")
    expect(slugify("---foo---")).toBe("foo")
  })
  it("drops accents", () => expect(slugify("ĥêlļō ŵöřľď")).toBe("hello-world"))
})

describe("parsePullRequestField", () => {
  it("rejects empty values", () => {
    for (const v of ["", "   ", "\n"]) expect(parsePullRequestField(config, v)).toBeNull()
  })

  it("reads numbers", () => {
    for (const v of ["123", "   123 ", "#123", " # 123"]) {
      expect(parsePullRequestField(config, v), v).toBe(123)
    }
  })

  it("reads urls", () => {
    for (const v of [
      url,
      `  ${url}  `,
      `${url}/`,
      `${url}?x=a`,
      `${url}/foo`,
      `${url}#abc`,
    ]) {
      expect(parsePullRequestField(config, v), v).toBe(123)
    }
  })

  it("rejects urls of another repository or host", () => {
    expect(
      parsePullRequestField(config, "https://github.com/acme/other/pull/123"),
    ).toBeNull()
    expect(
      parsePullRequestField(config, "https://githubXcom/acme/codez/pull/123"),
    ).toBeNull()
  })
})

describe("readLink", () => {
  it("is none without a pull request line", () => {
    expect(readLink(config, "Title\n\nBody")).toEqual({ kind: "none" })
    // The first line is the title, never a link
    expect(readLink(config, `Pull Request: ${url}`)).toEqual({ kind: "none" })
  })

  it("is linked with one number", () => {
    expect(readLink(config, `Title\n\nPull Request: ${url}\n`)).toEqual({
      kind: "linked",
      number: 123,
    })
    expect(readLink(config, "Title\n\npull request: #7")).toEqual({
      kind: "linked",
      number: 7,
    })
  })

  it("treats a number repeated by squash as one link", () => {
    const squashed = `Title\n\nPull Request: ${url}\n\nChange B\n\nPull Request: ${url}`
    expect(readLink(config, squashed)).toEqual({ kind: "linked", number: 123 })
  })

  it("is several with distinct numbers", () => {
    const two = `Title\n\nPull Request: ${url}\n\nChange B\n\nPull Request: ${url.replace("123", "124")}`
    expect(readLink(config, two)).toEqual({
      kind: "several",
      lines: [url, url.replace("123", "124")],
    })
  })

  it("is unreadable for a value that is not this repository's", () => {
    const other = "https://github.com/acme/other/pull/5"
    expect(readLink(config, `Title\n\nPull Request: ${other}`)).toEqual({
      kind: "unreadable",
      lines: [other],
    })
    expect(readLink(config, "Title\n\nPull Request: soon")).toEqual({
      kind: "unreadable",
      lines: ["soon"],
    })
  })
})

describe("descriptionText", () => {
  it("splits title and body and drops link lines", () => {
    const description = `Title \n\nBody line\nPull Request: ${url}\nmore\n\n`
    expect(descriptionText(description)).toEqual({
      title: "Title",
      body: "Body line\nmore",
    })
  })

  it("keeps a first line that looks like a link as the title", () => {
    expect(descriptionText("Pull Request: x\n\nBody")).toEqual({
      title: "Pull Request: x",
      body: "Body",
    })
  })
})

describe("withLink and withoutLink", () => {
  it("withLink appends the link after a blank line", () => {
    expect(withLink("Title\n\nBody\n", url)).toBe(`Title\n\nBody\n\nPull Request: ${url}\n`)
    expect(withLink("Title", url)).toBe(`Title\n\nPull Request: ${url}\n`)
  })

  it("withLink replaces existing lines", () => {
    const old = `Title\n\nBody\n\nPull Request: #1\nPull Request: #2\n`
    expect(withLink(old, url)).toBe(`Title\n\nBody\n\nPull Request: ${url}\n`)
  })

  it("withoutLink removes the lines", () => {
    expect(withoutLink(`Title\n\nBody\n\nPull Request: ${url}\n`)).toBe("Title\n\nBody\n")
    expect(withoutLink("Title\n\nBody\n")).toBe("Title\n\nBody\n")
  })

  it("withoutLink undoes withLink", () => {
    expect(withoutLink(withLink("Title\n\nBody", url))).toBe("Title\n\nBody\n")
  })
})

describe("textHash", () => {
  it("produces stable sha256 hashes", () => {
    expect(textHash({ title: "Title", body: "Body\nmore" })).toBe(
      "sha256:00a4593fc54c501656e81c4de9e17402293909f2d37acc1c868657fd2ece569d",
    )
    expect(textHash({ title: "Title of A", body: "What A does." })).toBe(
      "sha256:111791be8f4f37a2c682e57598399d1e82ab54591ea0a8208f4223dc75d60ea7",
    )
  })
})
