# Margin

[![CI](https://github.com/kteal/margin/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/kteal/margin/actions/workflows/ci.yml?query=branch%3Amain)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue?logo=opensourceinitiative)](LICENSE)
![Nix Flake](https://img.shields.io/badge/Nix-Flake-5277C3?logo=nixos)
![VS Code](https://img.shields.io/badge/VS%20Code-%5E1.88-007ACC)
![JavaScript](https://img.shields.io/badge/JavaScript-ES2022-F7DF1E?logo=javascript&logoColor=black)

Margin is a VS Code extension for private, project-local code notes. Notes render like comments in the editor, but they are stored outside source files so they do not appear in commits or pull requests.

It is meant for personal context: the thing you would have written as a comment, but do not want to commit, publish, or send through code review.

## Features

- Add a private note to the current line or selected range.
- Toggle all inline notes on and off.
- Render notes as virtual comments at the end of source lines.
- Store notes in `.margin/notes.json` per workspace folder.
- Add `.margin/` to `.git/info/exclude` when possible, keeping the ignore rule local to your clone.
- Search notes with `Margin: Search Notes` and jump back to source.
- Track the git branch and commit where a note was created.
- Relocate notes after edits when the original line or selection can still be found.

## Commands

- `Margin: Add Note`
- `Margin: Edit Note`
- `Margin: Delete Note`
- `Margin: Toggle Notes`
- `Margin: Search Notes`

## Default Keybindings

- Toggle notes: `Ctrl+Alt+M` (`Cmd+Alt+M` on macOS)
- Add note: `Ctrl+Alt+N` (`Cmd+Alt+N` on macOS)

You can override these in VS Code's Keyboard Shortcuts editor.

## Storage

Margin stores notes in `.margin/notes.json` inside each workspace folder. The first time a note is saved in a git repository, Margin tries to add `.margin/` to `.git/info/exclude`. That keeps the storage private to your clone without changing the repository's tracked `.gitignore`.

## Install Locally

Build a VSIX with Nix:

```sh
nix build .#vsix
```

Install the generated extension:

```sh
code --install-extension result/margin-0.0.1.vsix
```

You can also download the VSIX artifact from successful CI runs.

## Development

Open this folder in VS Code and run the extension with the Extension Development Host.

```sh
npm run check
```

## Nix

Build the extension package:

```sh
nix build
```

Build a `.vsix`:

```sh
nix build .#vsix
```

Enter a development shell with Node and `vsce`:

```sh
nix develop
```

## GitHub Actions

CI runs on pushes, pull requests, and manual dispatch. It checks extension syntax, verifies package contents, validates the flake, builds the Nix extension package, and builds/uploads the VSIX artifact.
