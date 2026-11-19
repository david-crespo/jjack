# AGENTS.md

## Architecture

Keep the dependency graph acyclic and pointing downward through these layers:

1. `src/model.ts`: shared types and `JjackError`. Imports nothing.
2. `src/text.ts`, `src/stacks.ts`, `src/output.ts`, `src/proc.ts`: pure and leaf helpers. Import only `model.ts` and each other.
3. `src/repo.ts`, `src/config.ts`, `src/github.ts`: jj/git, config, and GitHub API clients. `config.ts` uses `repo.ts`; `github.ts` does not import `repo.ts` or `config.ts`.
4. `src/context.ts`: wires `Repo`, config, `GitHub`, and `Out` into `Ctx` and `LocalCtx`.
5. `src/stack_file.ts`, `src/description.ts`, `src/publish.ts`: stack file I/O, `Pull Request:` line parsing, and publish planning/execution. Independent of each other.
6. `src/resolve.ts` (local stack resolution, uses `stack_file.ts`), `src/check.ts` (GitHub validation, uses `resolve.ts` and `stack_file.ts`), and `src/sync.ts` (uses `description.ts`, `resolve.ts`, and `stack_file.ts`; sits below `commands/` because `land` runs `sync`).
7. `src/commands/*.ts`: one module per command. Commands do not import each other or the entry points.
8. `src/index.ts` (library entry point — must not import `cli.ts` or `commander`) and `src/cli.ts` (CLI entry point).

## TypeScript & Runtime

- Node 24 runs the `.ts` files directly by stripping types. Stick to erasable syntax (`erasableSyntaxOnly`), `verbatimModuleSyntax`, and explicit `.ts` extensions on relative imports.
- `commander` is a devDependency bundled into `dist/jjack.js` by `tsdown`. Keep `src/index.ts` and everything it imports free of `commander`.

## Verification

Run `npm run ci` after edits (`tsc`, `oxlint`, `oxfmt --check`, and `vitest` against an in-process fake GitHub). Run `npm run fmt` to format with `oxfmt`.
