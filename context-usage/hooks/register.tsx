import { atom, read, update } from 'claude-code'
import type {
  Color,
  Elements,
  EngineInterface,
  Register,
  SessionContextUsage,
} from 'claude-code'

import type { ContextFill, Reading, UsageWindow } from '../types'

const OFF = 0
const STEPS = [OFF, 97, 90, 70, 60, 50]
const stepLabel = (step: number) => (step === OFF ? 'Off' : `${step}%`)
const OPTIONS = STEPS.map(step => ({ value: String(step), label: stepLabel(step) }))
const DEFAULT_THRESHOLD = 97
const THRESHOLD_KEY = 'threshold'
const READING_KEY = 'reading'

const LABELS: Record<string, string> = {
  // Padded so the hours line up with a two-digit window such as 24h.
  five_hour: ' 5h',
  seven_day: 'Week',
  spend_limit: 'Spend',
}
const ORDER = ['five_hour', 'seven_day', 'spend_limit']
const ALWAYS = ['five_hour', 'seven_day']
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

// Shared with cache-meter, context-meter and usage-limits so the gauges of all rows line up.
const LABEL_WIDTH = 7
const SEGMENTS = 5
const PERCENT_WIDTH = 4
const DETAIL_WIDTH = 10

type Tags = Pick<Elements['terminal'], 'Box' | 'Text'>
type Layout = { hasGauge: boolean; hasDetails: boolean; isUsageAbove: boolean }

const DESKTOP_BUTTON_ROWS = 2

type Cell = {
  label: string
  percent: number | null
  tone: Color | undefined
  detail: string
}

const context = atom({ plugin: 'context-usage', key: 'context' } as const, null)
const threshold = atom(
  { plugin: 'context-usage', key: 'threshold' } as const,
  DEFAULT_THRESHOLD,
)
const windows = atom({ plugin: 'context-usage', key: 'windows' } as const, [])
const now = atom({ plugin: 'context-usage', key: 'now' } as const, 0)

const toFill = (live: SessionContextUsage): ContextFill | null =>
  live.percent === undefined || live.tokens === undefined
    ? null
    : { percent: live.percent, tokens: live.tokens, window: live.window }

const tokens = (count: number) => {
  const thousands = Math.round(count / 1000)

  if (count < 1000) {
    return String(count)
  }

  return thousands < 1000
    ? `${thousands}k`
    : `${Number((count / 1_000_000).toFixed(1))}M`
}

const contextTone = (percent: number, threshold: number): Color | undefined => {
  const limit = threshold === OFF ? 100 : threshold

  return percent >= limit ? 'error' : percent >= limit - 15 ? 'warning' : undefined
}

const usageTone = (percent: number): Color | undefined =>
  percent >= 90 ? 'error' : percent >= 75 ? 'warning' : undefined

const labelOf = (kind: string) => LABELS[kind] ?? kind.replaceAll('_', ' ')

const rankOf = (kind: string) => {
  const rank = ORDER.indexOf(kind)

  return rank === -1 ? ORDER.length : rank
}

