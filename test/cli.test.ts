// Tests of the command line: option parsing, the choice between a stack file
// and -r, error printing, and exit codes, through `main` in this process and
// through the source binary in a child process. `flags_replace_settings` is a
// port of jj-spr's `the_branch_prefix_flag_replaces_the_setting`, and
// `commands_work_from_a_second_workspace` of the workspace test in
// `workspace_config_test.rs`.

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it } from "vitest"
import { run } from "../src/proc.ts"
import { checkChain, TestEnv } from "./env.ts"
import { Stack } from "./stack.ts"

const binary = fileURLToPath(new URL("../jjack.ts", import.meta.url))

/** Run the source binary in a child process, with the environment's
 * variables over this process's */
function jjackBinary(env: TestEnv, cwd: string, args: string[]) {
  return run(process.execPath, [binary, ...args], {
    cwd,
    env: { ...process.env, ...env.env },
  })
}

/** Replace one `jjack.*` setting in the environment's jj config file */
async function setSetting(env: TestEnv, key: string, value: string): Promise<void> {
  const config = await readFile(env.env.JJ_CONFIG, "utf8")
  const line = new RegExp(`^${key} = .*$`, "m")
  if (!line.test(config)) throw new Error(`no ${key} in the jj config:\n${config}`)
  await writeFile(
    env.env.JJ_CONFIG,
    config.replace(line, `${key} = ${JSON.stringify(value)}`),
  )
}

