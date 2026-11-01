# catalog

The plugin catalog Buwiz Bot fetches at runtime: pointers to third-party
plugins in their own repositories, pinned to a commit.

```
https://raw.githubusercontent.com/buwiz-app/catalog/main/catalog.json
```

This repository holds no plugin code and no logo files. Each entry names a
GitHub repository, a commit and a folder; the Bot installs from there.

## How the Bot uses it

- Buwiz Bot fetches `catalog.json` at runtime and caches it for a day.
- Picking a plugin opens a review card before anything installs. The card
  shows what the plugin will add (its MCP servers, with their commands or
  URLs, the env and header names they use, and its skills), read from the
  plugin's own files at the pinned commit.
- Nothing installs until the user approves the review. Install clones
  `source.repo` at `source.sha` and uses the `source.path` folder.

## Schema (`v: 1`)

```jsonc
{
  "v": 1,
  "generatedAt": "2026-11-01T00:10:38Z", // latest commit time among the listed sources
  "plugins": [                           // sorted by id
    {
      "id": "neon-postgres",             // ^[a-z0-9][a-z0-9-]{0,63}$, unique
      "name": "Neon Postgres",
      "description": "…",
      "categories": [],                  // slugs of the plugin's own `category` values
      "publisher": { "name": "Neon", "url": "https://…" },   // url optional
      "homepage": "https://…",           // optional, https only
      "license": "Apache-2.0",           // SPDX id, OSI-approved
      "source": {
        "repo": "https://github.com/neondatabase/agent-skills",
        "sha": "<40 hex>",
        "path": "plugins/neon-postgres"  // "" for the repository root
      },
      "logo": "https://raw.githubusercontent.com/<owner>/<repo>/<sha>/<file>", // optional
      "servers": ["neon"],               // MCP server names the plugin declares, sorted
      "skills": ["neon", "neon-auth"],   // skill names, sorted
      "fields": [                        // optional: setup values the plugin declares
        { "key": "api_key", "label": "API key", "secret": true }
      ],
      "generated": ["description"]       // optional: fields this repo had to fill in
    }
  ]
}
```

`tools/validate.mjs` is the schema in code: unknown keys are errors, URLs must
be https, `logo` must be a file in `source.repo` at `source.sha`, strings and
lists have size limits, and the file is canonical 2-space JSON with a
trailing newline.

## Where every value comes from

Every text value and logo comes from the plugin's **own** published files at
the pinned commit, never written by hand and never copied from another
catalog:

| Field | Read from (first that has it) |
|---|---|
| `id` | the manifest's `name`, as a slug |
| `name` | `displayName` in `plugin.json` or its marketplace entry, else the README's first heading, else `name` |
| `description` | `plugin.json`, else its marketplace entry |
| `categories` | `category` / `categories` in those files |
| `publisher` | `author` in those files, else the marketplace `owner` |
| `homepage`, `license` | those files; `license` falls back to the plugin's or repository's LICENSE file |
| `logo` | `logo` in those files, a relative path to an image in the repo (at most 1 MB) |
| `servers` | `mcpServers` in `plugin.json` or the marketplace entry, else `mcp.json` / `.mcp.json` beside it |
| `skills` | `skills/*/SKILL.md` (or the folders `plugin.json` lists): the frontmatter `name`, else the folder name |
| `fields` | `userConfig` in `plugin.json` (`title` as label, `sensitive` as secret) |

Manifests are looked up the way the Bot looks them up: `plugin.json` under
`.buwiz-plugin/`, `.cursor-plugin/`, `.claude-plugin/`, `.grok-plugin/`,
`.codex-plugin/`, `.plugin/`, or the folder itself, in that order.

When a plugin publishes something the catalog requires but leaves it out
(today: a description or a publisher), the build fills in a short neutral
value (`Plugin from <owner>/<repo>`, or the GitHub owner) and names the field
in `generated`.

## How entries are chosen

`sources.json` is the whole input:

```json
{
  "marketplaces": [{ "repo": "https://github.com/cursor/plugins", "ref": "main" }],
  "plugins": [{ "repo": "https://github.com/neondatabase/agent-skills", "ref": "main", "path": "plugins/neon-postgres" }],
  "excluded": [{ "repo": "https://github.com/o/r", "path": "optional/dir", "reason": "why" }]
}
```

- `marketplaces`: every plugin listed in the repository's `marketplace.json`
  files (`plugins[].name/source`, `metadata.pluginRoot`). When two
  marketplace files list the same name, the higher-ranked folder wins
  (`.cursor-plugin` before `.claude-plugin`).
- `plugins`: one plugin each, a repository folder (`""` for the root).
- `excluded`: sources the build leaves out, with the reason on record.

A plugin is listed only if it carries an OSI-approved license (declared in
its manifest or in a LICENSE file) and its README doesn't restrict
redistribution. The build prints every plugin it skips and why.

## Licenses and names

The tools and schema in this repository are Apache-2.0 (see `LICENSE`).
Catalog entries describe third-party works that stay under their own
licenses, recorded in each entry's `license` field. Plugin names and logos
belong to their owners; listing a plugin implies no endorsement by or
affiliation with them. See `NOTICE`.

## Building

Node 22, no dependencies.

```sh
GITHUB_TOKEN=$(gh auth token) node tools/build.mjs   # resolve sources, write catalog.json
node tools/build.mjs --check                          # rebuild, fail if catalog.json differs
node tools/build.mjs --validate                       # schema-check catalog.json, no network
node --test tools/*.test.mjs
```

`GITHUB_TOKEN` is optional; it raises the GitHub API rate limit.

The `build` workflow rebuilds daily, on demand and on every push to `main`,
and commits `catalog.json` when it changed. The `ci` workflow validates the
committed file and runs the tests on pull requests.

## Adding a plugin

Open a pull request that adds its repository to `sources.json` (a
`marketplaces` entry for a repo with `marketplace.json`, else a `plugins`
entry with the folder holding its `plugin.json` or `.mcp.json`). Run the build
and include the regenerated `catalog.json`, or leave it for the daily build.
