# Changelog

## 0.1.1

- Splitting works in a repository with no commits yet, and Undo leaves it without commits again.
- Files whose names git quotes (with `"`, `\` or control characters) are split correctly.
- On Windows, finds and runs Claude Code installed with npm (`claude.cmd`), without going through a shell.
- `claudeCommit.claudePath` can only be set in user or remote settings, not by a workspace.
- `claude -p` runs without your hooks, so they no longer change the generated messages.
- Icon.

## 0.1.0

- Generate the commit message from staged changes (or all changes) with `claude -p`.
- Split pending changes into minimal commits, by file or by hunk (`splitBy`).
- Choose what is asked before committing (`confirm`: dialog, editable review or none) and undo from the final notification.
- Follows each repository's `CLAUDE.md` and commit history.
- English and Spanish UI.
