// A stack file and its body files in a test environment, and the stacks the
// scenario tests start from. A port of the helpers at the top of
// `tests/stack_file.rs` in the Rust prototype of stack files (a fork of jj-spr).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect } from "vitest"
import type { JjackOutcome, TestEnv } from "./env.ts"

type Json = Record<string, any>

/** A stack file and its body files, in a directory outside the repository */
export class Stack {
  readonly env: TestEnv
  readonly dir: string
  readonly path: string

  constructor(env: TestEnv) {
    this.env = env
    this.dir = join(env.root, "stack")
    mkdirSync(this.dir, { recursive: true })
    this.path = join(this.dir, "stack.json")
  }

  write(file: unknown): void {
    writeFileSync(this.path, JSON.stringify(file, null, 2))
  }

  /** Write the stack file with these entries */
  entries(entries: Json[]): void {
    this.write({ prs: entries })
  }

  body(name: string, text: string): void {
    writeFileSync(join(this.dir, name), text)
  }

  read(): Json {
    return JSON.parse(readFileSync(this.path, "utf8"))
  }

  entry(index: number): Json {
    return this.read().prs[index]
  }

  /** The `pr` of each entry */
  prs(): number[] {
    return this.read().prs.map((entry: Json) => {
      if (typeof entry.pr !== "number") throw new Error("an entry without a pr")
      return entry.pr
    })
  }

  /** Change one entry's keys */
  edit(index: number, keys: Json): void {
    const file = this.read()
    Object.assign(file.prs[index], keys)
    this.write(file)
  }

  /** `jjack <command> <stack file> <args>`, required to succeed */
  jjack(command: string, args: string[] = []): Promise<JjackOutcome> {
    return this.env.jjack([command, this.path, ...args])
  }

  tryJjack(command: string, args: string[] = []): Promise<JjackOutcome> {
    return this.env.tryJjack([command, this.path, ...args])
  }

  status(): Promise<JjackOutcome> {
    return this.env.tryJjack(["status", this.path])
  }

  /** The result of `status --json` */
  async statusJson(): Promise<Json> {
    const { stdout, text } = await this.env.tryJjack(["status", this.path, "--json"])
    try {
      return JSON.parse(stdout).result
    } catch (error) {
      throw new Error(`status --json printed no JSON (${error}):\n${text}`)
    }
  }
}

export function heads(env: TestEnv, prs: number[]): string[] {
  return prs.map((n) => env.headOf(n))
}

/** Nothing was pushed or opened since `before` (the heads of `prs`) */
export function nothingPushed(env: TestEnv, prs: number[], before: string[]): void {
  expect(heads(env, prs), "nothing may be pushed").toEqual(before)
  expect(env.gh.prs.size, "nothing may be opened").toBe(prs.length)
}

/** A change titled "Change <name>" that adds `<name>.txt` */
export function change(env: TestEnv, name: string): Promise<string> {
  return env.commit(`Change ${name}`, `${name}.txt`, `${name}\n`)
}

/** Changes a, b1, b2, b3, and c, with bookmark `b` on b3, and a stack file of
 * three entries: a, b, and c. Returns the stack and the changes of each entry. */
export async function threeEntries(env: TestEnv): Promise<[Stack, string[][]]> {
  const a = await change(env, "a")
  const b = []
  for (const name of ["b1", "b2", "b3"]) b.push(await change(env, name))
  const c = await change(env, "c")
  await env.jj(["bookmark", "create", "-r", b[2], "b"])
  const stack = new Stack(env)
  stack.body("a.md", "# Title of A\n\nWhat A does.\n")
  stack.body("b.md", "# Title of B\n\nWhat B does.\n\nIn two paragraphs.\n")
  stack.entries([
    { tip: a, body: "a.md" },
    { tip: "b", body: "b.md", "x-note": "kept" },
    { tip: c, title: "Title of C" },
  ])
  return [stack, [[a], b, [c]]]
}

/** `threeEntries`, submitted. Returns the pull requests too. */
export async function submitted(env: TestEnv): Promise<[Stack, string[][], number[]]> {
  const [stack, groups] = await threeEntries(env)
  await stack.jjack("submit", ["-m", "unused"])
  return [stack, groups, stack.prs()]
}

/** One change per name ("Change A" adding `a.txt` for "a"), a stack file with
 * one entry per change, submitted. Returns the stack, the changes, and their
 * pull requests. */
export async function fileStack(
  env: TestEnv,
  names: string[],
): Promise<{ stack: Stack; changes: string[]; prs: number[] }> {
  const changes = []
  for (const name of names) {
    changes.push(
      await env.commit(`Change ${name.toUpperCase()}`, `${name}.txt`, `${name}\n`),
    )
  }
  const stack = new Stack(env)
  stack.entries(
    changes.map((tip, i) => ({ tip, title: `Change ${names[i].toUpperCase()}` })),
  )
  await stack.jjack("submit", ["-m", "initial"])
  return { stack, changes, prs: stack.prs() }
}
