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

## Install

From a command prompt (cmd, PowerShell or any shell):

```
claude plugin marketplace add thorstenalpers/CCMods
claude plugin install context-bar@claude-code-mods
claude plugin install usage-limits@claude-code-mods
```

Or from the prompt of a Claude Code terminal session:

```
/plugin install context-bar --marketplace thorstenalpers/CCMods
/plugin install usage-limits --marketplace thorstenalpers/CCMods
```

The mods then load in every new session, including those the desktop app starts.

## Options

Both mods take the same two options:

| Option | Values | Default | Effect |
| --- | --- | --- | --- |
| `display` | `gauge`, `text` | `gauge` | `gauge` draws a five-segment fill level, `▮▮▯▯▯`, before each percentage; `text` leaves it out. |
| `details` | `true`, `false` | `true` | Shows the figures in parentheses. |

Set them while installing:

```
claude plugin install context-bar@claude-code-mods --config display=text
```

In a terminal session they are also rows of the `/config` menu.

## Update

```
claude plugin marketplace update claude-code-mods
claude plugin update context-bar@claude-code-mods
claude plugin update usage-limits@claude-code-mods
```

## License

[MIT](LICENSE)
