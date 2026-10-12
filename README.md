# Claude Code Mods

Two mods for Claude Code. Each adds one row above the prompt and works on its own; installed together, the rows stack and their columns line up.

## context-bar

```
Cache    ▮▮▮▮▮  92% (92k/100k)     Context      ▮▯▯▯▯  10% (100k/1M)      [ Auto-compact 97% ] [ Compact ] [ Clear ]
```

- **Cache** — share of the last turn's input tokens that the prompt cache served, with the token counts behind it.
- **Context** — fill of the model's context window, as the status line reports it, with tokens used and window size.
- **Auto-compact** — press to cycle the threshold through 97, 90, 70, 60 and 50 %. The choice is kept across sessions.
- **Compact** / **Clear** — run `/compact` and `/clear`.

The threshold is checked after each turn: once the context fill reaches it, the mod runs `/compact`. It does not fire again until the fill has dropped below the threshold. Claude Code's built-in auto-compaction stays on and still runs at its own limit, so a threshold above that limit never fires, and a long turn can pass the threshold before the mod gets to compact.

## usage-limits

```
5h limit ▮▮▯▯▯  42% (2h 13m left)  Weekly limit ▮▯▯▯▯  18% (3d 4h left)
```

Shows how much of each rate-limit window is used, with the time until the window resets. The figures stay neutral and turn yellow from 75 % and red from 90 %. The figures arrive with the first response of a session and are only reported on a subscription plan; until then the row reads `Usage limits: no reading yet`.

## Options

Both mods take the same two options:

| Option | Values | Default | Effect |
| --- | --- | --- | --- |
| `display` | `gauge`, `text` | `gauge` | `gauge` draws a five-segment fill level, `▮▮▯▯▯`, before each percentage; `text` leaves it out. |
| `details` | on, off | on | Shows the figures in parentheses. |

`/plugin install` asks for them, and in a terminal session they are rows of the `/config` menu. They are stored in `settings.json` under `pluginConfigs[<plugin>].options`, which is also where to change them for sessions the desktop app starts.

Gauges and details are always drawn as set, and each mod stays on one line.

## Install

From a terminal session of Claude Code:

```
/plugin install context-bar --marketplace thorstenalpers/CCMods
```

```
/plugin install usage-limits --marketplace thorstenalpers/CCMods
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
