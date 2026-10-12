import { atom, read, update } from 'claude-code'
import type { Color, EngineInterface, Register } from 'claude-code'

import type { UsageWindow } from '../types'

const LABELS: Record<string, string> = {
  five_hour: '5h limit',
  seven_day: 'Weekly limit',
  spend_limit: 'Spend limit',
}
const ORDER = ['five_hour', 'seven_day', 'spend_limit']
const MAX_BAR = 12
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const windows = atom({ plugin: 'usage-limits', key: 'windows' } as const, [])
const now = atom({ plugin: 'usage-limits', key: 'now' } as const, 0)

const labelOf = (kind: string) => LABELS[kind] ?? kind.replaceAll('_', ' ')

const rankOf = (kind: string) => {
  const rank = ORDER.indexOf(kind)

  return rank === -1 ? ORDER.length : rank
}

const colorOf = (percent: number): Color =>
  percent >= 85 ? 'error' : percent >= 60 ? 'warning' : 'success'

const untilReset = (resetsAt: string, at: number) => {
  const left = Date.parse(resetsAt) - at

  if (Number.isNaN(left)) {
    return undefined
  }

  if (left <= 0) {
    return 'resetting now'
  }

  const days = Math.floor(left / DAY)
  const hours = Math.floor((left % DAY) / HOUR)
  const minutes = Math.max(1, Math.floor((left % HOUR) / MINUTE))

  if (days > 0) {
    return `resets in ${days}d ${hours}h`
  }

  return hours > 0
    ? `resets in ${hours}h ${minutes}m`
    : `resets in ${minutes}m`
}

const refresh = async ($: EngineInterface, list?: readonly UsageWindow[]) => {
  const at = await $.clock.now()
  await update($, now, () => at)

  if (list !== undefined) {
    const sorted = [...list].sort((a, b) => rankOf(a.kind) - rankOf(b.kind))
    await update($, windows, () => sorted)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const usage = await $.session.usage()
    await refresh($, usage.rateLimits)
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
    const columns = e.props.bodyColumns
    const perWindow = Math.floor(columns / Math.max(1, list.length))
    const hasResets = perWindow >= 38
    const width = Math.max(
      0,
      Math.min(MAX_BAR, perWindow - (hasResets ? 40 : 21)),
    )

    return (
      <Box flexDirection="column">
        {list.length === 0 ? (
          <Text dimColor>Usage limits: no reading yet</Text>
        ) : (
          <Box flexDirection="row" gap={3}>
            {list.map(one => {
              const filled = Math.max(
                0,
                Math.min(width, Math.round((one.percentUsed / 100) * width)),
              )
              const color = colorOf(one.percentUsed)
              const reset =
                hasResets && one.resetsAt !== undefined
                  ? untilReset(one.resetsAt, at)
                  : undefined

              return (
                <Box flexDirection="row">
                  <Text dimColor>{labelOf(one.kind)} </Text>
                  <Text color={color}>{'━'.repeat(filled)}</Text>
                  <Text dimColor>{'━'.repeat(width - filled)}</Text>
                  <Text bold color={color}>
                    {width > 0 ? ' ' : ''}
                    {Math.round(one.percentUsed)}%
                  </Text>
                  {reset !== undefined && <Text dimColor> · {reset}</Text>}
                </Box>
              )
            })}
          </Box>
        )}
        {below}
      </Box>
    )
  })
}
