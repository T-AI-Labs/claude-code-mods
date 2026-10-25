<h1 align="center">Claude Code Mods</h1>

<p align="center"><em>Context, prompt-cache and usage-limit meters right above the Claude Code prompt, and a pane that lists everything your setup provides.</em></p>

<p align="center">
  <a href="https://github.com/T-AI-Labs/claude-code-mods/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/T-AI-Labs/claude-code-mods/ci.yml?branch=main&style=flat-square&label=ci" alt="CI"></a>
  <a href="https://github.com/T-AI-Labs/claude-code-mods/releases"><img src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FT-AI-Labs%2Fclaude-code-mods%2Fmain%2Fcontext-usage%2F.claude-plugin%2Fplugin.json&query=%24.version&prefix=v&label=context-usage&style=flat-square" alt="context-usage version"></a>
  <a href="https://github.com/T-AI-Labs/claude-code-mods/releases"><img src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FT-AI-Labs%2Fclaude-code-mods%2Fmain%2Fcache-meter%2F.claude-plugin%2Fplugin.json&query=%24.version&prefix=v&label=cache-meter&style=flat-square" alt="cache-meter version"></a>
  <a href="https://github.com/T-AI-Labs/claude-code-mods/releases"><img src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FT-AI-Labs%2Fclaude-code-mods%2Fmain%2Fcatalog-pane%2F.claude-plugin%2Fplugin.json&query=%24.version&prefix=v&label=catalog-pane&style=flat-square" alt="catalog-pane version"></a>
  <a href="https://github.com/T-AI-Labs/claude-code-mods/releases"><img src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FT-AI-Labs%2Fclaude-code-mods%2Fmain%2Fcontext-meter%2F.claude-plugin%2Fplugin.json&query=%24.version&prefix=v&label=context-meter&style=flat-square" alt="context-meter version"></a>
  <a href="https://github.com/T-AI-Labs/claude-code-mods/releases"><img src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FT-AI-Labs%2Fclaude-code-mods%2Fmain%2Fusage-limits%2F.claude-plugin%2Fplugin.json&query=%24.version&prefix=v&label=usage-limits&style=flat-square" alt="usage-limits version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/T-AI-Labs/claude-code-mods?style=flat-square" alt="License"></a>
</p>

## Installation

