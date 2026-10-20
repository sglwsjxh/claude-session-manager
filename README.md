<h1 align="center">Claude Code session manager</h1>

<p align="center"><a href="README.md">English</a> | <a href="README-cn.md">简体中文</a></p>

## Overview

A Claude Code session management cli tool

Claude Code can resume past conversations but cannot delete them. This is a terminal tool for browsing, previewing, and deleting sessions, with every trace on disk cleaned up in one shot: companion directories, environment scripts, file edit history, prompt history, paste cache, and more

Pure Node.js, zero runtime dependencies

## Quick start

```bash
npm install -g @sglwsjxh/claude-session-manager
sessions-manager --list
```

Running it from a clone works as well:

```bash
git clone https://github.com/sglwsjxh/claude-session-manager.git
cd claude-session-manager
npm test
bin/sessions-manager --list
```

Check the version and the full option list with:

```bash
sessions-manager --version
sessions-manager --help
```

## Installation

### npm global install (recommended)

```bash
npm install -g @sglwsjxh/claude-session-manager
```

The command stays `sessions-manager` after installation; the npm package is scoped as `@sglwsjxh/claude-session-manager`, while the source lives at [github.com/sglwsjxh/claude-session-manager](https://github.com/sglwsjxh/claude-session-manager)

### npm link from source (development)

```bash
git clone https://github.com/sglwsjxh/claude-session-manager.git
cd claude-session-manager
npm link
sessions-manager --list
```

### Run straight from a clone

```bash
git clone https://github.com/sglwsjxh/claude-session-manager.git
cd claude-session-manager
npm test
bin/sessions-manager --list
```

Node.js 18 or newer is required, the tool has zero runtime dependencies

## Interactive browser

```bash
sessions-manager
```

| Key | Action |
|---|---|
| ↑ ↓ | Move the selection |
| Enter | Preview the conversation |
| Backspace | Delete the selected session |
| Tab | Cycle filters: all, by project, under 100K, older than 30 days |
| Type | Search titles and first prompts |
| Esc | Quit |

A confirmation dialog lists every file and directory before anything is removed

## Command line

```bash
sessions-manager --list
sessions-manager --preview <session-id>
sessions-manager --plan <session-id>
sessions-manager --delete <session-id>
sessions-manager --older-than 30d
sessions-manager --smaller-than 100K
sessions-manager --version
sessions-manager --help
```

Session IDs accept a full UUID or just a prefix

Deletes and bulk cleanups run in two steps: the first call prints the plan and ends with `AWAITING_CONFIRMATION`; add `--yes` to execute after the user agrees

Add `--dry-run` to go through the delete flow without touching anything

Add `--json` for structured output

## What gets removed

| Location | Contents | Rule |
|---|---|---|
| `projects/<slug>/<id>.jsonl` | Main transcript | Always |
| `projects/<slug>/<id>/` | Companion directory with subagent transcripts and tool output | Always |
| `session-env/<id>/` | Session environment scripts | Always |
| `file-history/<id>/` | File edit snapshots | Always |
| `sessions/<pid>.json` | Session registry entry | Only once the PID has exited |
| `history.jsonl` | Prompt history | Rewritten atomically, matching lines dropped |
| `paste-cache/<hash>.txt` | Paste cache | Only when exclusively owned |
| `plans/<name>.md` | Plan files | Only when exclusively owned |
| `tasks/<id>/` `teams/<id>/` | Task and team directories | Always |
| `todos/` | Todo entries named after the session | Only matching files |
| `debug/<id>.txt` | Debug log | Only that file |
| `telemetry/` | Failed event records | Only matching files |

Shared paste cache entries and plan files are skipped, with the reason reported

## Safety

Two cases refuse the delete:

1. The session currently in use
2. A session whose registered process is still alive

For path safety, session IDs containing separators or `..` are rejected, and every target must resolve inside the `.claude` directory

Deletion is permanent and does not go to the recycle bin. `history.jsonl` is replaced atomically through a temporary file, with no backup copy kept

## Known limitations

- No in-session slash command. Claude Code plugin components offer no native frontend command: slash commands of skills and commands are prompts sent to the model, while native ones like `/resume` are compiled into the CLI and unavailable to plugins. The `!` prefix passthrough in the input box also reports output back to the AI afterwards. So session management stays in the terminal; run `sessions-manager` directly
- JSONL entry format is internal to Claude Code and may change between versions. This tool reads only stable fields (`type`, `cwd`, `isSidechain`, `customTitle`, `aiTitle`, `lastPrompt`) and degrades gracefully on missing ones

## Development

```bash
npm test
```

Four test files built on `node:assert`, zero dependencies, isolated in temporary directories

```
skills/sessions/scripts/
├── session-store.cjs      session discovery and metadata parsing
├── session-cleaner.cjs    footprint cleanup
└── session-picker.cjs     interactive browser and command line
```

Measured storage layout notes live in [docs/sessions-layout.md](docs/sessions-layout.md)

## License

[MIT](LICENSE)

## Acknowledgements

- [GravesXX/session-manager](https://github.com/GravesXX/session-manager) (MIT) — shape reference for the interactive session browser
- [KenCheung-AIxFinance/claude-code-session-manager](https://github.com/KenCheung-AIxFinance/claude-code-session-manager) — reference for the deletion footprint list and shared-resource rules
- [zzusp/claude-code-session](https://github.com/zzusp/claude-code-session) — reference for active session detection and path safety rules
