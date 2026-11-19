// GitHub's REST and GraphQL APIs over `fetch`.

import pkg from "../package.json" with { type: "json" }
import {
  JjackError,
  type Config,
  type GitHubStack,
  type PrState,
  type PullRequest,
  type ReviewDecision,
} from "./model.ts"

/** `X-GitHub-Api-Version` for the Stacks API and the asynchronous merge
 * endpoint. The plain pull request endpoints get no version header. */
const STACKS_API_VERSION = "2026-03-10"

const VERSION = pkg.version

export interface Mergeability {
  state: PrState
  base: string
  headOid: string
  mergeable: boolean | null
  /** GitHub blocks the merge, for required checks or reviews */
  blocked: boolean
}

const PULL_REQUEST_QUERY = `query PullRequestQuery($name: String!, $owner: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number state reviewDecision title body baseRefName headRefName headRefOid isDraft
    }
  }
}`

const MERGEABILITY_QUERY = `query PullRequestMergeabilityQuery($name: String!, $owner: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) { state baseRefName headRefOid mergeable mergeStateStatus }
  }
}`

const SQUASH_DEFAULTS_QUERY = `query RepositorySquashDefaultsQuery($name: String!, $owner: String!) {
  repository(owner: $owner, name: $name) { squashMergeCommitTitle squashMergeCommitMessage }
}`

const OPEN_PULL_REQUESTS_QUERY = `query OpenPullRequestBranchesQuery($owner: String!, $name: String!, $first: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: [OPEN], first: $first, after: $after) {
      nodes { number headRefName baseRefName }
      pageInfo { hasNextPage endCursor }
    }
  }
}`

const PULL_REQUESTS_FOR_BRANCH_QUERY = `query PullRequestsForBranchQuery($owner: String!, $name: String!, $head: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(headRefName: $head, states: [OPEN, CLOSED, MERGED], first: 100) {
      nodes { number state isCrossRepository }
    }
  }
}`

const prState = (state: string): PrState =>
  state === "OPEN" ? "open" : state === "MERGED" ? "merged" : "closed"

const REVIEW_DECISIONS: Record<string, ReviewDecision> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes_requested",
  REVIEW_REQUIRED: "required",
}

type Json = Record<string, any>

export class GitHub {
  readonly #config: Config
  readonly #token: string
  readonly #fetch: typeof fetch

  constructor(options: { config: Config; token: string; fetch?: typeof fetch }) {
    this.#config = options.config
    this.#token = options.token
    this.#fetch = options.fetch ?? fetch
  }

  #headers(versioned: boolean): Record<string, string> {
    return {
      Authorization: `Bearer ${this.#token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": `jjack/${VERSION}`,
      "Content-Type": "application/json",
      ...(versioned ? { "X-GitHub-Api-Version": STACKS_API_VERSION } : {}),
    }
  }

  /** A REST request. A 2xx or a 404 returns the status and JSON; anything
   * else throws with GitHub's message. */
  async #rest(
    method: string,
    path: string,
    body?: unknown,
    options: { versioned?: boolean; notFoundIsError?: boolean } = {},
  ): Promise<{ status: number; json: any }> {
    const { response, text, json } = await this.#send(this.#config.apiUrl + path, {
      method,
      headers: this.#headers(options.versioned ?? true),
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const ok = response.ok || (response.status === 404 && !options.notFoundIsError)
    if (ok) return { status: response.status, json }
    let message = typeof json?.message === "string" ? json.message : text
    // A 422 says why in `errors`, for example the base change of a stacked
    // pull request
    if (response.status === 422 && Array.isArray(json?.errors)) {
      const reasons = json.errors.flatMap((e: Json) =>
        typeof e?.message === "string" ? [e.message] : [],
      )
      if (reasons.length > 0) message += `: ${reasons.join("; ")}`
    }
    throw new JjackError(
      "github",
      `GitHub returned ${response.status} for ${method} ${path}: ${message}`,
      { status: response.status },
    )
  }

  /** A request, with its response's text and JSON (null when it has none).
   * A request that gets no response throws. */
  async #send(url: string, init: RequestInit) {
    let response: Response
    let text: string
    try {
      response = await this.#fetch(url, init)
      text = await response.text()
    } catch (e) {
      throw new JjackError(
        "github",
        `${init.method} ${url} failed: ${(e as Error).message}`,
      )
    }
    let json: any = null
    if (text.trim() !== "") {
      try {
        json = JSON.parse(text)
      } catch {}
    }
    return { response, text, json }
  }

  #pullsPath(number?: number) {
    const path = `/repos/${this.#config.owner}/${this.#config.repo}/pulls`
    return number === undefined ? path : `${path}/${number}`
  }

  #stacksPath() {
    return `/repos/${this.#config.owner}/${this.#config.repo}/stacks`
  }

