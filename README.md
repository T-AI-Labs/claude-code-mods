<h1 align="center">Claude Code Mods</h1>

<p align="center"><em>See your prompt-cache hit rate, context fill and usage limits at a glance, right above the Claude Code prompt.</em></p>

<p align="center">
  <a href="https://github.com/T-AI-Labs/claude-code-mods/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/T-AI-Labs/claude-code-mods/ci.yml?branch=main&style=flat-square&label=ci" alt="CI"></a>
  <a href="https://github.com/T-AI-Labs/claude-code-mods/releases"><img src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FT-AI-Labs%2Fclaude-code-mods%2Fmain%2Fcache-meter%2F.claude-plugin%2Fplugin.json&query=%24.version&prefix=v&label=cache-meter&style=flat-square" alt="cache-meter version"></a>
  <a href="https://github.com/T-AI-Labs/claude-code-mods/releases"><img src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FT-AI-Labs%2Fclaude-code-mods%2Fmain%2Fcontext-meter%2F.claude-plugin%2Fplugin.json&query=%24.version&prefix=v&label=context-meter&style=flat-square" alt="context-meter version"></a>
  <a href="https://github.com/T-AI-Labs/claude-code-mods/releases"><img src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FT-AI-Labs%2Fclaude-code-mods%2Fmain%2Fusage-limits%2F.claude-plugin%2Fplugin.json&query=%24.version&prefix=v&label=usage-limits&style=flat-square" alt="usage-limits version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/T-AI-Labs/claude-code-mods?style=flat-square" alt="License"></a>
  <img src="https://img.shields.io/badge/Claude%20Code-2.1.295-d97757?style=flat-square" alt="Claude Code 2.1.295">
  <img src="https://img.shields.io/badge/Claude%20desktop%20app-2.31226.1-d97757?style=flat-square" alt="Claude desktop app 2.31226.1">
</p>

<p align="center">
  <a href="#install"><strong>Install</strong></a> ·
  <a href="#cache-meter">cache-meter</a> ·
  <a href="#context-meter">context-meter</a> ·
  <a href="#usage-limits">usage-limits</a> ·
  <a href="#token-cost">Token cost</a> ·
  <a href="#configure">Configure</a> ·
  <a href="#update-and-uninstall">Update</a> ·
  <a href="#credits">Credits</a>
</p>

<p align="center"><img src="docs/preview.svg" alt="cache-meter and usage-limits above the Claude Code prompt" width="100%"></p>

<p align="center"><sub>Illustration of both mods above the prompt, with the default settings.</sub></p>

## TL;DR

- **cache-meter** shows how much of each turn the prompt cache served and how long the cache stays warm, and can keep it warm while you are away.
- **context-meter** shows the context fill and puts the auto-compact threshold, Compact and Clear one click away.
- **usage-limits** shows how much of the 5-hour and weekly limits is used, and how long until each resets.
- Each is one quiet line. The figures stay neutral and only take a color when something needs attention.
- They work in the Claude Code CLI and in the desktop app, alone or together. Together, their columns line up.
- No network calls, no external programs and no extra tokens for the display; only cache-meter's Keep warm, when you switch it on, makes requests. See [Token cost](#token-cost).

```
claude plugin marketplace add T-AI-Labs/claude-code-mods
claude plugin install cache-meter@T-AI-Labs
claude plugin install context-meter@T-AI-Labs
claude plugin install usage-limits@T-AI-Labs
```

## Install

Run the four commands above in any shell (cmd, PowerShell, bash). The mods load in every session started afterwards, in the terminal and in the desktop app.

From the prompt of a running Claude Code terminal session, the same install is:

```
/plugin install cache-meter --marketplace T-AI-Labs/claude-code-mods
/plugin install context-meter --marketplace T-AI-Labs/claude-code-mods
/plugin install usage-limits --marketplace T-AI-Labs/claude-code-mods
```

The mods use Claude Code's function-hook plugin API, which is in early access and may change between releases. They are built and tested against Claude Code 2.1.295, the engine in the Claude desktop app 2.31226.1.

## cache-meter

```
Cache ▮▮▮▮▮  92% (92k/100k) warm 3:12  [ Keep warm ]
```

| Element | What it shows |
| --- | --- |
| **Cache** | Share of the last turn's input tokens that the prompt cache served, with tokens read and total input in parentheses. Turns yellow below 40 %. |
| **warm** / **cold** | How long the cache stays valid: it lapses five minutes after the start of the last request, or an hour once the mod has seen the session cache for that long. `cold` means the next turn writes the whole context again at full price, which also makes it the cheapest moment to compact or clear. |
| **Keep warm** | Off by default. Switched on, it refreshes the cache shortly before it lapses, for up to `keepWarmMinutes` after the last turn, and shows how many refreshes it made. It stops by itself when a refresh finds the cache already gone. |

The hit rate reads `–` until the first response of a session, and again after a clear.

### Why the hit rate matters

Every turn sends the whole conversation again. Tokens the cache serves cost about a tenth of the normal input price, and a twentieth on Claude Opus 5.5; tokens written to it cost 1.25 times the input price. A high hit rate is a cheap turn, `0%` the most expensive kind. The cache lapses after a pause, on a model switch, and when something early in the context changes, such as CLAUDE.md or the tools.

