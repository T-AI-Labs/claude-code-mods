<h1 align="center">CCMods</h1>

<p align="center"><em>Cache, context and usage limits at a glance, right above the Claude Code prompt.</em></p>

<p align="center">
  <a href="https://github.com/thorstenalpers/CCMods/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/thorstenalpers/CCMods/ci.yml?branch=main&style=flat-square&label=ci" alt="CI"></a>
  <a href="https://github.com/thorstenalpers/CCMods/releases"><img src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fthorstenalpers%2FCCMods%2Fmain%2Fcontext-bar%2F.claude-plugin%2Fplugin.json&query=%24.version&prefix=v&label=context-bar&style=flat-square" alt="context-bar version"></a>
  <a href="https://github.com/thorstenalpers/CCMods/releases"><img src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fthorstenalpers%2FCCMods%2Fmain%2Fusage-limits%2F.claude-plugin%2Fplugin.json&query=%24.version&prefix=v&label=usage-limits&style=flat-square" alt="usage-limits version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/thorstenalpers/CCMods?style=flat-square" alt="License"></a>
  <img src="https://img.shields.io/badge/Claude%20Code-tested%20on%202.1.295-d97757?style=flat-square" alt="Tested on Claude Code 2.1.295">
</p>

<p align="center">
  <a href="#install"><strong>Install</strong></a> ·
  <a href="#context-bar">context-bar</a> ·
  <a href="#usage-limits">usage-limits</a> ·
  <a href="#configure">Configure</a> ·
  <a href="#update-and-uninstall">Update</a>
</p>

<p align="center"><img src="docs/preview.svg" alt="context-bar and usage-limits above the Claude Code prompt" width="100%"></p>

<p align="center"><sub>Illustration of both mods above the prompt, with the default settings.</sub></p>

## TL;DR

- **context-bar** shows the prompt-cache hit rate and the context fill, and puts Auto-compact, Compact and Clear one click away.
- **usage-limits** shows how much of the 5-hour and weekly limits is used, and how long until each resets.
- Each is one quiet line. The figures stay neutral and only take a color when something needs attention.
- They work in the Claude Code CLI and in the desktop app, alone or together. Together, their columns line up.
- No network calls and no external programs. The mods read figures Claude Code already has and run its own `/compact` and `/clear`.

```
claude plugin marketplace add thorstenalpers/CCMods
claude plugin install context-bar@claude-code-mods
claude plugin install usage-limits@claude-code-mods
```

## Install

Run the three commands above in any shell (cmd, PowerShell, bash). The mods load in every session started afterwards, in the terminal and in the desktop app.

From the prompt of a running Claude Code terminal session, the same install is:

```
/plugin install context-bar --marketplace thorstenalpers/CCMods
/plugin install usage-limits --marketplace thorstenalpers/CCMods
```

The mods use Claude Code's function-hook plugin API, which is in early access and may change between releases. They are built and tested against Claude Code 2.1.295.

## context-bar

```
Cache    ▮▮▮▮▮  92% (92k/100k)     Context      ▮▯▯▯▯  10% (100k/1M)      [ Auto-compact 97% ] [ Compact ] [ Clear ]
```

| Element | What it shows |
| --- | --- |
| **Cache** | Share of the last turn's input tokens that the prompt cache served, with tokens read and total input in parentheses. Turns yellow below 40 %. |
| **Context** | Fill of the model's context window, with tokens used and window size in parentheses. Turns yellow within 15 points of the auto-compact threshold and red at it. |
| **Auto-compact** | The threshold in percent. Each press steps through 97, 90, 70, 60 and 50. The choice is kept across sessions. |
| **Compact** | Runs `/compact`. |
| **Clear** | Runs `/clear`. |

Both figures read `–` until the first response of a session, and again after a clear.

### How auto-compact works

After each turn the mod compares the context fill with the threshold and runs `/compact` once it is reached. It does not fire again until the fill has dropped below the threshold, so a compaction that lands above it does not loop.

Claude Code's built-in auto-compaction stays on and still runs at its own limit. A threshold above that limit therefore never fires, and a long turn can pass the threshold before the mod gets to compact.

## usage-limits

```
5h limit ▮▮▯▯▯  42% (2h 13m left)  Weekly limit ▮▮▮▮▯  78% (3d 4h left)
```

Each rate-limit window Claude Code reports gets a gauge, the percentage used and the time left until it resets. A figure turns yellow from 75 % and red from 90 %.

The readings arrive with the first response of a session and are only reported on a subscription plan. Until then the row reads `Usage limits: no reading yet`.

## Configure

Both mods take the same two options:

| Option | Values | Default | Effect |
| --- | --- | --- | --- |
| `display` | `gauge`, `text` | `gauge` | `gauge` draws a five-segment fill level before each percentage; `text` leaves it out. |
| `details` | `true`, `false` | `true` | Shows the figures in parentheses. |

Set them while installing:

```
claude plugin install context-bar@claude-code-mods --config display=text
```

In a terminal session they are also rows of the `/config` menu. Give both mods the same settings to keep their columns aligned.

In the terminal, press a button with the mouse, or move the focus into the row with `ctrl+x tab` and use Tab and Enter.

## Update and uninstall

```
claude plugin marketplace update claude-code-mods
claude plugin update context-bar@claude-code-mods
claude plugin update usage-limits@claude-code-mods
```

```
claude plugin uninstall context-bar@claude-code-mods
claude plugin uninstall usage-limits@claude-code-mods
```

A new session picks up the change.

## License

[MIT](LICENSE)