Add the marketplace once, then install the mods you want with the first command in their row of the [Mods](#mods) table. To update, run the second lines: the marketplace first, then each mod. The commands work in any shell, or inside Claude Code with `/plugin` in place of `claude plugin`. New sessions load the changes.

```
claude plugin marketplace add T-AI-Labs/claude-code-mods
claude plugin marketplace update T-AI-Labs
```

The mods use Claude Code's function-hook plugin API, which is in early access and may change between releases. They are built and tested against Claude Code 2.1.295, the engine in the Claude desktop app 2.31226.1.

## Mods

context-usage already contains context-meter and usage-limits: install either it or those two, not both.

<table>
<tr><th>Mod</th><th>Description</th><th width="35%">Preview</th></tr>
<tr><td><a href="#context-usage">context&#8209;usage</a></td><td>

**Start here.** The context fill with the auto-compact threshold, Compact and Clear, and the 5-hour and weekly limits beneath it.

```
claude plugin install context-usage@T-AI-Labs
claude plugin update context-usage@T-AI-Labs
```

</td><td><img src=".docs/context-usage.svg" alt="The context-usage rows" width="320"></td></tr>
<tr><td><a href="#context-meter">context&#8209;meter</a></td><td>

The context row of context-usage on its own.

```
claude plugin install context-meter@T-AI-Labs
claude plugin update context-meter@T-AI-Labs
```

</td><td><img src=".docs/context-meter.svg" alt="The context-meter row" width="320"></td></tr>
<tr><td><a href="#usage-limits">usage&#8209;limits</a></td><td>

The usage row of context-usage on its own.

```
claude plugin install usage-limits@T-AI-Labs
claude plugin update usage-limits@T-AI-Labs
```

</td><td><img src=".docs/usage-limits.svg" alt="The usage-limits row" width="320"></td></tr>
<tr><td><a href="#cache-meter">cache&#8209;meter</a></td><td>

How much of each turn the prompt cache served and how long it stays warm, with a switch that keeps it warm while you are away.

```
claude plugin install cache-meter@T-AI-Labs
claude plugin update cache-meter@T-AI-Labs
```

</td><td><img src=".docs/cache-meter.svg" alt="The cache-meter row" width="320"></td></tr>
<tr><td><a href="#catalog-pane">catalog&#8209;pane</a></td><td>

A pane listing every skill, command, agent, mod, plugin, settings hook, MCP server and tool, with usage, token cost and buttons to use or manage each one.

```
claude plugin install catalog-pane@T-AI-Labs
claude plugin update catalog-pane@T-AI-Labs
```

</td><td><img src=".docs/catalog-pane.svg" alt="The catalog pane" width="320"></td></tr>
</table>

## context-usage

<p align="center"><img src=".docs/context-usage.svg" alt="The context-usage rows: context fill with the Auto threshold, Compact and Clear, and the 5-hour and weekly limits" width="640"></p>

context-meter and usage-limits in one mod: the context row and the usage row beneath it. Both work as described under [context-meter](#context-meter) and [usage-limits](#usage-limits). To switch from the two separate mods, install context-usage, uninstall context-meter and usage-limits, and pick the threshold again.

### Usage

The rows sit in the band above the prompt and cost no tokens: they only read figures Claude Code already has. In the terminal, `ctrl+x tab` moves into the band: Tab walks the controls, Enter presses a button, the arrow keys pick a threshold. `ctrl+x ctrl+a` or the band's `[-]` mark collapses it.

### Options

| Option | Values | Default | Effect |
| --- | --- | --- | --- |
| `display` | `gauge`, `text` | `gauge` | `gauge` draws a five-segment gauge before each percentage; `text` leaves it out. |
| `details` | `true`, `false` | `true` | Shows the figures in parentheses. |
| `usagePosition` | `below`, `above` | `below` | Puts the usage row under or on top of the context row. |

```
'{"display":"text","usagePosition":"above"}' | claude plugin configure context-usage@T-AI-Labs --values-stdin
```

That is PowerShell; in cmd, use `echo {"display":"text"} | …`. Options you leave out keep their value, the command without `--values-stdin` shows what is set, and a new session picks up the change. `--config display=text` sets an option while installing, and in a terminal session the options are rows of the `/config` menu.

## context-meter

<p align="center"><img src=".docs/context-meter.svg" alt="The context-meter row: context fill with the Auto threshold, Compact and Clear" width="640"></p>

| Element | What it shows |
| --- | --- |
| **Context** | Fill of the context window, with tokens used and window size. Yellow within 15 points of the threshold, red at it; with Auto off, the same against 100 %. |
| **Auto** | The fill at which the mod compacts on its own: Off, 97, 90, 70, 60 or 50 %. Off leaves it to you and to Claude Code's built-in auto-compaction. Kept across sessions. |
| **Compact** | Runs `/compact` now. |
| **Clear** | Runs `/clear`. |

### Usage

The row sits in the band above the prompt and costs no tokens: it only reads figures Claude Code already has. In the desktop app it is two lines high so the app's taller buttons fit. In the terminal, `ctrl+x tab` moves into the band: Tab walks the controls, Enter presses a button, the arrow keys pick a threshold. `ctrl+x ctrl+a` or the band's `[-]` mark collapses it.

Until the first response of a session, and again after a clear, the fill reads `0%`: the engine counts the system prompt and tools only once a response arrives.

### Options

| Option | Values | Default | Effect |
| --- | --- | --- | --- |
| `display` | `gauge`, `text` | `gauge` | `gauge` draws a five-segment gauge before the percentage; `text` leaves it out. |
| `details` | `true`, `false` | `true` | Shows the figures in parentheses. |

```
'{"display":"text","details":"false"}' | claude plugin configure context-meter@T-AI-Labs --values-stdin
```

Set them as for [context-usage](#options). The row needs about 62 columns with the defaults; on a narrower window the buttons wrap to a second line. `details` off saves about 11 columns, `display` set to `text` about 6:

<p align="center"><img src=".docs/context-narrow.svg" alt="The context row without the token counts" width="640"></p>

### How auto-compact works

After each turn the mod compares the fill with the threshold and runs `/compact` once it is reached. It fires again only after the fill has dropped below the threshold, so a compaction that lands above it does not loop. Claude Code's built-in auto-compaction still runs at its own limit, so a threshold above that limit never fires.

Every compaction costs tokens, whether you press Compact or the threshold triggers it: `/compact` is a model request that summarizes the conversation, and the next turn starts on a cold cache. To keep usage down, leave the threshold high and compact by hand when it suits you.

## usage-limits

<p align="center"><img src=".docs/usage-limits.svg" alt="The usage-limits row: the 5-hour and weekly limits with their resets" width="640"></p>

A gauge for each rate-limit window, with the percentage used and the time until it resets: `5h` for the 5-hour limit, `Week` for the weekly one. Yellow from 75 %, red from 90 %.

### Usage

The row sits in the band above the prompt and costs no tokens. `ctrl+x ctrl+a` or the band's `[-]` mark collapses it in the terminal.

Claude Code reports the limits only on a subscription plan, with each response. Until the first one, and right after a `/clear`, the row shows the last reading, with a window that has reset since at 0 %. A window that never had a reading shows `–`.

Sessions running side by side share their readings through a file on your machine, once a minute and at no token cost, so an idle session still shows what the others used. context-usage and usage-limits keep separate stores and do not share with each other.

### Options

| Option | Values | Default | Effect |
| --- | --- | --- | --- |
| `display` | `gauge`, `text` | `gauge` | `gauge` draws a five-segment gauge before each percentage; `text` leaves it out. |
| `details` | `true`, `false` | `true` | Shows the reset times in parentheses. |

```
'{"display":"text"}' | claude plugin configure usage-limits@T-AI-Labs --values-stdin
```

Set them as for [context-usage](#options). Give the row mods the same `display` and `details` to keep their columns aligned.

## cache-meter

<p align="center"><img src=".docs/cache-meter.svg" alt="The cache-meter row: hit rate, warm time and Keep warm" width="640"></p>

| Element | What it shows |
| --- | --- |
| **Cache** | Share of the last turn's input tokens served from the prompt cache, with tokens read and total input. Yellow below 40 %; `–` until the first response and after a clear. |
| **warm** / **cold** | How long the cache stays valid: five minutes after the last request starts, or an hour once the session has used the hour-long cache. `cold` means the next turn writes the whole context again at full price, the cheapest moment to compact or clear. |
| **Keep warm** | Off by default. Refreshes the cache shortly before it lapses, for up to `keepWarmMinutes` after the last turn, and counts the refreshes. Stops when a refresh finds the cache already gone. |

### Usage

The row sits in the band above the prompt and costs no tokens; only Keep warm's refreshes are model requests. Keep warm is a text link in the desktop app and a button elsewhere. In the terminal, `ctrl+x tab` moves into the band, Tab walks the controls and Enter presses one. `ctrl+x ctrl+a` or the band's `[-]` mark collapses it.

Before 0.4.0 cache-meter also showed the context fill, threshold, Compact and Clear. They moved to context-meter, which an update does not install: install it and pick the threshold again.

### Options

| Option | Values | Default | Effect |
| --- | --- | --- | --- |
| `display` | `gauge`, `text` | `gauge` | `gauge` draws a five-segment gauge before the percentage; `text` leaves it out. |
| `details` | `true`, `false` | `true` | Shows the figures in parentheses. |
| `keepWarmMinutes` | `15`, `30`, `60`, `120` | `60` | How long after the last turn Keep warm goes on refreshing. |

```
'{"keepWarmMinutes":"120"}' | claude plugin configure cache-meter@T-AI-Labs --values-stdin
```

Set them as for [context-usage](#options).

### Why the hit rate matters

Every turn sends the whole conversation again. Cached tokens cost about a tenth of the input price, a twentieth on Claude Opus 5.5; writing them to the cache costs 1.25 times the input price. The cache lapses after a pause, on a model switch, and when something early in the context changes, such as CLAUDE.md or the tools.

### What Keep warm costs

Each refresh reads the cached context once at the cache price, plus a one-word reply. With 200k tokens on Claude Opus 5.5 that is about $0.04, against about $1.00 for writing the context again after it went cold. At one refresh every four and a half minutes, an hour costs about half a rewrite: worth it if you come back, lost if you don't. On a subscription the refreshes count against the usage limits.

## catalog-pane

<p align="center"><img src=".docs/catalog-pane.svg" alt="The catalog pane listing skills" width="882"></p>

A pane with one tab per category: **Skills**, **Commands**, **Agents**, **Mods**, **Plugins**, **Hooks** (from the settings files), **MCP** servers and built-in **Tools**.

### Usage

`/catalog` opens the pane, in the desktop app and in the terminal; `/catalog mods` opens a category, `/catalog <text>` a search. Each row shows the entry's origin, how often it was used in total and in the last 30 days, and for plugin parts the tokens it adds to every session. Usage is counted from the install of the mod on. On the desktop you can filter by text and origin and sort:

| Sort | Order |
| --- | --- |
| Most used, Recently used, Name | By usage, or alphabetically. |
| Clean-up | Costly and unused entries first. |
| GitHub stars, Trending, GitHub forks, Latest GitHub push | By the plugin's repository; Trending is stars gained per month. |
| Installs, Newest installed | By the official directory's install count, or by install date. |

<p align="center"><img src=".docs/catalog-pane-detail.svg" alt="The catalog pane showing one mod" width="882"></p>

Pressing an entry opens its detail: usage over 7 and 30 days, token cost, version and install dates, what a mod hooks and calls, the repository and the full description. **Explain with Haiku** sums up in three sentences what the entry is for. The buttons depend on the kind: insert or run a skill or command, insert an agent, MCP server or tool into the prompt, update, disable or uninstall a plugin or mod, remove a local MCP server. Uninstalling and removing ask first.

### Options

| Option | Values | Default | Effect |
| --- | --- | --- | --- |
| `language` | any language name | `English` | The language **Explain with Haiku** answers in. |
| `githubStats` | `true`, `false` | `true` | Fetches the GitHub stats of each plugin's repository once a day. |

```
'{"language":"German"}' | claude plugin configure catalog-pane@T-AI-Labs --values-stdin
```

Set them as for [context-usage](#options).

### Network and model requests

- **GitHub:** once a day, the public API for each plugin repository's stars, forks, open issues and last push. Off with `githubStats`.
- **Haiku:** one request of at most 400 output tokens per **Explain with Haiku**. The answer is kept, so each entry is explained once.
- **Claude Code CLI:** `claude plugin details` once per plugin version for its token cost, `claude plugin validate` once per mod version, and `update`, `disable`, `enable` or `uninstall` when you press those buttons.

Everything else comes from Claude Code and the configuration files, and is kept in the mod's own store.

## License

[MIT](LICENSE)
