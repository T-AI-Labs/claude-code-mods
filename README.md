<h1 align="center">Claude Code Mods</h1>

<p align="center"><em>See your prompt-cache hit rate, context fill and usage limits at a glance, right above the Claude Code prompt.</em></p>

<p align="center">
  <a href="https://github.com/T-AI-Labs/claude-code-mods/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/T-AI-Labs/claude-code-mods/ci.yml?branch=main&style=flat-square&label=ci" alt="CI"></a>
  <a href="https://github.com/T-AI-Labs/claude-code-mods/releases"><img src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FT-AI-Labs%2Fclaude-code-mods%2Fmain%2Fcache-meter%2F.claude-plugin%2Fplugin.json&query=%24.version&prefix=v&label=cache-meter&style=flat-square" alt="cache-meter version"></a>
  <a href="https://github.com/T-AI-Labs/claude-code-mods/releases"><img src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FT-AI-Labs%2Fclaude-code-mods%2Fmain%2Fusage-limits%2F.claude-plugin%2Fplugin.json&query=%24.version&prefix=v&label=usage-limits&style=flat-square" alt="usage-limits version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/T-AI-Labs/claude-code-mods?style=flat-square" alt="License"></a>
  <img src="https://img.shields.io/badge/Claude%20Code-2.1.295-d97757?style=flat-square" alt="Claude Code 2.1.295">
  <img src="https://img.shields.io/badge/Claude%20desktop%20app-2.31226.1-d97757?style=flat-square" alt="Claude desktop app 2.31226.1">
</p>

<p align="center">
  <a href="#install"><strong>Install</strong></a> ·
  <a href="#cache-meter">cache-meter</a> ·
  <a href="#usage-limits">usage-limits</a> ·
  <a href="#token-cost">Token cost</a> ·
  <a href="#configure">Configure</a> ·
  <a href="#update-and-uninstall">Update</a> ·
  <a href="#credits">Credits</a>
</p>

<p align="center"><img src="docs/preview.svg" alt="cache-meter and usage-limits above the Claude Code prompt" width="100%"></p>

<p align="center"><sub>Illustration of both mods above the prompt, with the default settings.</sub></p>

## TL;DR

