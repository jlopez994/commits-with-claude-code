# Changelog

## 0.1.0

- Generate the commit message from staged changes (or all changes) with `claude -p`.
- Split pending changes into minimal commits, by file or by hunk (`splitBy`).
- Choose what is asked before committing (`confirm`: dialog, editable review or none) and undo from the final notification.
- Follows each repository's `CLAUDE.md` and commit history.
- English and Spanish UI.
