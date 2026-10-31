import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, ModelUsage, Register, SessionRateLimit } from 'claude-code'

import type {
  Bucket,
  LimitWindow,
  Limits,
  Period,
  Report,
  SessionRecord,
  Slice,
  Tokens,
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

// A window's reset time drifts by seconds between readings; the next window resets at least an hour later.
const SAME_WINDOW = HOUR

const LABEL_WIDTH = 20
const VALUE_WIDTH = 9

const PERIODS: { period: Period; label: string }[] = [
  { period: 'turn', label: 'Last turn' },
  { period: 'session', label: 'Session' },
  { period: 'today', label: 'Today' },
  { period: 'week', label: '7 days' },
  { period: 'month', label: '30 days' },
]

const LIMIT_LABELS: Record<string, string> = {
  five_hour: '5-hour',
  seven_day: 'Weekly',
  spend_limit: 'Spend',
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite', 'turns', 'tools', 'ms', 'usd'] as const

type Tags = Pick<Elements['terminal'], 'Box' | 'Text'>

const report = atom({ plugin: 'usage-pane', key: 'report' } as const, null, { shape: 'report-1' })
const period = atom({ plugin: 'usage-pane', key: 'period' } as const, 'week')
const isLoading = atom({ plugin: 'usage-pane', key: 'isLoading' } as const, false)

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

const totalOf = (one: Tokens) => one.input + one.output + one.cacheRead + one.cacheWrite

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
  const own = SESSION_PREFIX + (await $.session.id())
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

    for (const [day, models] of Object.entries(held.days)) {
      const targets: Period[] = [
        ...(key === own ? (['session'] as const) : []),
        ...(day === today ? (['today'] as const) : []),
        ...(week.has(day) ? (['week'] as const) : []),
        ...(month.has(day) ? (['month'] as const) : []),
      ]

      for (const [model, bucket] of Object.entries(models)) {
        for (const target of targets) {
          fold(periods[target], model, held.project, bucket)
        }
      }
    }

    if (key === own && held.lastTurn !== undefined) {
      const { model, at: _, ...turn } = held.lastTurn
      fold(periods.turn, model, held.project, { ...turn, turns: 1 })
    }
  }

  const stored = ((await $.store.get(LIMITS_KEY)) as Limits | undefined) ?? {}
  const limits = Object.fromEntries(
    Object.entries(stored).map(([kind, windows]) => [
      kind,
      windows.filter(one => Date.parse(one.resetsAt) > at - 8 * DAY),
    ]),
  )

  return { builtAt: at, periods, limits, hasCost }
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
        : String(count)

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

const stamp = (value: string) => {
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
      <Text tabular>{value}</Text>
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

const isPeriod = (value: string): value is Period => PERIODS.some(one => one.period === value)

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Show token usage, cache hit rate, API price and limit history in a pane',
      argumentHint: '[turn|session|today|week|month]',
    })
    void prune($).catch(() => undefined)

    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const word = (e.args ?? '').trim().toLowerCase()

    if (isPeriod(word)) {
      await update($, period, () => word)
    }

    void refresh($)
    await $.ui.open({ id: PANE, title: 'Usage' })

    return { text: 'Opened the usage pane.' }
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    const usage = await $.session.usage()
    const counted = e.usage === undefined ? {} : tokensOf(e.usage)
    const isMain = e.agentId === undefined

    await edit($, (held, at) => {
      const model = e.usage?.model ?? held.model
      const total = usage.cost?.usd
      // The ledger starts over on /clear, so a total below the last one is all new.
      const usd = total === undefined ? 0 : total < held.usdSeen ? total : total - held.usdSeen
      const part = { ...counted, turns: isMain ? 1 : 0, ms: isMain ? e.durationMs : 0, usd }
      const updated = bump({ ...held, model, usdSeen: total ?? held.usdSeen }, dayOf(at), model, part)

      return isMain && e.usage !== undefined
        ? { ...updated, lastTurn: { ...tokensOf(e.usage), model, ms: e.durationMs, usd, at } }
        : updated
    })

    if ((await read($, report)) !== null) {
      void refresh($)
    }

    return done
  }).catch(($, e, next) => next(e))

  on('tool.call', ($, e, next) => {
    void edit($, (held, at) => bump(held, dayOf(at), held.model, { tools: 1 }))

    return next(e)
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
        {PERIODS.map(({ period: one, label }) => (
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
