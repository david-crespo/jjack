// The library: one function per command, each returning its result and
// throwing a JjackError when it refuses or fails, and a context to run them
// with. ah imports it.

export { adopt, type AdoptOptions } from "./commands/adopt.ts"
export { close, type CloseOptions } from "./commands/close.ts"
export { init } from "./commands/init.ts"
export { land, type LandOptions } from "./commands/land.ts"
export { status } from "./commands/status.ts"
export { submit, type SubmitOptions } from "./commands/submit.ts"
export { sync, type SyncOptions } from "./sync.ts"
export type { Flags } from "./config.ts"
export {
  openContext,
  openLocalContext,
  snapshot,
  type Ctx,
  type LocalCtx,
} from "./context.ts"
export type { GitHub } from "./github.ts"
export { captureOut, printError, type Out } from "./output.ts"
export type { Repo } from "./repo.ts"
export { resolveStack } from "./resolve.ts"
export {
  entryText,
  parseStackFile,
  type Entry,
  type EntryText,
  type StackFile,
  type TitleSource,
} from "./stack_file.ts"
export {
  JjackError,
  toJjackError,
  type AdoptResult,
  type CloseResult,
  type Config,
  type ErrorCode,
  type ErrorDetails,
  type ErrorJson,
  type InitResult,
  type LandResult,
  type LocalChange,
  type LocalEntry,
  type LocalStack,
  type PrState,
  type Problem,
  type ProblemCode,
  type PullRequestResult,
  type SincePushed,
  type Source,
  type StackChange,
  type Status,
  type StatusActionKind,
  type StatusEntry,
  type SubmitResult,
  type SyncItem,
  type SyncResult,
  type Text,
  type TextParts,
} from "./model.ts"
