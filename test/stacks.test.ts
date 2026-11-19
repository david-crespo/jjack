import { describe, expect, it } from "vitest"
import { JjackError, type GitHubStack } from "../src/model.ts"
import {
  chainSegments,
  planStackUpdates,
  planUnstacks,
  type PlannedBase,
  type PublishedLink,
} from "../src/stacks.ts"

/** A stack of members, each with whether it is merged */
function stack(number: number, members: [number, boolean][]): GitHubStack {
  return {
    number,
    pull_requests: members.map(([n, merged]) => ({
      number: n,
      state: merged ? "closed" : "open",
      merged_at: merged ? "2026-01-01T00:00:00Z" : null,
    })),
  }
}

const planned = (
  number: number | null,
  currentBase: string | null,
  expectedBase: string | null,
): PlannedBase => ({ number, currentBase, expectedBase })

const link = (number: number, base: string, head: string): PublishedLink => ({
  number,
  base,
  head,
})

describe("planUnstacks", () => {
  it("keeps an unchanged stack", () => {
    const stacks = [
      stack(7, [
        [1, false],
        [2, false],
      ]),
    ]
    const selection = [
      planned(1, "main", "main"),
      planned(2, "spr/a", "spr/a"),
      planned(null, null, "spr/b"),
    ]
    expect(planUnstacks(stacks, selection)).toEqual([])
  })

  it("dissolves the stack of a retargeted member", () => {
    // #2 moved below a new change, so its base changes.
    const stacks = [
      stack(7, [
        [1, false],
        [2, false],
      ]),
    ]
    const selection = [
      planned(1, "main", "main"),
      planned(null, null, "spr/a"),
      planned(2, "spr/a", null),
    ]
    expect(planUnstacks(stacks, selection)).toEqual([7])
  })

  it("dissolves the stack of reordered members", () => {
    const stacks = [
      stack(3, [
        [1, false],
        [2, false],
      ]),
    ]
    const selection = [planned(2, "spr/a", "main"), planned(1, "main", "spr/b")]
    expect(planUnstacks(stacks, selection)).toEqual([3])
  })

  it("refuses to truncate a stack with unselected members", () => {
    const stacks = [
      stack(4, [
        [1, false],
        [2, false],
        [3, false],
      ]),
    ]
    const selection = [planned(1, "main", "main"), planned(2, "spr/a", "main")]
    let error: unknown
    try {
      planUnstacks(stacks, selection)
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(JjackError)
    const message = (error as JjackError).message
    expect(message).toContain("#3,")
    expect(message).toContain("#2 from spr/a to main")
  })

  it("does not let merged members block a rebuild", () => {
    const stacks = [
      stack(4, [
        [1, true],
        [2, false],
        [3, false],
      ]),
    ]
    const selection = [planned(3, "spr/b", "main"), planned(2, "main", "spr/c")]
    expect(planUnstacks(stacks, selection)).toEqual([4])
  })
})

describe("chainSegments", () => {
  it("follows the base chain", () => {
    const published = [
      link(1, "main", "spr/a"),
      link(2, "spr/a", "spr/b"),
      link(3, "main", "spr/c"), // cherry-picked: starts a new chain
      link(4, "spr/c", "spr/d"),
      link(5, "spr/d", "spr/e"),
    ]
    expect(chainSegments(published).map((s) => s.map((l) => l.number))).toEqual([
      [1, 2],
      [3, 4, 5],
    ])
  })

  it("does not count single pull requests as stacks", () => {
    expect(chainSegments([link(1, "main", "spr/a"), link(2, "main", "spr/b")])).toEqual([])
  })
})

describe("planStackUpdates", () => {
  it("creates a missing stack", () => {
    expect(planStackUpdates([], [[1, 2, 3]])).toEqual([
      { kind: "create", pullRequests: [1, 2, 3] },
    ])
  })

  it("needs nothing for an existing stack", () => {
    const stacks = [
      stack(9, [
        [1, false],
        [2, false],
      ]),
    ]
    expect(planStackUpdates(stacks, [[1, 2]])).toEqual([])
  })

  it("needs nothing for a partial selection inside a stack", () => {
    const stacks = [
      stack(9, [
        [1, false],
        [2, false],
        [3, false],
      ]),
    ]
    expect(planStackUpdates(stacks, [[2, 3]])).toEqual([])
  })

  it("appends a new top", () => {
    const stacks = [
      stack(9, [
        [1, false],
        [2, false],
      ]),
    ]
    expect(planStackUpdates(stacks, [[1, 2, 3, 4]])).toEqual([
      { kind: "add", stack: 9, pullRequests: [3, 4] },
    ])
  })

  it("rebuilds a stack that ends with a closed pull request", () => {
    const stacks = [
      stack(9, [
        [1, true],
        [2, false],
        [3, false],
        [4, false],
      ]),
    ]
    stacks[0].pull_requests[3].state = "closed"
    expect(planStackUpdates(stacks, [[3, 5]])).toEqual([
      { kind: "rebuild", stack: 9, pullRequests: [2, 3, 5] },
    ])
  })

  it("appends when the parent is the top of the stack", () => {
    // Single-change mode: the chain is [parent, this].
    const stacks = [
      stack(9, [
        [1, false],
        [2, false],
      ]),
    ]
    expect(planStackUpdates(stacks, [[2, 3]])).toEqual([
      { kind: "add", stack: 9, pullRequests: [3] },
    ])
  })

  it("ignores merged history when appending", () => {
    const stacks = [
      stack(9, [
        [1, true],
        [2, false],
      ]),
    ]
    expect(planStackUpdates(stacks, [[2, 3]])).toEqual([
      { kind: "add", stack: 9, pullRequests: [3] },
    ])
  })

  it("explains an insertion inside a stack", () => {
    const stacks = [
      stack(9, [
        [1, false],
        [2, false],
        [3, false],
      ]),
    ]
    const actions = planStackUpdates(stacks, [[2, 4]])
    expect(actions).toHaveLength(1)
    const action = actions[0]
    if (action.kind !== "warn") throw new Error(`unexpected ${JSON.stringify(action)}`)
    expect(action.message).toContain("#4 now sits on #2")
    // Rust: "jj spr diff --all"
    expect(action.message).toContain("Run submit for the whole stack")
  })

  it("warns on a mismatched order", () => {
    const stacks = [
      stack(9, [
        [2, false],
        [1, false],
      ]),
    ]
    const actions = planStackUpdates(stacks, [[1, 2]])
    expect(actions).toHaveLength(1)
    expect(actions[0].kind).toBe("warn")
  })
})