const span = (duration: number) => {
  const days = Math.floor(duration / DAY)
  const hours = Math.floor((duration % DAY) / HOUR)
  const minutes = Math.max(1, Math.floor((duration % HOUR) / MINUTE))

  if (days > 0) {
    return `${days}d ${hours}h`
  }

  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`
}

const untilReset = (resetsAt: string | undefined, at: number) => {
  const left = resetsAt === undefined ? Number.NaN : Date.parse(resetsAt) - at

  return Number.isNaN(left) ? '' : `(${span(left)})`
}

const hasReset = (one: UsageWindow, at: number) =>
  one.resetsAt !== undefined && Date.parse(one.resetsAt) <= at

const cellsOf = (list: readonly UsageWindow[], at: number): Cell[] =>
  [...new Set([...ALWAYS, ...list.map(one => one.kind)])]
    .sort((a, b) => rankOf(a) - rankOf(b))
    .map(kind => {
      const one = list.find(held => held.kind === kind)

      if (one === undefined) {
        return { label: labelOf(kind), percent: null, tone: undefined, detail: '' }
      }

      // A window past its reset has started over, but the engine reports that only with the next response.
      if (hasReset(one, at)) {
        return { label: labelOf(kind), percent: 0, tone: undefined, detail: '' }
      }

      return {
        label: labelOf(kind),
        percent: one.percentUsed,
        tone: usageTone(one.percentUsed),
        detail: untilReset(one.resetsAt, at),
      }
    })

const meter = ({ Box, Text }: Tags, layout: Layout, one: Cell) => {
  const filled =
    one.percent === null
      ? 0
      : Math.max(
          0,
          Math.min(SEGMENTS, Math.round((one.percent / 100) * SEGMENTS)),
        )

  return (
    <Box flexDirection="row" flexShrink={0}>
      <Box minWidth={LABEL_WIDTH} marginRight={1} flexShrink={0}>
        <Text dimColor>{one.label}</Text>
      </Box>
      {layout.hasGauge && (
        <Box minWidth={SEGMENTS} marginRight={1} flexShrink={0}>
          <Text color={one.tone}>{'▮'.repeat(filled)}</Text>
          <Text dimColor>{'▯'.repeat(SEGMENTS - filled)}</Text>
        </Box>
      )}
      <Box
        minWidth={PERCENT_WIDTH}
        marginRight={1}
        flexShrink={0}
        justifyContent="flex-end"
      >
        <Text color={one.percent === null ? 'inactive' : one.tone}>
          {one.percent === null ? '–' : `${Math.round(one.percent)}%`}
        </Text>
      </Box>
      {layout.hasDetails && (
        <Box minWidth={DETAIL_WIDTH} marginRight={1} flexShrink={0}>
          <Text dimColor>{one.detail}</Text>
        </Box>
      )}
    </Box>
  )
}

const runCommand = ($: EngineInterface, command: string) => {
  $.command
    .run({ command })
    .catch(() => $.ui.toast(`context-usage: /${command} could not run`))
}

const cycleThreshold = async ($: EngineInterface) => {
  const value = await update(
    $,
    threshold,
    held => STEPS[(STEPS.indexOf(held) + 1) % STEPS.length] ?? DEFAULT_THRESHOLD,
  )
  await $.store.set(THRESHOLD_KEY, value)
}

const setThreshold = async ($: EngineInterface, value: number) => {
  if (STEPS.includes(value)) {
    await update($, threshold, () => value)
    await $.store.set(THRESHOLD_KEY, value)
  }
}

const restoreContext = async ($: EngineInterface) => {
  const stored = await $.store.get(THRESHOLD_KEY)

  if (typeof stored === 'number' && STEPS.includes(stored)) {
    await update($, threshold, () => stored)
  }

  // The engine has no reading before the first response of a session, so an empty one counts as nothing sent yet.
  const usage = await $.session.usage()
  await update(
    $,
    context,
    () => toFill(usage.context) ?? { percent: 0, tokens: 0, window: usage.context.window },
  )
}

const restoreUsage = async ($: EngineInterface) => {
  const at = await $.clock.now()
  const stored = (await $.store.get(READING_KEY)) as Reading | undefined
  await update($, now, () => at)

  if (stored !== undefined) {
    await update($, windows, () => stored.windows)
  }
}

// The next window starts no earlier than this one resets, so it resets at least a whole window later.
const SAME_WINDOW = HOUR

const newer = (first: UsageWindow, second: UsageWindow) => {
  const gap = Date.parse(first.resetsAt ?? '') - Date.parse(second.resetsAt ?? '')

  // Without a reset time there is no telling which is newer, so the session's own reading stays.
  if (Number.isNaN(gap)) {
    return first
  }

  if (Math.abs(gap) > SAME_WINDOW) {
    return gap > 0 ? first : second
  }

  return second.percentUsed > first.percentUsed ? second : first
}

// Every session writes the same store, so the readings of all of them meet there.
const merge = (...lists: (readonly UsageWindow[])[]) => {
  const byKind = new Map<string, UsageWindow>()

  for (const one of lists.flat()) {
    const held = byKind.get(one.kind)
    byKind.set(one.kind, held === undefined ? one : newer(held, one))
  }

  return [...byKind.values()].sort((a, b) => rankOf(a.kind) - rankOf(b.kind))
}

const refreshUsage = async ($: EngineInterface, list?: readonly UsageWindow[]) => {
  // The engine has no reading before the first response of a session.
  if (list !== undefined && list.length === 0) {
    return restoreUsage($)
  }

  const at = await $.clock.now()
  const stored = (await $.store.get(READING_KEY)) as Reading | undefined
  await update($, now, () => at)

  // Without a measurement this only takes in what other sessions stored since.
  if (list === undefined) {
    await update($, windows, held => merge(held, stored?.windows ?? []))

    return
  }

  // A measurement can leave a window out, which then keeps its last reading.
  const merged = merge(list, stored?.windows ?? [])
  await update($, windows, () => merged)
  await $.store.set(READING_KEY, { windows: merged })
}

export const register: Register = (on, options) => {
  const layout: Layout = {
    hasGauge: options.display !== 'text',
    hasDetails: options.details !== false,
    isUsageAbove: options.usagePosition === 'above',
  }
  // Re-armed only once the fill drops below the threshold, so a compaction that lands above it does not loop.
  let isArmed = true

  on('session.start', async ($, e, next) => {
    await restoreContext($)
    const usage = await $.session.usage()
    await refreshUsage($, usage.rateLimits)

    $.clock.every(MINUTE, () => void refreshUsage($))

    return next(e)
  })

  // A /clear wipes every plugin's state after session.end and raises no session.start, only this.
  on('classic.SessionStart', async ($, e, next) => {
    if (e.source === 'clear') {
      await restoreContext($).catch(() => undefined)
      await restoreUsage($).catch(() => undefined)
    }

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      isArmed = true
      await update($, context, () => null)
    }

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await refreshUsage($, e.rateLimits)

    if (e.changed.includes('context')) {
      const fill = toFill(e.context)
      const limit = await read($, threshold)
      await update($, context, () => fill)

      if (fill !== null && (limit === OFF || fill.percent < limit)) {
        isArmed = true
      } else if (fill !== null && isArmed) {
        isArmed = false
        // A compaction is refused while the turn that raised this measurement still runs.
        $.clock.after(250, () => runCommand($, 'compact'))
      }
    }

    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    const compacted = await next(e)
    const isLive = e.agentId === undefined && e.trigger !== 'precompute'

    if (isLive && compacted.skip === undefined) {
      const after = compacted.tokensAfter
      await update($, context, held =>
        held === null || after === undefined
          ? null
          : {
              tokens: after,
              window: held.window,
              percent: Math.round((after / held.window) * 100),
            },
      )
    }

    return compacted
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)

    if (e.props.hasSurvey) {
      return below
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    const fill = await read($, context)
    const limit = await read($, threshold)
    const list = await read($, windows)
    const at = await read($, now)
    let picker

    // The mobile surface draws no Select.
    if (e.surface === 'mobile') {
      picker = (
        <Button
          key="threshold"
          label={`Auto ${stepLabel(limit)}`}
          onPress={() => void cycleThreshold($)}
        />
      )
    } else {
      const { Select } = $.ui.resolve(e)
      picker = (
        <Select
          key="threshold"
          label="Auto"
          options={OPTIONS}
          value={String(limit)}
          onSelect={value => void setThreshold($, Number(value))}
        />
      )
    }

    const contextRow = (
      <Box
        key="context"
        flexDirection="row"
        flexWrap="wrap"
        alignItems="center"
        // The desktop's native Button is taller than one text row and spills onto the row below.
        minHeight={e.surface === 'desktop' ? DESKTOP_BUTTON_ROWS : undefined}
      >
        {meter({ Box, Text }, layout, {
          label: 'Context',
          percent: fill === null ? null : fill.percent,
          tone: contextTone(fill === null ? 0 : fill.percent, limit),
          detail: fill === null ? '' : `(${tokens(fill.tokens)}/${tokens(fill.window)})`,
        })}
        <Box flexDirection="row" gap={1} flexShrink={0}>
          {picker}
          <Button key="compact" label="Compact" onPress={() => runCommand($, 'compact')} />
          <Button key="clear" label="Clear" onPress={() => runCommand($, 'clear')} />
        </Box>
      </Box>
    )
    const usageRow = (
      <Box key="usage" flexDirection="row" flexWrap="wrap">
        {cellsOf(list, at).map(one => meter({ Box, Text }, layout, one))}
      </Box>
    )

    return (
      <Box flexDirection="column">
        {layout.isUsageAbove ? [usageRow, contextRow] : [contextRow, usageRow]}
        {below}
      </Box>
    )
  })
}