- **cache-meter** shows how much of each turn the prompt cache served, next to the context fill, and puts the auto-compact threshold, Compact and Clear one click away.
- **usage-limits** shows how much of the 5-hour and weekly limits is used, and how long until each resets.
- Each is one quiet line. The figures stay neutral and only take a color when something needs attention.
- They work in the Claude Code CLI and in the desktop app, alone or together. Together, their columns line up.
- No network calls, no external programs and no extra tokens for the display. See [Token cost](#token-cost).

```
claude plugin marketplace add T-AI-Labs/claude-code-mods
claude plugin install cache-meter@T-AI-Labs
claude plugin install usage-limits@T-AI-Labs
```

## Install

Run the three commands above in any shell (cmd, PowerShell, bash). The mods load in every session started afterwards, in the terminal and in the desktop app.

From the prompt of a running Claude Code terminal session, the same install is:

```
/plugin install cache-meter --marketplace T-AI-Labs/claude-code-mods
/plugin install usage-limits --marketplace T-AI-Labs/claude-code-mods
```

The mods use Claude Code's function-hook plugin API, which is in early access and may change between releases. They are built and tested against Claude Code 2.1.295, the engine in the Claude desktop app 2.31226.1.

## cache-meter

```
Cache ▮▮▮▮▮  92% (92k/100k) Context ▮▯▯▯▯  10% (100k/1M)  Auto 97% ▾  [ Compact ] [ Clear ]
```

| Element | What it shows |
| --- | --- |
| **Cache** | Share of the last turn's input tokens that the prompt cache served, with tokens read and total input in parentheses. Turns yellow below 40 %. |
| **Context** | Fill of the model's context window, with tokens used and window size in parentheses. Turns yellow within 15 points of the auto-compact threshold and red at it. |
| **Auto** | The auto-compact threshold: the context fill, as shown under **Context**, at which the mod compacts on its own. A dropdown over 97, 90, 70, 60 and 50 %. The choice is kept across sessions. |
| **Compact** | Runs `/compact` now. |
| **Clear** | Runs `/clear`. |

Both figures read `–` until the first response of a session, and again after a clear.

### How auto-compact works

After each turn the mod compares the context fill with the threshold and runs `/compact` once it is reached. It does not fire again until the fill has dropped below the threshold, so a compaction that lands above it does not loop.

Claude Code's built-in auto-compaction stays on and still runs at its own limit. A threshold above that limit therefore never fires, and a long turn can pass the threshold before the mod gets to compact.

### Token cost

Showing the rows costs nothing. The mods read figures Claude Code already has; they make no model requests of their own and add nothing to the conversation.

A compaction does cost tokens, whether you press Compact or the threshold triggers it: `/compact` is a model request that summarizes the conversation, and the next turn starts on a cold cache. The lower the threshold, the more often that happens. To keep usage down, leave the threshold high and compact by hand when it suits you.

## usage-limits

```
5h    ▮▮▯▯▯  42% (2h 13m)   Week    ▮▮▮▮▯  78% (3d 4h)
```

Each rate-limit window Claude Code reports gets a gauge, the percentage used and, in parentheses, the time left until it resets. `5h` is the 5-hour limit, `Week` the weekly one. A figure turns yellow from 75 % and red from 90 %.

The readings arrive with the first response of a session and are only reported on a subscription plan. Until then the row reads `Usage limits: no reading yet`.

## Configure

Both mods take the same two options:

| Option | Values | Default | Effect |
| --- | --- | --- | --- |
| `display` | `gauge`, `text` | `gauge` | `gauge` draws a five-segment fill level before each percentage; `text` leaves it out. |
| `details` | `true`, `false` | `true` | Shows the figures in parentheses. |

Change them at any time from a shell, once per mod. In PowerShell:

```
'{"display":"text","details":"false"}' | claude plugin configure cache-meter@T-AI-Labs --values-stdin
```

In cmd:

```
echo {"display":"text","details":"false"} | claude plugin configure cache-meter@T-AI-Labs --values-stdin
```

Leave out an option to keep its value. `claude plugin configure cache-meter@T-AI-Labs` alone shows what is set. A new session picks up the change.

They can also be set while installing, with `--config display=text`, and in a terminal session they are rows of the `/config` menu. Give both mods the same settings to keep their columns aligned.

### Fitting one line

cache-meter needs about 92 columns with the defaults. On a narrower window its buttons wrap to a second line. Turning `details` off saves about 22 columns, `display` set to `text` about 12:

```
Cache ▮▮▮▮▮  92% Context ▮▯▯▯▯  10%  Auto 97% ▾  [ Compact ] [ Clear ]
```

In the terminal, use the mouse, or move the focus into the row with `ctrl+x tab`: Tab walks the controls, Enter presses a button, and the arrow keys pick a threshold. To hide both rows there, collapse the band with its `[-]` mark or `ctrl+x ctrl+a`.

## Update and uninstall

```
claude plugin marketplace update T-AI-Labs
claude plugin update cache-meter@T-AI-Labs
claude plugin update usage-limits@T-AI-Labs
```

```
claude plugin uninstall cache-meter@T-AI-Labs
claude plugin uninstall usage-limits@T-AI-Labs
```

A new session picks up the change.

## Credits

The idea for these mods comes from [Julian Ivanov](https://www.youtube.com/@Julian-Ivanov) and his video [Diese 10 Claude Code Mods solltest du unbedingt kennen](https://www.youtube.com/watch?v=ji4ANdb_M6Y). The code in this repository was written independently.

## License

[MIT](LICENSE)
