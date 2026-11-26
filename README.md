# Commits with Claude Code (unofficial)

Two buttons in the Source Control view, powered by your local [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI:

- **✨ Generate commit message**: fills the commit input box from your staged changes (or from all changes when nothing is staged).
- **Split changes into commits**: takes your staged changes (or all pending changes, untracked files included, when nothing
  is staged) and lets Claude group them into minimal, atomic commits, by file or by hunk (`claudeCommit.splitBy`). Depending on `claudeCommit.confirm` you confirm the
  list, review and edit it first, or let it commit straight away; the final notification always offers **Undo**.

## It follows each repository's rules

Nothing about commit style is hard-coded. `claude -p` runs from the repository root, so it loads that repository's `CLAUDE.md`,
and it also gets the branch name and the latest commit subjects. That means:

- the message format, language and prefixes are the ones your project uses (`PROJ-123 ...`, Conventional Commits, lowercase
  Spanish, whatever the conventions or history say);
- files your conventions say must never be committed (local config, secrets, generated files) are left out, with the reason;
- if your conventions forbid committing directly on the current branch, you get a warning before anything is created.

Add anything else with the `claudeCommit.extraInstructions` setting.

## Requirements

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed and logged in (`claude` in `~/.local/bin` or in the PATH,
  or set `claudeCommit.claudePath`).
- The built-in Git extension.

The diff is sent to Claude through your own Claude Code account, exactly as if you ran `claude -p` yourself. Use
`claudeCommit.exclude` for paths that must never leave your machine.

## Safety

- Claude runs with no tools (`--tools ""`), no MCP servers and no hooks: it only reads the prompt and answers. Your `CLAUDE.md`
  files still apply.
- Splitting only rebuilds the git index and creates commits; the working tree is never touched. With something staged, only
  that is split, using the staged version of each file, and whatever ends up in no commit stays staged. The initial `HEAD` is written to the **Claude commits** output together with the `git reset --soft` that undoes
  everything.
- By default nothing is committed without your confirmation. With `"claudeCommit.confirm": "none"` it commits straight away,
  except when Claude raises a warning (such as a protected branch): that is always confirmed. **Undo** resets softly to the
  initial `HEAD`, leaving the changes staged, and refuses if `HEAD` has moved since. Repository hooks run as usual (no `--no-verify`).
- It refuses to split while a merge is in progress.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `claudeCommit.claudePath` | `claude` | Claude Code executable |
| `claudeCommit.messageModel` | `haiku` | Model for the commit message |
| `claudeCommit.splitModel` | `sonnet` | Model for splitting into commits |
| `claudeCommit.splitBy` | `file` | `file`: each file whole in one commit · `hunk`: a file can be spread over several commits |
| `claudeCommit.confirm` | `confirm` | `confirm`: one dialog · `review`: editable list, then dialog · `none`: commit straight away |
| `claudeCommit.exclude` | `[]` | Git pathspecs never sent nor committed |
| `claudeCommit.extraInstructions` | | Appended to the prompt |
| `claudeCommit.timeoutSeconds` | `180` | Maximum wait for `claude -p` |

## Remote development

It is a workspace extension: with Remote-SSH, WSL or containers it runs where the repository and `claude` live.

## Limitations

- VS Code only lets Microsoft extensions put buttons inside the commit input box, so the buttons live in the Source Control
  title bar and on each repository row.
- Renames are handled as a deletion plus a new file.
- With `splitBy: hunk`, a hunk is the smallest unit: two changes git puts in the same hunk always go together.

This extension is not made or endorsed by Anthropic.
