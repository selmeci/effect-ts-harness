// ES2023 lib has no URL or node:child_process. @types/node is not installed.
declare module "node:child_process" {
  export function execFileSync(
    file: string,
    args: ReadonlyArray<string>,
    options: { readonly cwd: string; readonly encoding: "utf8" }
  ): string
}

interface ImportMeta {
  readonly url: string
}

interface URL {
  readonly pathname: string
}

declare var URL: {
  new (url: string, base?: string | URL): URL
}

declare module "*/tools/oxlint/syntax-bans.js" {
  const plugin: {
    meta: { name: string }
    rules: {
      "syntax-bans": { create: (context: any) => any }
      "test-integrity": { create: (context: any) => any }
    }
  }
  export default plugin
}