### What Keep warm costs

Each refresh is a request that reads the cached context once, at the cache price, plus a one-word reply. With 200k tokens on Claude Opus 5.5 that is about $0.04 a refresh, against about $1.00 for writing the context again after it went cold. Refreshes come about every four and a half minutes, so an hour costs about half of one rewrite: worth it when you come back, lost when you don't. On a subscription the refreshes count against the usage limits instead.

## context-meter

```
Context ▮▯▯▯▯  10% (100k/1M)  Auto 97% ▾  [ Compact ] [ Clear ]
```

| Element | What it shows |
| --- | --- |
| **Context** | Fill of the model's context window, with tokens used and window size in parentheses. Turns yellow within 15 points of the auto-compact threshold and red at it. |
| **Auto** | The auto-compact threshold: the context fill, as shown under **Context**, at which the mod compacts on its own. A dropdown over 97, 90, 70, 60 and 50 %. The choice is kept across sessions. |
| **Compact** | Runs `/compact` now. |
| **Clear** | Runs `/clear`. |

The fill reads `–` until the first response of a session, and again after a clear.

### How auto-compact works

After each turn the mod compares the context fill with the threshold and runs `/compact` once it is reached. It does not fire again until the fill has dropped below the threshold, so a compaction that lands above it does not loop.

Claude Code's built-in auto-compaction stays on and still runs at its own limit. A threshold above that limit therefore never fires, and a long turn can pass the threshold before the mod gets to compact.

### Token cost

Showing the rows costs nothing. The mods read figures Claude Code already has and add nothing to the conversation; the one model request any of them makes is cache-meter's refresh while Keep warm is on.

A compaction does cost tokens, whether you press Compact or the threshold triggers it: `/compact` is a model request that summarizes the conversation, and the next turn starts on a cold cache. The lower the threshold, the more often that happens. To keep usage down, leave the threshold high and compact by hand when it suits you.

## usage-limits

```
5h    ▮▮▯▯▯  42% (2h 13m)   Week    ▮▮▮▮▯  78% (3d 4h)
```

Each rate-limit window Claude Code reports gets a gauge, the percentage used and, in parentheses, the time left until it resets. `5h` is the 5-hour limit, `Week` the weekly one. A figure turns yellow from 75 % and red from 90 %.

The readings arrive with the first response of a session and are only reported on a subscription plan. Until then the row shows the last reading of the previous session, marked with its age (`as of 3h 20m ago`) and without the windows that have reset since. With nothing to show it reads `Usage limits: no reading yet`.

## Configure

All three mods take the same two options:

| Option | Values | Default | Effect |
| --- | --- | --- | --- |
| `display` | `gauge`, `text` | `gauge` | `gauge` draws a five-segment fill level before each percentage; `text` leaves it out. |
| `details` | `true`, `false` | `true` | Shows the figures in parentheses. |

cache-meter also takes `keepWarmMinutes`, one of `15`, `30`, `60` or `120` (default `60`): how long after the last turn Keep warm goes on refreshing.

Change them at any time from a shell, once per mod. In PowerShell:

```
'{"display":"text","details":"false"}' | claude plugin configure cache-meter@T-AI-Labs --values-stdin
```

In cmd:

```
echo {"display":"text","details":"false"} | claude plugin configure cache-meter@T-AI-Labs --values-stdin
```

Leave out an option to keep its value. `claude plugin configure cache-meter@T-AI-Labs` alone shows what is set. A new session picks up the change.

They can also be set while installing, with `--config display=text`, and in a terminal session they are rows of the `/config` menu. Give the mods the same settings to keep their columns aligned.

### Fitting one line

context-meter needs about 62 columns with the defaults. On a narrower window its buttons wrap to a second line. Turning `details` off saves about 11 columns, `display` set to `text` about 6:

```
Context ▮▯▯▯▯  10%  Auto 97% ▾  [ Compact ] [ Clear ]
```

In the terminal, use the mouse, or move the focus into the row with `ctrl+x tab`: Tab walks the controls, Enter presses a button, and the arrow keys pick a threshold. To hide the rows there, collapse the band with its `[-]` mark or `ctrl+x ctrl+a`.

## Update and uninstall

```
claude plugin marketplace update T-AI-Labs
claude plugin update cache-meter@T-AI-Labs
claude plugin update usage-limits@T-AI-Labs
claude plugin install context-meter@T-AI-Labs
```

Since 0.4.0 cache-meter shows the cache alone; the context fill, the threshold and the Compact and Clear buttons moved to context-meter, which an update does not install by itself. The threshold you picked in cache-meter does not carry over: pick it again in context-meter.

```
claude plugin uninstall cache-meter@T-AI-Labs
claude plugin uninstall context-meter@T-AI-Labs
claude plugin uninstall usage-limits@T-AI-Labs
```

A new session picks up the change.

## Credits

The idea for these mods comes from [Julian Ivanov](https://www.youtube.com/@Julian-Ivanov) and his video [Diese 10 Claude Code Mods solltest du unbedingt kennen](https://www.youtube.com/watch?v=ji4ANdb_M6Y). The code in this repository was written independently.

## License

[MIT](LICENSE)
