// Running a command to completion and collecting its output.

import { execFile, type ExecFileOptions } from "node:child_process"

export interface Output {
  success: boolean
  /** null when the process died from a signal */
  code: number | null
  stdout: string
  stderr: string
}

/**
 * Run `cmd` and wait for it, with `input` on its stdin if given, which is
 * then closed. Never throws for a nonzero exit, only when the command can't
 * be started at all (e.g. it isn't on PATH).
 */
export function run(
  cmd: string,
  args: string[],
  { input, ...options }: ExecFileOptions & { input?: string } = {},
): Promise<Output> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      cmd,
      args,
      { maxBuffer: 64 * 1024 * 1024, ...options, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error && typeof error.code === "string") return reject(error) // ENOENT etc.
        const code = error ? (typeof error.code === "number" ? error.code : null) : 0
        resolve({ success: !error, code, stdout: String(stdout), stderr: String(stderr) })
      },
    )
    // A child that exits without reading it is an EPIPE here, which would
    // otherwise be unhandled
    child.stdin?.on("error", () => {})
    if (input !== undefined) child.stdin?.end(input)
    else child.stdin?.end()
  })
}
