// Where commands write their log, the progress a person watches. The CLI
// prints it; ah and the tests capture it. What a program reads is in the
// command's result.

import type { JjackError } from "./model.ts"

export interface Out {
  /** One message with its icon: "  <icon>  <text>" */
  line(icon: string, text: string): void
  /** A message with ⚠️ that the CLI also lists in its JSON output */
  warn(text: string): void
  /** A plain line */
  raw(text: string): void
}

/** A message's lines after the first line up with its text, without wrapping
 * to the terminal's width */
function format(icon: string, text: string): string {
  const [first, ...rest] = text.trim().split("\n")
  return [`  ${icon}  ${first}`, ...rest.map((line) => `      ${line}`)].join("\n")
}

/** Print an error as the command line does: each of its messages with 🛑.
 * The messages already say how to fix it, and `error.fix` has the same
 * commands for a program to run, so a caller that prints both repeats them. */
export function printError(out: Out, error: JjackError): void {
  for (const message of error.messages) out.line("🛑", message)
}

export const consoleOut: Out = {
  line: (icon, text) => console.log(format(icon, text)),
  warn: (text) => console.log(format("⚠️", text)),
  raw: (text) => console.log(text),
}

/** An Out that keeps what it is given: each message as printed, in `lines`,
 * the warnings' text, in `warnings`, and all of it as `text`. With `write`,
 * it also writes each message as printed. */
export function captureOut(write?: (text: string) => void): Out & {
  readonly text: string
  lines: string[]
  warnings: string[]
} {
  const lines: string[] = []
  const warnings: string[] = []
  const raw = (text: string) => {
    lines.push(text)
    write?.(text)
  }
  return {
    lines,
    warnings,
    get text() {
      return lines.map((line) => `${line}\n`).join("")
    },
    raw,
    line: (icon, text) => raw(format(icon, text)),
    warn(text) {
      warnings.push(text)
      raw(format("⚠️", text))
    },
  }
}
