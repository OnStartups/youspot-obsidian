# YouSpot for Obsidian

Keeps one folder of your vault and your [YouSpot](https://youspot.com) Brain in sync, both ways.

- **Vault to Brain.** Every note in the folder you choose becomes an object in your Brain. Links between synced notes become connections, and `#tags` become tags. The note's id is written into its frontmatter on the first sync, so renaming a file moves the object instead of creating a second one.
- **Brain to vault.** Contacts, companies, projects and links from your Brain are written back as Markdown under `<your folder>/YouSpot/`, each with frontmatter and a list of its connections. A wikilink from one of your own notes to one of those files connects the note to that object.

Nothing syncs until you pick a folder, so the rest of your vault stays where it is.

## Install

### From the community plugins list

Settings, Community plugins, Browse, search for YouSpot.

### Manually

Download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/OnStartups/youspot-obsidian/releases/latest) and put them in your vault at:

```
<vault>/.obsidian/plugins/youspot/
```

Then enable YouSpot under Settings, Community plugins.

## Connect it

1. In YouSpot, open Settings, Integrations, Obsidian, and create a token.
2. In Obsidian, open Settings, YouSpot, and paste the token in.
3. Choose the folder to sync. Start with a small one.
4. Run **YouSpot: Sync now** from the command palette, or click the brain icon in the ribbon.

The token is stored in plain text in `.obsidian/plugins/youspot/data.json`. If your vault is a git repository, add that path to its `.gitignore` before you paste the token. The plugin's settings screen has a button to copy the line.

## How conflicts work

Your vault is the source of truth for its own notes, but never silently. If a note was edited in the YouSpot web app since the last sync, the plugin refuses to overwrite it and tells you. You then choose:

- **Push this note (overwrite server)** keeps what is in your vault.
- **Pull server version of this note** writes the web version alongside it as `<name>.youspot-conflict.md` so you can merge by hand.

There is no automatic merging.

## Commands

| Command                           | Does                                                         |
| --------------------------------- | ------------------------------------------------------------ |
| Sync now                          | Push pending notes, then pull Brain changes                  |
| Push this note                    | Push the active note immediately                             |
| Push this note (overwrite server) | Same, but win over an edit made in YouSpot                   |
| Pull Brain now                    | Pull only                                                    |
| Pull server version of this note  | Write the YouSpot copy beside the note                       |
| Reconcile folder                  | Rescan the folder against local state and the server         |
| Open in YouSpot                   | Open the active note's object page                           |
| Reset sync state                  | Forget local bookkeeping; the next sync re-pushes the folder |

## What the plugin accesses

The plugin talks only to your YouSpot account, using a token you create and can revoke at any
time. There is no analytics and no telemetry, and nothing is sent anywhere else.

**Network.** Every request goes to the API base on the settings screen, `https://be.youspot.com`
by default, and to no other host. Changing that field points the plugin at your own server
instead. Each call carries your token and nothing else identifying.

| Request                              | When it happens                                     |
| ------------------------------------ | --------------------------------------------------- |
| `GET /api/obsidian/me`               | Checking the token, on the settings screen           |
| `POST /api/obsidian/notes/push`      | Sending notes you changed in the synced folder       |
| `POST /api/obsidian/notes/delete`    | Telling the server a synced note was deleted         |
| `GET /api/obsidian/changes`          | Asking what changed in your Brain since the last sync |
| `GET /api/obsidian/notes`            | Pulling the objects written back under `YouSpot/`     |
| `GET /api/obsidian/notes/<id>`       | Pulling one object, for a conflict or a single pull   |

**Reading and writing your vault.** The plugin reads the contents of notes inside the folder you
choose, and writes inside that folder only. It writes frontmatter into your own notes there, to
give each one a stable id, and creates files under `<your folder>/YouSpot/`. Nothing outside the
folder is read or written.

**Listing your files.** The plugin asks Obsidian for the paths of the Markdown files in the vault,
which is how it finds the notes in your folder and how the folder picker offers you folder names.
That is a list of paths. Files outside your chosen folder are never opened, and their contents are
never read or sent.

**Clipboard.** One button writes to the clipboard: the one on the settings screen that copies the
`.gitignore` line for your token file. The plugin never reads the clipboard.

## Building

Built with [Bun](https://bun.sh) and esbuild. The output is a single CommonJS
bundle, `dist/main.js`, with `obsidian` left external.

```
bun install
bun run build      # bundles src/main.ts to dist/main.js
bun run typecheck
bun test
```

`OBSIDIAN_VAULT=/path/to/vault bun run install:dev` builds and copies the three
files straight into that vault, which is the quickest way to try a change.

The sync engine is deliberately kept behind two small interfaces, a vault port
and an HTTP port, so the whole of it runs under `bun test` against an in-memory
vault and a fake server, with no Obsidian process involved.

## Support

Issues and feature requests: <https://github.com/OnStartups/youspot-obsidian/issues>

## License

MIT. See [LICENSE](LICENSE).
