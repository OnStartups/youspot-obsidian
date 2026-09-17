# Contributing

Thanks for looking. Bug reports and pull requests are both welcome, with one thing worth
knowing before you spend time on a change.

## This repository is a mirror

The plugin is developed in a private monorepo and published here, so a pull request cannot
be merged in the usual way. It is still the clearest way to propose a change: we port the
commit upstream with your authorship, and it comes back here on the next sync. Small fixes
usually land quickly. For anything larger, open an issue first so we can agree on the shape
before you write it.

Do not hand-edit files here expecting them to survive. The next sync overwrites the tree.

## Reporting a bug

Open an issue at <https://github.com/OnStartups/youspot-obsidian/issues> with:

- what you did, what happened, and what you expected instead
- your Obsidian version and operating system
- the plugin version from Settings, Community plugins

Never paste your API token into an issue. If a log line contains one, replace it.

## Working on the code

```
bun install
bun run build      # bundles src/main.ts to dist/main.js
bun run typecheck
bun test
bun run lint:obsidian
```

`OBSIDIAN_VAULT=/path/to/vault bun run install:dev` builds and copies the three files into
that vault, which is the quickest way to try a change by hand.

The sync engine sits behind two small interfaces, a vault port and an HTTP port, so all of
it runs under `bun test` against an in-memory vault and a fake server. A change to sync
behaviour belongs in those tests rather than in a manual run against a real vault.

## What we look for

- a test that fails without the change
- `bun run typecheck` and `bun run lint:obsidian` clean
- no new dependency unless it is doing real work

## License

By contributing you agree that your work ships under the MIT license in [LICENSE](LICENSE).