  /** A GraphQL query. Errors throw "<what> failed" with GitHub's messages. */
  async #graphql(
    operationName: string,
    query: string,
    variables: Json,
    what: string,
  ): Promise<Json> {
    const { response, text, json } = await this.#send(`${this.#config.apiUrl}/graphql`, {
      method: "POST",
      headers: this.#headers(false),
      body: JSON.stringify({ operationName, query, variables }),
    })
    const errors = Array.isArray(json?.errors) ? json.errors : []
    if (!response.ok || errors.length > 0 || json === null) {
      const error = new JjackError("github", `${what} failed`, { status: response.status })
      if (json === null) error.context(text)
      else if (!response.ok && errors.length === 0) {
        error.context(typeof json.message === "string" ? json.message : text)
      }
      for (const e of errors) error.context(String(e?.message ?? JSON.stringify(e)))
      throw error
    }
    return json.data ?? {}
  }

  #repositoryVariables() {
    return { owner: this.#config.owner, name: this.#config.repo }
  }

  /** A pull request as GitHub reports it */
  async pullRequest(number: number): Promise<PullRequest> {
    const data = await this.#graphql(
      "PullRequestQuery",
      PULL_REQUEST_QUERY,
      { ...this.#repositoryVariables(), number },
      `fetching PR #${number}`,
    )
    if (!data.repository) throw new JjackError("github", "failed to find repository")
    const pr = data.repository.pullRequest
    if (!pr) throw new JjackError("github", `failed to find PR #${number}`, { pr: number })
    return {
      number: pr.number,
      state: prState(pr.state),
      title: pr.title,
      body: pr.body ?? "",
      base: pr.baseRefName,
      head: pr.headRefName,
      headOid: /^[0-9a-f]{40}$/.test(pr.headRefOid ?? "") ? pr.headRefOid : null,
      isDraft: Boolean(pr.isDraft),
      reviewDecision: REVIEW_DECISIONS[pr.reviewDecision] ?? "none",
    }
  }

  /** Several pull requests, concurrently, in order. null stays null. */
  pullRequests(numbers: (number | null)[]): Promise<(PullRequest | null)[]> {
    return Promise.all(numbers.map((n) => (n === null ? null : this.pullRequest(n))))
  }

  async createPullRequest(p: {
    title: string
    body: string
    base: string
    head: string
    draft: boolean
  }): Promise<number> {
    const { json } = await this.#rest("POST", this.#pullsPath(), p, {
      versioned: false,
      notFoundIsError: true,
    })
    return json.number
  }

  async updatePullRequest(
    number: number,
    update: { title?: string; body?: string; base?: string; state?: "closed" },
  ): Promise<void> {
    await this.#rest("PATCH", this.#pullsPath(number), update, {
      versioned: false,
      notFoundIsError: true,
    })
  }

  async mergeability(number: number): Promise<Mergeability> {
    const data = await this.#graphql(
      "PullRequestMergeabilityQuery",
      MERGEABILITY_QUERY,
      { ...this.#repositoryVariables(), number },
      `querying PR #${number} mergeability`,
    )
    const pr = data.repository?.pullRequest
    if (!pr) throw new JjackError("github", `failed to find PR #${number}`, { pr: number })
    return {
      state: prState(pr.state),
      base: pr.baseRefName,
      headOid: pr.headRefOid,
      mergeable:
        pr.mergeable === "MERGEABLE" ? true : pr.mergeable === "CONFLICTING" ? false : null,
      blocked: pr.mergeStateStatus === "BLOCKED",
    }
  }

  /** Whether the repository's default squash commit for a pull request is its
   * title and body. False when GitHub does not say, as for a token without
   * access to the settings. */
  async squashDefaultsToPullRequest(): Promise<boolean> {
    try {
      const data = await this.#graphql(
        "RepositorySquashDefaultsQuery",
        SQUASH_DEFAULTS_QUERY,
        this.#repositoryVariables(),
        "reading the squash defaults",
      )
      const repository = data.repository
      return (
        repository?.squashMergeCommitTitle === "PR_TITLE" &&
        repository?.squashMergeCommitMessage === "PR_BODY"
      )
    } catch {
      return false
    }
  }

  async openPullRequests(): Promise<{ number: number; head: string; base: string }[]> {
    const pullRequests = []
    let after: string | null = null
    for (;;) {
      const data = await this.#graphql(
        "OpenPullRequestBranchesQuery",
        OPEN_PULL_REQUESTS_QUERY,
        { ...this.#repositoryVariables(), first: 100, after },
        "fetching open PR branches",
      )
      const page = data.repository?.pullRequests
      if (!page) throw new JjackError("github", "failed to find repository")
      for (const node of page.nodes ?? []) {
        if (node) {
          pullRequests.push({
            number: node.number,
            head: node.headRefName,
            base: node.baseRefName,
          })
        }
      }
      if (!page.pageInfo?.hasNextPage) return pullRequests
      after = page.pageInfo.endCursor
    }
  }

  /** The pull requests in any state whose head is `branch` of this
   * repository (not of a fork) */
  async pullRequestsForBranch(
    branch: string,
  ): Promise<{ number: number; state: PrState }[]> {
    const data = await this.#graphql(
      "PullRequestsForBranchQuery",
      PULL_REQUESTS_FOR_BRANCH_QUERY,
      { ...this.#repositoryVariables(), head: branch },
      `finding the pull requests of ${branch}`,
    )
    if (!data.repository) throw new JjackError("github", "failed to find repository")
    return (data.repository.pullRequests?.nodes ?? [])
      .filter((node: Json | null) => node && !node.isCrossRepository)
      .map((node: Json) => ({ number: node.number, state: prState(node.state) }))
  }

  /** The repository's stacks, or null when stacked pull requests are not
   * enabled (GitHub answers 404) */
  async listStacks(): Promise<GitHubStack[] | null> {
    const stacks: GitHubStack[] = []
    for (let page = 1; ; page++) {
      const { status, json } = await this.#rest(
        "GET",
        `${this.#stacksPath()}?per_page=100&page=${page}`,
      )
      if (status === 404) return null
      if (!Array.isArray(json))
        throw new JjackError("github", "GitHub returned an invalid stack list")
      stacks.push(...json)
      if (json.length !== 100) return stacks
    }
  }

  async #stackRequest(path: string, numbers: number[], what: string): Promise<GitHubStack> {
    const { status, json } = await this.#rest("POST", path, { pull_requests: numbers })
    if (status === 404) {
      throw new JjackError(
        "github",
        `GitHub answered 404 while ${what}; stacked pull requests may not be enabled for ` +
          "this repository",
        { status },
      )
    }
    return json
  }

  /** A stack of `numbers`, bottom first */
  createStack(numbers: number[]): Promise<GitHubStack> {
    return this.#stackRequest(this.#stacksPath(), numbers, "creating a stack")
  }

  /** Append `numbers`, bottom first, to the top of a stack */
  addToStack(stack: number, numbers: number[]): Promise<GitHubStack> {
    return this.#stackRequest(
      `${this.#stacksPath()}/${stack}/add`,
      numbers,
      "adding to a stack",
    )
  }

  /** Remove the open pull requests from a stack. They and their branches stay
   * as they are. */
  async unstack(stack: number): Promise<void> {
    const { status } = await this.#rest("POST", `${this.#stacksPath()}/${stack}/unstack`)
    if (status === 404) {
      throw new JjackError("github", `GitHub stack #${stack} was not found`, { status })
    }
  }

  /** Squash-merge a pull request outside a stack. Returns the merge commit. */
  async squashMerge(
    number: number,
    p: { title: string; message: string; sha: string },
  ): Promise<string | null> {
    const { json } = await this.#rest(
      "PUT",
      `${this.#pullsPath(number)}/merge`,
      {
        merge_method: "squash",
        commit_title: p.title,
        commit_message: p.message,
        sha: p.sha,
      },
      { versioned: false, notFoundIsError: true },
    )
    if (!json?.merged) {
      throw new JjackError(
        "github",
        `GitHub pull request merge failed: ${json?.message ?? ""}`,
        { pr: number },
      )
    }
    return json.sha ?? null
  }

  /**
   * Merge a pull request of a stack, and wait for the merge to finish. GitHub
   * only merges stacked pull requests through its asynchronous endpoint, and
   * merges the open ones below in the same operation. `commit` is the title
   * and message of this one's commit only; without it, and for the ones
   * below, GitHub uses the repository's default.
   */
  async mergeStacked(
    number: number,
    p: { sha: string; commit?: { title: string; message: string } },
    sleep: (ms: number) => Promise<void>,
  ): Promise<string | null> {
    const path = `${this.#pullsPath(number)}/merge-async`
    const { status, json } = await this.#rest("PUT", path, {
      merge_action: "direct_merge",
      merge_method: "squash",
      sha: p.sha,
      ...(p.commit
        ? { commit_title: p.commit.title, commit_message: p.commit.message }
        : {}),
    })
    if (status === 404) {
      throw new JjackError(
        "github",
        `GitHub could not find pull request #${number} to merge`,
        { pr: number, status },
      )
    }
    let merge = json ?? {}
    for (let poll = 0; poll < 120; poll++) {
      const details = merge.details ?? {}
      if (merge.status === "merged") return details.sha ?? null
      if (merge.status === "failed") {
        throw new JjackError(
          "github",
          `GitHub could not merge pull request #${number}: ${details.message ?? ""}`,
          { pr: number },
        )
      }
      if (merge.status === "enqueued") {
        throw new JjackError(
          "merge_queued",
          `GitHub added pull request #${number} to the merge queue instead of merging it: ` +
            (details.message ?? ""),
          { pr: number },
        )
      }
      if (!details.uuid) {
        throw new JjackError(
          "github",
          "GitHub's merge response did not identify the merge operation",
        )
      }
      await sleep(500)
      merge = (await this.#rest("GET", `${path}/${details.uuid}`)).json ?? {}
    }
    throw new JjackError(
      "timeout",
      `Timed out waiting for GitHub to merge pull request #${number}`,
      { pr: number },
    )
  }
}
