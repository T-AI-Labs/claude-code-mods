# Claude Code Mods

Two mods for Claude Code. Each adds one row above the prompt and works on its own; installed together, the rows stack.

## context-bar

```
Cache ━━━━━━━━━━━━ 92%  Context ━━━━━━━━━━━━ 41%  [ Auto-compact 97% ]  [ Compact ]  [ Clear ]
```

- **Cache** — share of the last turn's input tokens that the prompt cache served.
- **Context** — fill of the model's context window, as the status line reports it.
- **Auto-compact** — press to cycle the threshold through 97, 90, 70, 60 and 50 %. The choice is kept across sessions.
- **Compact** / **Clear** — run `/compact` and `/clear`.

The threshold is checked after each turn: once the context fill reaches it, the mod runs `/compact`. It does not fire again until the fill has dropped below the threshold. Claude Code's built-in auto-compaction stays on and still runs at its own limit, so a threshold above that limit never fires, and a long turn can pass the threshold before the mod gets to compact.

## usage-limits

```
5h limit ━━━━━━━━━━━━ 42% · resets in 2h 13m   Weekly limit ━━━━━━━━━━━━ 18% · resets in 3d 4h
```

Shows how much of each rate-limit window is used, colored green, yellow or red, with the time until the window resets. The figures arrive with the first response of a session and are only reported on a subscription plan; until then the row reads `Usage limits: no reading yet`.

## Install

From a terminal session of Claude Code:

```
/plugin install context-bar --marketplace thorstenalpers/ClaudeCodeMods
```

```
/plugin install usage-limits --marketplace thorstenalpers/ClaudeCodeMods
```

Answer `y` to add the marketplace, then pick a scope. Installed at the user scope, the mods also load in sessions the desktop app starts.

### From a local clone

```
claude plugin marketplace add <path-to-this-folder>
claude plugin install context-bar@claude-code-mods
claude plugin install usage-limits@claude-code-mods
```

## Develop

```
claude plugin validate context-bar
claude plugin test context-bar
claude --plugin-dir context-bar --plugin-dir usage-limits
```

## Publishing

The repository is the marketplace: whatever is on `main` is what `/plugin install` serves.

1. Create a branch and make the change.
2. Raise `version` in the mod's `.claude-plugin/plugin.json`. Without a new version, installed copies do not update.
3. Open a pull request. CI validates the marketplace and runs every mod's tests.
4. Merge it. The release workflow then tags `<mod>-v<version>` and publishes a GitHub release with the mod as a zip.

To add a mod, put its folder at the repository root and list it under `plugins` in `.claude-plugin/marketplace.json`.

People who already installed a mod get the new version with:

```
claude plugin marketplace update claude-code-mods
claude plugin update context-bar@claude-code-mods
```

## License

[MIT](LICENSE)
