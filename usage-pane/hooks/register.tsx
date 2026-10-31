import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, ModelUsage, Register, SessionRateLimit } from 'claude-code'

import type {
  Bucket,
  LimitWindow,
  Limits,
  Period,
  PromptRecord,
  Report,
  SessionRecord,
  SessionSummary,
  Slice,
  Tokens,
  View,
} from '../types'

const PANE = 'usage'
const COMMAND = 'tokens'
const SESSION_PREFIX = 'session:'
const LIMITS_KEY = 'limits'
const PRUNED_KEY = 'prunedAt'
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const KEEP_DAYS = 31
const KEEP_WINDOWS = 8
const UNKNOWN = 'unknown'

// The store holds 4 MiB in all, so prompt details are kept for the last week only.
const KEEP_PROMPTS = 30
const KEEP_PROMPT_DAYS = 7
const TEXT_LENGTH = 120
const LIST_SESSIONS = 25
const LIST_PROMPTS = 15
const LIST_TOOLS = 4
const MAX_TIPS = 3

// A window's reset time drifts by seconds between readings; the next window resets at least an hour later.
const SAME_WINDOW = HOUR

// Claude's API prices keep these ratios to the input price on every model.
const WEIGHTS: Tokens = { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 }

const CHARS_PER_TOKEN = 4

const LABEL_WIDTH = 20
const VALUE_WIDTH = 9

const PERIODS: { period: Period; label: string }[] = [
  { period: 'turn', label: 'Last turn' },
  { period: 'session', label: 'Session' },
  { period: 'today', label: 'Today' },
  { period: 'week', label: '7 days' },
  { period: 'month', label: '30 days' },
]

const VIEWS: { period: View; label: string }[] = [
  ...PERIODS,
  { period: 'sessions', label: 'Sessions' },
  { period: 'prompts', label: 'Prompts' },
]

const LIMIT_LABELS: Record<string, string> = {
  five_hour: '5-hour',
  seven_day: 'Weekly',
  spend_limit: 'Spend',
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite', 'turns', 'tools', 'ms', 'usd'] as const

type Tags = Pick<Elements['terminal'], 'Box' | 'Text'>

const report = atom({ plugin: 'usage-pane', key: 'report' } as const, null, { shape: 'report-2' })
const period = atom({ plugin: 'usage-pane', key: 'period' } as const, 'week')
const isLoading = atom({ plugin: 'usage-pane', key: 'isLoading' } as const, false)
const sessionId = atom({ plugin: 'usage-pane', key: 'sessionId' } as const, null)
const promptAt = atom({ plugin: 'usage-pane', key: 'promptAt' } as const, null)

const empty = (): Bucket => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  turns: 0,
  tools: 0,
  ms: 0,
  usd: 0,
})

const noTokens = (): Tokens => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })

const add = (into: Bucket, part: Partial<Bucket>): Bucket => {
  const sum = empty()

  for (const field of FIELDS) {
    sum[field] = into[field] + (part[field] ?? 0)
  }

  return sum
}

const tokensOf = (usage: ModelUsage): Tokens => ({
  input: usage.input_tokens,
  output: usage.output_tokens,
  cacheRead: usage.cache_read_input_tokens,
  cacheWrite: usage.cache_creation_input_tokens,
})

const addTokens = (a: Tokens, b: Tokens): Tokens => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
})

const totalOf = (one: Tokens) => one.input + one.output + one.cacheRead + one.cacheWrite

const weightOf = (one: Tokens) =>
  one.input * WEIGHTS.input +
  one.output * WEIGHTS.output +
  one.cacheRead * WEIGHTS.cacheRead +
  one.cacheWrite * WEIGHTS.cacheWrite

const hitRateOf = (one: Tokens) => {
  const prompt = one.input + one.cacheRead + one.cacheWrite

  return prompt === 0 ? null : one.cacheRead / prompt
}

const pad = (value: number) => String(value).padStart(2, '0')