describe.concurrent("the command line", () => {
  it("help_and_errors", async ({ expect }) => {
    await using env = await TestEnv.create()
    const outside = join(env.root, "outside")
    await mkdir(outside)

    const help = await jjackBinary(env, outside, ["--help"])
    expect(help.code, help.stderr).toBe(0)
    expect(help.stdout).toContain("Usage: jjack")
    for (const command of ["init", "status", "adopt", "submit", "land", "sync", "close"]) {
      expect(help.stdout).toContain(command)
    }

    const notARepo = await jjackBinary(env, outside, ["status", "stack.json"])
    expect(notARepo.code, notARepo.stdout + notARepo.stderr).toBe(1)
    expect(notARepo.stdout + notARepo.stderr).toContain(
      "🛑  This command requires a Jujutsu repository. Could not find a Jujutsu workspace " +
        "in the current directory.",
    )

    const a = await env.commit("Change A", "a.txt", "a\n")
    const stack = new Stack(env)
    stack.entries([{ tip: a }])
    const both =
      "🛑  Pass a stack file, or -r <revision> for changes with `Pull Request:` lines."
    for (const command of ["submit", "land", "sync", "close"]) {
      const together = await env.tryJjack([command, stack.path, "-r", a])
      expect(together.success, `${command} should refuse:\n${together.text}`).toBe(false)
      expect(together.text).toContain(both)
      const neither = await env.tryJjack([command])
      expect(neither.success, `${command} should refuse:\n${neither.text}`).toBe(false)
      expect(neither.text).toContain(both)
    }
    expect(env.gh.requests, "nothing reached GitHub").toEqual([])

    // An entry without a title is a problem: status reports it, and exits 0
    // since it could produce the status
    const status = await env.tryJjack(["status", stack.path, "--json"])
    expect(status.code, status.text).toBe(0)
    expect(status.text).not.toContain("🛑")
    expect(JSON.parse(status.stdout)).toMatchObject({
      ok: true,
      command: "status",
      result: {
        file: stack.path,
        entries: [{ tip: a, pr: null, merged: false }],
        problems: [
          {
            code: "no_title",
            tip: a,
            message: `'${a}' has no title. Give it a title key, or start its body file with a \`# \` heading.`,
          },
        ],
      },
    })
    const text = await env.tryJjack(["status", stack.path])
    expect(text.code, text.text).toBe(0)
    expect(text.text).toContain("has 1 problem.")
    stack.entries([{ tip: a, title: "Change A" }])
    const fixed = await env.jjack(["status", stack.path, "--json"])
    expect(JSON.parse(fixed.stdout).result.problems).toEqual([])
  })

  it("json_output_and_exit_codes", async ({ expect }) => {
    await using env = await TestEnv.create({ stacks: false })
    const a = await env.commit("Change A", "a.txt", "a\n")
    const b = await env.commit("Change B", "b.txt", "b\n")

    // Success: stdout is one JSON document, and the log is on stderr
    const submit = await env.jjack(["--json", "submit", "-r", b])
    expect(submit.code).toBe(0)
    expect(submit.text).toContain("Created new pull request")
    expect(submit.stdout).not.toContain("Created new pull request")
    const prs = await env.prsFor([a, b])
    expect(JSON.parse(submit.stdout)).toEqual({
      ok: true,
      command: "submit",
      result: {
        dryRun: false,
        pullRequests: [0, 1].map((i) => ({
          label: [a, b][i].slice(0, 8),
          number: prs[i],
          url: `https://github.com/fake/repo/pull/${prs[i]}`,
          action: "create",
          updates: [],
          text: null,
          title: ["Change A", "Change B"][i],
          commit: expect.stringMatching(/^[0-9a-f]{40}$/),
          head: env.pr(prs[i]).headRef,
          base: i === 0 ? "main" : env.pr(prs[0]).headRef,
          headOid: env.headOf(prs[i]),
        })),
        stacks: [],
      },
      warnings: [],
    })

    // Warnings: the lines with ⚠️ are in the document too
    env.gh.failingQueries.push("OpenPullRequestBranchesQuery")
    const landed = await env.jjack(["land", "--no-sync", "-r", a, "--json"])
    const { warnings } = JSON.parse(landed.stdout)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("Could not list the open pull requests")
    env.gh.failingQueries.length = 0

    // A refusal: exit code 1, the error's code, and the commands that fix it
    const refused = await env.tryJjack(["submit", "-r", b, "--json"])
    expect(refused.code, refused.text).toBe(1)
    expect(refused.text).toContain("🛑")
    expect(JSON.parse(refused.stdout)).toEqual({
      ok: false,
      command: "submit",
      error: {
        code: "merged",
        message: expect.stringContaining(`#${prs[0]} has already merged`),
        pr: prs[0],
        fix: [`jjack sync -r ${b}`, `jjack submit -r ${b}`],
      },
      warnings: [],
    })
    const plain = await env.tryJjack(["submit", "-r", b])
    expect(plain.code).toBe(1)
    expect(plain.stdout).toContain(`🛑  #${prs[0]} has already merged`)

    // Usage errors: exit code 2, as a document with --json
    for (const args of [
      ["submit"],
      ["submit", "--bogus"],
      ["submit", "-r", b, "--upto", a],
      ["submit", "-r", b, "--overwrite-github"],
      ["land", "-r", b, "--upto", a],
      ["close", "-r", b, "--pr", a],
      ["close", "stack.json"],
      ["close", "stack.json", "--pr", a, "--all"],
    ]) {
      const usage = await env.tryJjack(args)
      expect(usage.code, `${args.join(" ")}:\n${usage.text}`).toBe(2)
      const json = await env.tryJjack([...args, "--json"])
      expect(json.code, json.text).toBe(2)
      expect(JSON.parse(json.stdout)).toMatchObject({ ok: false, error: { code: "usage" } })
    }
  })

  it("flags_replace_settings", async ({ expect }) => {
    await using env = await TestEnv.create()
    await setSetting(env, "repository", "someone/else")
    const a = await env.commit("Change A", "a.txt", "a\n")

    await env.jjack([
      "--branch-prefix",
      "flag/",
      "--repository",
      "fake/repo",
      "submit",
      "-r",
      a,
    ])
    const pr = await env.prFor(a)
    expect(env.pr(pr).headRef).toBe("flag/change-a")
    expect(await env.description(a)).toBe(
      `Change A\n\nPull Request: https://github.com/fake/repo/pull/${pr}\n`,
    )
    expect(env.requestsSince(0, "POST", "/pulls")).toEqual(["POST /repos/fake/repo/pulls"])
  })

  it("jjack_keys_fall_back_to_spr_keys", async ({ expect }) => {
    await using env = await TestEnv.create()
    const config = await readFile(env.env.JJ_CONFIG, "utf8")
    const branchOf = async (change: string) => env.pr(await env.prFor(change)).headRef

    // A repository set up for jj-spr: only spr.* keys
    await writeFile(
      env.env.JJ_CONFIG,
      config
        .replace("[jjack]", "[spr]")
        .replace("repository =", "githubRepository =")
        .replace("token =", "githubAuthToken =")
        .replace("apiUrl =", "githubApiUrl =")
        .replace('branchPrefix = "spr/"', 'branchPrefix = "old/"'),
    )
    const a = await env.commit("Change A", "a.txt", "a\n")
    await env.jjack(["submit", "-r", a])
    expect(await branchOf(a)).toBe("old/change-a")

    // jjack.* wins over spr.*
    await env.jj(["config", "set", "--repo", "jjack.branchPrefix", "new/"])
    const b = await env.commit("Change B", "b.txt", "b\n")
    await env.jjack(["submit", "-r", b])
    expect(await branchOf(b)).toBe("new/change-b")

    // Without a prefix: the fix sets one
    await writeFile(env.env.JJ_CONFIG, config.replace('branchPrefix = "spr/"\n', ""))
    await env.jj(["config", "unset", "--repo", "jjack.branchPrefix"])
    const c = await env.commit("Change C", "c.txt", "c\n")
    const missing = await env.tryJjack(["submit", "-r", c, "--json"])
    expect(missing.code, missing.text).toBe(1)
    const fix = "jj config set --repo jjack.branchPrefix test/"
    expect(JSON.parse(missing.stdout).error).toMatchObject({ code: "config", fix: [fix] })
    expect(missing.text).toContain("jjack.branchPrefix must be configured")
    await env.jj(fix.split(" ").slice(1))
    await env.jjack(["submit", "-r", c])
    expect(await branchOf(c)).toBe("test/change-c")
  })

  it("commands_work_from_a_second_workspace", async ({ expect }) => {
    await using env = await TestEnv.create()
    const a = await env.commit("Change A", "a.txt", "a\n")
    const b = await env.commit("Change B", "b.txt", "b\n")
    const second = join(env.root, "second")
    await env.jj(["workspace", "add", "--name", "second", "-r", b, second])
    // A change made in the second workspace
    await writeFile(join(second, "c.txt"), "c\n")
    const commit = await run("jj", ["commit", "-m", "Change C"], {
      cwd: second,
      env: { ...process.env, ...env.env },
    })
    expect(commit.success, commit.stderr).toBe(true)
    const c = await env.changeId("second@-")

    await env.jjack(["submit", "-r", "@-"], { cwd: second })
    const changes = [a, b, c]
    const prs = await env.prsFor(changes)
    await checkChain(env, changes, prs)

    await env.jjack(["land", "--no-sync", "-r", "@-"], { cwd: second })
    for (const number of prs) expect(env.pr(number).mergedAt).not.toBeNull()
    await env.jjack(["sync", "-r", "@-"], { cwd: second })
    // The sync rebased the work clone's working copy, which is a child of B
    await env.jj(["workspace", "update-stale"])
    for (const change of changes) expect(await env.isVisible(change)).toBe(false)
  })

  it("auth_token_uses_env_and_ignores_empty_flag", async ({ expect }) => {
    await using env = await TestEnv.create()
    const config = await readFile(env.env.JJ_CONFIG, "utf8")
    await writeFile(env.env.JJ_CONFIG, config.replace('token = "fake-token"\n', ""))
    const bin = join(env.root, "bin")
    await mkdir(bin)
    const ghStub = join(bin, "gh")
    await writeFile(ghStub, "#!/bin/sh\necho token-from-env-gh\n")
    await chmod(ghStub, 0o755)

    const a = await env.commit("Change A", "a.txt", "a\n")
    const { openContext } = await import("../src/index.ts")
    let seenAuth = ""
    const ctx = await openContext(env.work, {
      flags: { token: "" },
      env: { ...env.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
      fetch: async (input, init) => {
        seenAuth = new Request(input, init).headers.get("authorization") ?? ""
        return env.gh.fetch(input, init)
      },
    })
    const { submit } = await import("../src/index.ts")
    await submit(ctx, { revision: a })
    expect(seenAuth).toBe("Bearer token-from-env-gh")
  })

  it("the_binary_talks_to_a_server", async ({ expect, skip }) => {
    await using env = await TestEnv.create()
    let server: Awaited<ReturnType<typeof env.gh.listen>>
    try {
      server = await env.gh.listen()
    } catch (error) {
      // A sandbox may not allow listening on a port
      if ((error as NodeJS.ErrnoException).code === "EPERM") skip()
      throw error
    }
    try {
      await setSetting(env, "apiUrl", server.url)
      const a = await env.commit("Change A", "a.txt", "a\n")
      const b = await env.commit("Change B", "b.txt", "b\n")

      const submit = await jjackBinary(env, env.work, ["submit", "-r", b])
      expect(submit.code, submit.stdout + submit.stderr).toBe(0)
      expect(submit.stdout).toContain("Created new pull request #1")
      const prs = await env.prsFor([a, b])
      await checkChain(env, [a, b], prs)
      expect(env.gh.requests.length, "the requests reached the fake").toBeGreaterThan(0)
    } finally {
      await server.close()
    }
  })
})
