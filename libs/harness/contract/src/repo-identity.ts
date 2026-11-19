import { Schema } from "effect"

const hasNoControlChars = (value: string): boolean => {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    if (code <= 0x1f || code === 0x7f) {
      return false
    }
  }
  return true
}

/**
 * Canonical POSIX absolute path to the repository root (`1..1024` chars, trimmed, no `.`/`..` segments,
 * no backslashes, no trailing slash, no ASCII control characters). Required by `harness:SPEC-0017 REQ-1.1`.
 */
export const AbsoluteRepoRoot = Schema.String.pipe(
  Schema.check(Schema.isMaxLength(1024)),
  Schema.check(Schema.isTrimmed()),
  Schema.check(Schema.isPattern(/^(?:\/(?!\.\.?(?:\/|$))[^\\/]+)+$/)),
  Schema.check(
    Schema.makeFilter(hasNoControlChars, {
      message: "AbsoluteRepoRoot must not contain ASCII control characters",
    }),
  ),
  Schema.brand("AbsoluteRepoRoot"),
)
export type AbsoluteRepoRoot = typeof AbsoluteRepoRoot.Type

/** Lowercase 40-hex-character git commit SHA-1 digest. */
export const GitCommitSha = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[0-9a-f]{40}$/)),
  Schema.brand("GitCommitSha"),
)
export type GitCommitSha = typeof GitCommitSha.Type
