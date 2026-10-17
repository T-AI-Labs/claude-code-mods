import { atom, read, update } from 'claude-code'
import type { Color, Elements, EngineInterface, Register } from 'claude-code'

import type { UsageWindow } from '../types'

const LABELS: Record<string, string> = {
  five_hour: '5h',
  seven_day: 'Week',
  spend_limit: 'Spend',
}
const ORDER = ['five_hour', 'seven_day', 'spend_limit']
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const STORE_KEY = 'windows'

// Shared with cache-meter so the columns of both rows line up.
const LABEL_WIDTHS = [5, 7]
const SEGMENTS = 5
const PERCENT_WIDTH = 4
const DETAIL_WIDTH = 10

type Tags = Pick<Elements['terminal'], 'Box' | 'Text'>
type Layout = { hasGauge: boolean; hasDetails: boolean }
type Cell = {
  label: string
  column: number
  percent: number | null
  tone: Color
  detail: string
}

const windows = atom({ plugin: 'usage-limits', key: 'windows' } as const, [])
const now = atom({ plugin: 'usage-limits', key: 'now' } as const, 0)

const labelOf = (kind: string) => LABELS[kind] ?? kind.replaceAll('_', ' ')

const rankOf = (kind: string) => {
  const rank = ORDER.indexOf(kind)

  return rank === -1 ? ORDER.length : rank
}

const toneOf = (one: UsageWindow): Color =>
  one.isStale
    ? 'inactive'
    : one.percentUsed >= 90
      ? 'error'
      : one.percentUsed >= 75
        ? 'warning'
        : 'text'

// A remembered reading says nothing once its window has reset.
const isCurrent = (one: UsageWindow, at: number) =>
  !one.isStale || one.resetsAt === undefined || Date.parse(one.resetsAt) > at

const merge = (
  fresh: readonly UsageWindow[],
  known: readonly UsageWindow[],
  at: number,
) =>
  [
    ...fresh,
    ...known
      .filter(one => !fresh.some(other => other.kind === one.kind))
      .map(one => ({ ...one, isStale: true }))
      .filter(one => isCurrent(one, at)),
  ].sort((a, b) => rankOf(a.kind) - rankOf(b.kind))

const untilReset = (resetsAt: string | undefined, at: number) => {
  const left = resetsAt === undefined ? Number.NaN : Date.parse(resetsAt) - at

  if (Number.isNaN(left)) {
    return ''
  }

  if (left <= 0) {
    return '(now)'
  }

  const days = Math.floor(left / DAY)
  const hours = Math.floor((left % DAY) / HOUR)
  const minutes = Math.max(1, Math.floor((left % HOUR) / MINUTE))

  if (days > 0) {
    return `(${days}d ${hours}h)`
  }

  return hours > 0 ? `(${hours}h ${minutes}m)` : `(${minutes}m)`
}

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
      <Box
        minWidth={LABEL_WIDTHS[one.column] ?? LABEL_WIDTHS[1]}
        marginRight={1}
        flexShrink={0}
      >
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

const tick = async ($: EngineInterface) => {
  const at = await $.clock.now()
  await update($, now, () => at)

  return at
}

const remember = async (
  $: EngineInterface,
  fresh: readonly UsageWindow[],
  known: readonly UsageWindow[],
  at: number,
) => {
  const merged = merge(fresh, known, at)
  await update($, windows, () => merged)

  if (fresh.length > 0) {
    await $.store.set(
      STORE_KEY,
      merged.map(({ kind, percentUsed, resetsAt }) => ({
        kind,
        percentUsed,
        resetsAt,
      })),
    )
  }
}

export const register: Register = (on, options) => {
  const layout: Layout = {
    hasGauge: options.display !== 'text',
    hasDetails: options.details !== false,
  }

  on('session.start', async ($, e, next) => {
    const at = await tick($)
    const usage = await $.session.usage()
    const stored = await $.store.get(STORE_KEY)
    await remember(
      $,
      usage.rateLimits,
      Array.isArray(stored) ? (stored as UsageWindow[]) : [],
      at,
    )
    $.clock.every(MINUTE, () => void tick($))

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const at = await tick($)

    if (e.changed.includes('rateLimits')) {
      await remember($, e.rateLimits, await read($, windows), at)
    }

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)

    if (e.props.hasSurvey) {
      return below
    }

    const { Box, Text } = $.ui.resolve(e)
    const at = await read($, now)
    const list = (await read($, windows)).filter(one => isCurrent(one, at))

    return (
      <Box flexDirection="column">
        {list.length === 0 ? (
          <Text dimColor>Usage limits: no reading yet</Text>
        ) : (
          <Box flexDirection="row" flexWrap="wrap">
            {list.map((one, column) =>
              meter({ Box, Text }, layout, {
                label: labelOf(one.kind),
                column,
                percent: one.percentUsed,
                tone: toneOf(one),
                detail: untilReset(one.resetsAt, at),
              }),
            )}
          </Box>
        )}
        {below}
      </Box>
    )
  })
}
