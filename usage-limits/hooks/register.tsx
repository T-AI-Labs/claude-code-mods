import { atom, read, update } from 'claude-code'
import type { Color, Elements, EngineInterface, Register } from 'claude-code'

import type { Reading, UsageWindow } from '../types'

const LABELS: Record<string, string> = {
  five_hour: '5h',
  seven_day: 'Week',
  spend_limit: 'Spend',
}
const ORDER = ['five_hour', 'seven_day', 'spend_limit']
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const STORE_KEY = 'reading'

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
const staleSince = atom(
  { plugin: 'usage-limits', key: 'staleSince' } as const,
  null,
)

const labelOf = (kind: string) => LABELS[kind] ?? kind.replaceAll('_', ' ')

const rankOf = (kind: string) => {
  const rank = ORDER.indexOf(kind)

  return rank === -1 ? ORDER.length : rank
}

const toneOf = (percent: number): Color =>
  percent >= 90 ? 'error' : percent >= 75 ? 'warning' : 'text'

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

  if (Number.isNaN(left)) {
    return ''
  }

  return left <= 0 ? '(now)' : `(${span(left)})`
}

const isOpen = (one: UsageWindow, at: number) =>
  one.resetsAt === undefined || Date.parse(one.resetsAt) > at

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

const refresh = async ($: EngineInterface, list?: readonly UsageWindow[]) => {
  const at = await $.clock.now()
  await update($, now, () => at)

  if (list === undefined) {
    return
  }

  const sorted = [...list].sort((a, b) => rankOf(a.kind) - rankOf(b.kind))
  await update($, windows, () => sorted)
  await update($, staleSince, () => null)

  if (sorted.length > 0) {
    await $.store.set(STORE_KEY, { windows: sorted, at })
  }
}

const restore = async ($: EngineInterface) => {
  const at = await $.clock.now()
  const stored = (await $.store.get(STORE_KEY)) as Reading | undefined
  await update($, now, () => at)

  if (stored !== undefined) {
    await update($, windows, () => stored.windows.filter(one => isOpen(one, at)))
    await update($, staleSince, () => stored.at)
  }
}

export const register: Register = (on, options) => {
  const layout: Layout = {
    hasGauge: options.display !== 'text',
    hasDetails: options.details !== false,
  }

  on('session.start', async ($, e, next) => {
    const usage = await $.session.usage()

    // The engine has no reading before the first response of a session.
    if (usage.rateLimits.length > 0) {
      await refresh($, usage.rateLimits)
    } else {
      await restore($)
    }

    $.clock.every(MINUTE, () => void refresh($))

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await refresh($, e.rateLimits)

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)

    if (e.props.hasSurvey) {
      return below
    }

    const { Box, Text } = $.ui.resolve(e)
    const list = await read($, windows)
    const at = await read($, now)
    const since = await read($, staleSince)

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
                tone: toneOf(one.percentUsed),
                detail: untilReset(one.resetsAt, at),
              }),
            )}
            {since !== null && (
              <Text dimColor>{`as of ${span(at - since)} ago`}</Text>
            )}
          </Box>
        )}
        {below}
      </Box>
    )
  })
}