const dayOf = (at: number) => {
  const date = new Date(at)

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

const daysBack = (at: number, count: number) => {
  const date = new Date(at)

  return Array.from({ length: count }, (_, back) =>
    dayOf(new Date(date.getFullYear(), date.getMonth(), date.getDate() - back, 12).getTime()),
  )
}

const projectOf = (root: string) => root.split(/[\\/]/).filter(Boolean).at(-1) ?? root

const oneLine = (text: string) => {
  const flat = text.replace(/\s+/g, ' ').trim()

  return flat.length > TEXT_LENGTH ? `${flat.slice(0, TEXT_LENGTH - 1)}…` : flat
}

const bump = (held: SessionRecord, day: string, model: string, part: Partial<Bucket>): SessionRecord => {
  const models = held.days[day] ?? {}

  return {
    ...held,
    days: { ...held.days, [day]: { ...models, [model]: add(models[model] ?? empty(), part) } },
  }
}

// Parallel tool calls of one session would otherwise read the same record and drop each other's counts.
let pending = Promise.resolve()

const serial = (work: () => Promise<void>) => {
  pending = pending.then(work).catch(() => undefined)

  return pending
}

const edit = ($: EngineInterface, change: (held: SessionRecord, at: number) => SessionRecord) =>
  serial(async () => {
    const at = await $.clock.now()
    const key = SESSION_PREFIX + (await $.session.id())
    const held = (await $.store.get(key)) as SessionRecord | undefined
    const base: SessionRecord = held ?? {
      project: projectOf(await $.session.root()),
      lastAt: at,
      usdSeen: 0,
      model: UNKNOWN,
      days: {},
    }

    await $.store.set(key, change({ ...base, lastAt: at }, at))
  })

type Running = PromptRecord & { usdAtStart: number }

// The prompt the main loop is working on; a reload mid-turn loses it and that prompt goes unrecorded.
let running: Running | null = null

const noteStep = (agentId: string | undefined, usage: ModelUsage | null) => {
  if (running === null || usage === null || agentId !== undefined) {
    return
  }

  const step = tokensOf(usage)
  running.steps += 1
  running.peakContext = Math.max(running.peakContext, step.input + step.cacheRead + step.cacheWrite)

  if (running.steps === 1) {
    running.firstWrite = step.cacheWrite
  }
}

const noteTool = (tool: string, chars: number) => {
  if (running === null) {
    return
  }

  const held = running.tools[tool] ?? { calls: 0, chars: 0 }
  running.tools[tool] = { calls: held.calls + 1, chars: held.chars + chars }
}

const sameWindow = (one: LimitWindow, resetsAt: string) =>
  Math.abs(Date.parse(one.resetsAt) - Date.parse(resetsAt)) <= SAME_WINDOW

const noteLimits = ($: EngineInterface, readings: readonly SessionRateLimit[]) =>
  serial(async () => {
    const at = await $.clock.now()
    const held = ((await $.store.get(LIMITS_KEY)) as Limits | undefined) ?? {}
    const merged: Limits = { ...held }

    for (const { kind, percentUsed, resetsAt } of readings) {
      if (resetsAt === undefined) {
        continue
      }

      const windows = merged[kind] ?? []
      const same = windows.find(one => sameWindow(one, resetsAt))
      const next =
        same === undefined
          ? [...windows, { resetsAt, peak: percentUsed, lastAt: at }]
          : windows.map(one =>
              one === same ? { ...one, peak: Math.max(one.peak, percentUsed), lastAt: at } : one,
            )

      merged[kind] = next
        .sort((a, b) => Date.parse(b.resetsAt) - Date.parse(a.resetsAt))
        .slice(0, KEEP_WINDOWS)
    }

    await $.store.set(LIMITS_KEY, merged)
  })

const prune = async ($: EngineInterface) => {
  const at = await $.clock.now()
  const last = (await $.store.get(PRUNED_KEY)) as number | undefined

  if (last !== undefined && at - last < DAY) {
    return
  }

  await $.store.set(PRUNED_KEY, at)

  for (const key of await $.store.keys()) {
    if (!key.startsWith(SESSION_PREFIX)) {
      continue
    }

    const held = (await $.store.get(key)) as SessionRecord | undefined

    if (held === undefined || held.lastAt < at - KEEP_DAYS * DAY) {
      await $.store.delete(key)
    } else if (held.prompts !== undefined && held.lastAt < at - KEEP_PROMPT_DAYS * DAY) {
      const { prompts: _, ...rest } = held
      await $.store.set(key, rest)
    }
  }
}

const blank = (): Slice => ({ total: empty(), models: {}, projects: {} })

const fold = (slice: Slice, model: string, project: string, part: Partial<Bucket>) => {
  slice.total = add(slice.total, part)
  slice.models[model] = add(slice.models[model] ?? empty(), part)
  slice.projects[project] = add(slice.projects[project] ?? empty(), part)
}

const build = async ($: EngineInterface): Promise<Report> => {
  await pending

  const at = await $.clock.now()
  const ownId = await $.session.id()
  const own = SESSION_PREFIX + ownId
  const today = dayOf(at)
  const week = new Set(daysBack(at, 7))
  const month = new Set(daysBack(at, 30))
  const periods: Record<Period, Slice> = {
    turn: blank(),
    session: blank(),
    today: blank(),
    week: blank(),
    month: blank(),
  }
  const sessions: SessionSummary[] = []
  let hasCost = false

  for (const key of await $.store.keys()) {
    if (!key.startsWith(SESSION_PREFIX)) {
      continue
    }

    const held = (await $.store.get(key)) as SessionRecord | undefined

    if (held === undefined) {
      continue
    }

    hasCost ||= held.usdSeen > 0
    let spent = empty()

    for (const [day, models] of Object.entries(held.days)) {
      const targets: Period[] = [
        ...(key === own ? (['session'] as const) : []),
        ...(day === today ? (['today'] as const) : []),
        ...(week.has(day) ? (['week'] as const) : []),
        ...(month.has(day) ? (['month'] as const) : []),
      ]

      for (const [model, bucket] of Object.entries(models)) {
        spent = add(spent, bucket)

        for (const target of targets) {
          fold(periods[target], model, held.project, bucket)
        }
      }
    }

    if (key === own && held.lastTurn !== undefined) {
      const { model, at: _, ...turn } = held.lastTurn
      fold(periods.turn, model, held.project, { ...turn, turns: 1 })
    }

    const prompts = held.prompts ?? []

    if (totalOf(spent) > 0 || prompts.length > 0) {
      sessions.push({
        id: key.slice(SESSION_PREFIX.length),
        project: held.project,
        title: held.title ?? prompts.find(one => one.text !== '')?.text ?? held.project,
        lastAt: held.lastAt,
        usd: spent.usd,
        tokens: totalOf(spent),
        prompts,
      })
    }
  }

  const stored = ((await $.store.get(LIMITS_KEY)) as Limits | undefined) ?? {}
  const limits = Object.fromEntries(
    Object.entries(stored).map(([kind, windows]) => [
      kind,
      windows.filter(one => Date.parse(one.resetsAt) > at - 8 * DAY),
    ]),
  )

  sessions.sort((a, b) => b.lastAt - a.lastAt)

  return { builtAt: at, periods, limits, hasCost, ownId, sessions: sessions.slice(0, LIST_SESSIONS) }
}

const refresh = async ($: EngineInterface) => {
  await update($, isLoading, () => true)

  try {
    const built = await build($)
    await update($, report, () => built)
  } finally {
    await update($, isLoading, () => false)
  }
}

const tokens = (count: number) =>
  count >= 1e9
    ? `${(count / 1e9).toFixed(1)}B`
    : count >= 1e6
      ? `${(count / 1e6).toFixed(1)}M`
      : count >= 1e3
        ? `${Math.round(count / 1e3)}k`
        : String(Math.round(count))

const dollars = (usd: number) => (usd >= 100 ? `$${Math.round(usd)}` : `$${usd.toFixed(2)}`)

const percent = (share: number | null) => (share === null ? '–' : `${Math.round(share * 100)}%`)

const duration = (ms: number) => {
  const minutes = Math.round(ms / MINUTE)

  if (minutes < 1) {
    return `${Math.round(ms / 1000)}s`
  }

  if (minutes >= 24 * 60) {
    return `${Math.floor(minutes / (24 * 60))}d ${Math.floor((minutes % (24 * 60)) / 60)}h`
  }

  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`
}

const stamp = (value: string | number) => {
  const date = new Date(value)

  return `${MONTHS[date.getMonth()]} ${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

const row = ({ Box, Text }: Tags, key: string, label: string, value: string, detail = '') => (
  <Box key={key} flexDirection="row">
    <Box minWidth={LABEL_WIDTH} width={LABEL_WIDTH} marginRight={1} flexShrink={0}>
      <Text dimColor wrap="truncate-end">
        {label}
      </Text>
    </Box>
    <Box minWidth={VALUE_WIDTH} marginRight={1} flexShrink={0} justifyContent="flex-end">
      <Text>{value}</Text>
    </Box>
    <Text dimColor wrap="truncate-end">
      {detail}
    </Text>
  </Box>
)

const costText = (bucket: Bucket, hasCost: boolean) => (hasCost ? dollars(bucket.usd) : '–')

const breakdown = (tags: Tags, title: string, prefix: string, list: Record<string, Bucket>, hasCost: boolean) => {
  const { Box, Text } = tags
  // Tool calls made before a session's first answer have no model yet and no tokens to show here.
  const sorted = Object.entries(list)
    .filter(([, bucket]) => totalOf(bucket) > 0 || bucket.usd > 0)
    .sort(([, a], [, b]) => totalOf(b) - totalOf(a))

  return (
    <Box flexDirection="column">
      <Text bold>{title}</Text>
      {sorted.map(([name, bucket]) =>
        row(
          tags,
          `${prefix}-${name}`,
          name,
          tokens(totalOf(bucket)),
          [hasCost ? dollars(bucket.usd) : '', `${percent(hitRateOf(bucket))} cached`]
            .filter(Boolean)
            .join(' · '),
        ),
      )}
    </Box>
  )
}

const limitLines = (tags: Tags, limits: Limits, at: number) => {
  const { Box, Text } = tags
  const kinds = Object.entries(limits).filter(([, windows]) => windows.length > 0)

  if (kinds.length === 0) {
    return (
      <Box flexDirection="column">
        <Text bold>Limits</Text>
        <Text dimColor>No reading yet. Claude Code reports the limits on a subscription plan, with each response.</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <Text bold>Limits</Text>
      {kinds.flatMap(([kind, windows]) =>
        windows.map((one, index) => {
          const isCurrent = Date.parse(one.resetsAt) > at
          const label = index === 0 ? (LIMIT_LABELS[kind] ?? kind.replaceAll('_', ' ')) : ''

          return row(
            tags,
            `limit-${kind}-${one.resetsAt}`,
            label,
            `${Math.round(one.peak)}%`,
            isCurrent
              ? `now, resets ${stamp(one.resetsAt)} (in ${duration(Date.parse(one.resetsAt) - at)})`
              : `peak, reset ${stamp(one.resetsAt)}`,
          )
        }),
      )}
    </Box>
  )
}

const shares = (prompt: PromptRecord) => {
  const parts = [
    { label: 'Re-reading context', weight: prompt.cacheRead * WEIGHTS.cacheRead + prompt.input * WEIGHTS.input },
    { label: 'Writing the cache', weight: prompt.cacheWrite * WEIGHTS.cacheWrite },
    { label: 'Output', weight: prompt.output * WEIGHTS.output },
    { label: 'Subagents', weight: weightOf(prompt.agents) },
  ]
  const sum = parts.reduce((all, part) => all + part.weight, 0)

  return sum === 0 ? [] : parts.map(part => ({ ...part, share: part.weight / sum })).filter(part => part.share >= 0.01)
}

const tipsFor = (prompt: PromptRecord) => {
  const share = (label: string) => shares(prompt).find(part => part.label === label)?.share ?? 0
  const [tool, use] = Object.entries(prompt.tools).sort(([, a], [, b]) => b.chars - a.chars)[0] ?? []
  const tips: string[] = []

  if (prompt.peakContext >= 100_000) {
    tips.push(
      `The context reached ${tokens(prompt.peakContext)} tokens and each of the ${prompt.steps} model calls read it again. Start an unrelated task with /clear, or /compact first.`,
    )
  }

  if (prompt.steps >= 25) {
    tips.push(
      `${prompt.steps} model calls for one prompt. Naming the files, the expected result and when to stop saves rounds.`,
    )
  }

  if (prompt.firstWrite >= 50_000) {
    tips.push(
      `The prompt cache was cold: ${tokens(prompt.firstWrite)} tokens of context were written again. After a long break, /clear with a short summary costs less than picking up the old context.`,
    )
  }

  if (tool !== undefined && use !== undefined && use.chars >= 50_000) {
    tips.push(
      `${tool} returned about ${tokens(use.chars / CHARS_PER_TOKEN)} tokens over ${use.calls} calls, and every later call read them again. Point to the exact files or lines, or ask for filtered output.`,
    )
  }

  if (share('Subagents') >= 0.4) {
    tips.push(
      `Subagents took ${percent(share('Subagents'))} of the cost in ${prompt.agents.runs} runs. Check that each run was needed.`,
    )
  }

  if (share('Output') >= 0.4 && prompt.output >= 10_000) {
    tips.push(
      `${tokens(prompt.output)} output tokens, at five times the input price. Ask for the change alone, without long summaries or whole-file rewrites.`,
    )
  }

  if (prompt.isAborted) {
    tips.push('The prompt was interrupted, and what it had used is spent. A precise first prompt avoids a restart.')
  }

  return tips.slice(0, MAX_TIPS)
}

const promptPrice = (prompt: PromptRecord, hasCost: boolean) =>
  hasCost ? dollars(prompt.usd) : tokens(totalOf(prompt) + totalOf(prompt.agents))

const promptDetail = (tags: Tags, prompt: PromptRecord, hasCost: boolean) => {
  const { Box, Text } = tags
  const all = addTokens(prompt, prompt.agents)
  const tools = Object.entries(prompt.tools)
    .sort(([, a], [, b]) => b.chars - a.chars)
    .slice(0, LIST_TOOLS)
    .map(([name, use]) => `${name} ${use.calls}× ${tokens(use.chars / CHARS_PER_TOKEN)}`)
  const tips = tipsFor(prompt)

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <Text bold>{prompt.text === '' ? '(continued without a prompt)' : prompt.text}</Text>
        {row(tags, 'detail-price', 'API price', hasCost ? dollars(prompt.usd) : '–', `${stamp(prompt.at)} · ${prompt.model}`)}
        {row(
          tags,
          'detail-tokens',
          'Tokens',
          tokens(totalOf(all)),
          `input ${tokens(all.input)} · output ${tokens(all.output)} · cache read ${tokens(all.cacheRead)} · cache write ${tokens(all.cacheWrite)}`,
        )}
        {row(
          tags,
          'detail-steps',
          'Model calls',
          String(prompt.steps),
          `peak context ${tokens(prompt.peakContext)} · ${duration(prompt.ms)}`,
        )}
        {prompt.agents.runs > 0 &&
          row(tags, 'detail-agents', 'Subagent runs', String(prompt.agents.runs), `${tokens(totalOf(prompt.agents))} tokens`)}
        {tools.length > 0 && row(tags, 'detail-tools', 'Tool output', '', tools.join(' · '))}
      </Box>
      <Box flexDirection="column">
        <Text bold>Where the cost went</Text>
        {shares(prompt).map(part => row(tags, `share-${part.label}`, part.label, percent(part.share)))}
      </Box>
      <Box flexDirection="column">
        <Text bold>Next time</Text>
        {tips.length === 0 ? (
          <Text dimColor>Nothing stood out.</Text>
        ) : (
          tips.map((tip, index) => (
            <Text key={`tip-${index}`} wrap="wrap">
              {`• ${tip}`}
            </Text>
          ))
        )}
      </Box>
    </Box>
  )
}

const isView = (value: string): value is View => VIEWS.some(one => one.period === value)

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Show token usage, cache hit rate, API price and limit history in a pane',
      argumentHint: '[turn|session|today|week|month|sessions|prompts]',
    })
    void prune($).catch(() => undefined)

    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const word = (e.args ?? '').trim().toLowerCase()

    if (isView(word)) {
      await update($, period, () => word)
    }

    void refresh($)
    await $.ui.open({ id: PANE, title: 'Usage' })

    return { text: 'Opened the usage pane.' }
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      const usage = await $.session.usage()
      running = {
        ...noTokens(),
        at: await $.clock.now(),
        text: oneLine(e.text),
        model: UNKNOWN,
        ms: 0,
        usd: 0,
        steps: 0,
        peakContext: 0,
        firstWrite: 0,
        isAborted: false,
        agents: { ...noTokens(), runs: 0 },
        tools: {},
        usdAtStart: usage.cost?.usd ?? 0,
      }
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    const response = yield* next(e)
    noteStep(e.agentId, response.usage)

    return response
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    const usage = await $.session.usage()
    const counted = e.usage === undefined ? {} : tokensOf(e.usage)
    const isMain = e.agentId === undefined
    const total = usage.cost?.usd

    if (!isMain && running !== null && e.usage !== undefined) {
      running.agents = { ...addTokens(running.agents, tokensOf(e.usage)), runs: running.agents.runs + 1 }
    }

    const started = isMain ? running : null

    if (isMain) {
      running = null
    }

    await edit($, (held, at) => {
      const model = e.usage?.model ?? held.model
      // The ledger starts over on /clear, so a total below the last one is all new.
      const usd = total === undefined ? 0 : total < held.usdSeen ? total : total - held.usdSeen
      const part = { ...counted, turns: isMain ? 1 : 0, ms: isMain ? e.durationMs : 0, usd }
      const updated = bump({ ...held, model, usdSeen: total ?? held.usdSeen }, dayOf(at), model, part)
      const withTurn =
        isMain && e.usage !== undefined
          ? { ...updated, lastTurn: { ...tokensOf(e.usage), model, ms: e.durationMs, usd, at } }
          : updated

      if (started === null) {
        return withTurn
      }

      const { usdAtStart, ...base } = started
      const spent = total === undefined ? 0 : total < usdAtStart ? total : total - usdAtStart
      const prompt: PromptRecord = {
        ...base,
        ...(e.usage === undefined ? {} : tokensOf(e.usage)),
        model,
        ms: e.durationMs,
        usd: spent,
        isAborted: e.isAborted,
      }

      if (totalOf(prompt) + totalOf(prompt.agents) === 0 && spent === 0) {
        return withTurn
      }

      return {
        ...withTurn,
        title: withTurn.title ?? (prompt.text === '' ? undefined : prompt.text),
        prompts: [...(withTurn.prompts ?? []), prompt].slice(-KEEP_PROMPTS),
      }
    })

    if ((await read($, report)) !== null) {
      void refresh($)
    }

    return done
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    void edit($, (held, at) => bump(held, dayOf(at), held.model, { tools: 1 }))
    const result = await next(e)
    noteTool(e.tool, result.text?.length ?? 0)

    return result
  }).catch(($, e, next) => next(e))

  on('session.measure', ($, e, next) => {
    if (e.changed.includes('rateLimits') && e.rateLimits.length > 0) {
      void noteLimits($, e.rateLimits)
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const tags = $.ui.resolve(e)
    const { Box, Button, Text } = tags
    const held = await read($, report)
    const chosen = await read($, period)
    const loading = await read($, isLoading)

    const tabs = (
      <Box flexDirection="row" flexWrap="wrap" gap={1}>
        {VIEWS.map(({ period: one, label }) => (
          <Button
            key={`period-${one}`}
            label={label}
            variant={one === chosen ? 'primary' : 'secondary'}
            onPress={() => update($, period, () => one)}
          />
        ))}
        <Button key="refresh" label={loading ? 'Loading…' : 'Refresh'} plain onPress={() => refresh($)} />
      </Box>
    )

    if (held === null) {
      return (
        <Box flexDirection="column" gap={1}>
          {tabs}
          <Text dimColor>{loading ? 'Adding up…' : 'Nothing counted yet. Press Refresh.'}</Text>
        </Box>
      )
    }

    if (chosen === 'sessions') {
      return (
        <Box flexDirection="column" gap={1}>
          {tabs}
          <Box flexDirection="column">
            <Text bold>Sessions</Text>
            <Text dimColor>Newest first. Press one to see its prompts by cost.</Text>
          </Box>
          <Box flexDirection="column">
            {held.sessions.map(one => (
              <Button
                key={`session-${one.id}`}
                plain
                dimColor={one.id !== held.ownId}
                onPress={async () => {
                  await update($, sessionId, () => one.id)
                  await update($, promptAt, () => null)
                  await update($, period, () => 'prompts')
                }}
              >
                {`${held.hasCost ? dollars(one.usd) : tokens(one.tokens)}  ${stamp(one.lastAt)} · ${one.project} · ${one.prompts.length} prompts · ${one.title}`}
              </Button>
            ))}
          </Box>
        </Box>
      )
    }

    if (chosen === 'prompts') {
      const wanted = (await read($, sessionId)) ?? held.ownId
      const session = held.sessions.find(one => one.id === wanted)
      const prompts = [...(session?.prompts ?? [])].sort((a, b) => b.usd - a.usd || weightOf(b) - weightOf(a))

      if (session === undefined || prompts.length === 0) {
        return (
          <Box flexDirection="column" gap={1}>
            {tabs}
            <Text dimColor>
              No prompt recorded for this session yet. Prompts are recorded from the install of the mod on, and
              their details are kept for {KEEP_PROMPT_DAYS} days.
            </Text>
          </Box>
        )
      }

      const pickedAt = await read($, promptAt)
      const picked = prompts.find(one => one.at === pickedAt) ?? prompts[0]

      return (
        <Box flexDirection="column" gap={1}>
          {tabs}
          <Box flexDirection="column">
            <Text bold>{session.id === held.ownId ? 'This session' : session.title}</Text>
            <Text dimColor>{`${session.project} · ${prompts.length} prompts, most expensive first`}</Text>
          </Box>
          <Box flexDirection="column">
            {prompts.slice(0, LIST_PROMPTS).map(one => (
              <Button
                key={`prompt-${one.at}`}
                plain
                dimColor={one !== picked}
                onPress={() => update($, promptAt, () => one.at)}
              >
                {`${one === picked ? '▸' : ' '} ${promptPrice(one, held.hasCost)}  ${stamp(one.at)} · ${one.text === '' ? '(continued)' : one.text}`}
              </Button>
            ))}
          </Box>
          {picked !== undefined && promptDetail(tags, picked, held.hasCost)}
        </Box>
      )
    }

    const slice = held.periods[chosen]
    const { total } = slice

    if (total.turns === 0 && totalOf(total) === 0) {
      return (
        <Box flexDirection="column" gap={1}>
          {tabs}
          <Text dimColor>
            {chosen === 'turn' ? 'No turn yet in this session.' : 'Nothing counted in this period.'} Usage is
            counted from the install of the mod on.
          </Text>
          {limitLines(tags, held.limits, held.builtAt)}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        {tabs}
        <Box flexDirection="column">
          {row(
            tags,
            'tokens',
            'Tokens',
            tokens(totalOf(total)),
            `input ${tokens(total.input)} · output ${tokens(total.output)} · cache read ${tokens(total.cacheRead)} · cache write ${tokens(total.cacheWrite)}`,
          )}
          {row(tags, 'hit', 'Cache hit rate', percent(hitRateOf(total)), 'of the prompt read from the cache')}
          {row(
            tags,
            'price',
            'API price',
            costText(total, held.hasCost),
            held.hasCost ? 'what these requests cost at API prices' : 'Claude Code keeps no cost ledger here',
          )}
          {row(tags, 'turns', 'Turns', String(total.turns), `${duration(total.ms)} in all`)}
          {chosen !== 'turn' && row(tags, 'tools', 'Tool calls', String(total.tools))}
        </Box>
        {breakdown(tags, 'By model', 'model', slice.models, held.hasCost)}
        {chosen !== 'turn' && chosen !== 'session' && breakdown(tags, 'By project', 'project', slice.projects, held.hasCost)}
        {limitLines(tags, held.limits, held.builtAt)}
      </Box>
    )
  })
}
