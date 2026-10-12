import { atom, read, update } from 'claude-code'
import type {
  Color,
  Elements,
  EngineInterface,
  Register,
  SessionContextUsage,
} from 'claude-code'

import type { ContextFill } from '../types'

const STEPS = [97, 90, 70, 60, 50]
const OPTIONS = STEPS.map(step => ({ value: String(step), label: `${step}%` }))
const DEFAULT_THRESHOLD = 97
const STORE_KEY = 'threshold'

// Shared with usage-limits so the columns of both rows line up.
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

const cache = atom({ plugin: 'cache-meter', key: 'cache' } as const, null)
const context = atom({ plugin: 'cache-meter', key: 'context' } as const, null)
const threshold = atom(
  { plugin: 'cache-meter', key: 'threshold' } as const,
  DEFAULT_THRESHOLD,
)

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

const cacheTone = (percent: number): Color =>
  percent < 40 ? 'warning' : 'text'

const contextTone = (percent: number, limit: number): Color =>
  percent >= limit ? 'error' : percent >= limit - 15 ? 'warning' : 'text'

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

const runCommand = ($: EngineInterface, command: string) => {
  $.command
    .run({ command })
    .catch(() => $.ui.toast(`cache-meter: /${command} could not run`))
}

const cycleThreshold = async ($: EngineInterface) => {
  const value = await update(
    $,
    threshold,
    held => STEPS[(STEPS.indexOf(held) + 1) % STEPS.length] ?? DEFAULT_THRESHOLD,
  )
  await $.store.set(STORE_KEY, value)
}

const setThreshold = async ($: EngineInterface, value: number) => {
  if (STEPS.includes(value)) {
    await update($, threshold, () => value)
    await $.store.set(STORE_KEY, value)
  }
}

export const register: Register = (on, options) => {
  const layout: Layout = {
    hasGauge: options.display !== 'text',
    hasDetails: options.details !== false,
  }
  // Re-armed only once the fill drops below the threshold, so a compaction that lands above it does not loop.
  let isArmed = true

  on('session.start', async ($, e, next) => {
    const stored = await $.store.get(STORE_KEY)

    if (typeof stored === 'number' && STEPS.includes(stored)) {
      await update($, threshold, () => stored)
    }

    const usage = await $.session.usage()
    await update($, context, () => toFill(usage.context))

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      isArmed = true
      await update($, cache, () => null)
      await update($, context, () => null)
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined && e.usage !== undefined) {
      const served = e.usage.cache_read_input_tokens
      const total =
        e.usage.input_tokens + served + e.usage.cache_creation_input_tokens

      if (total > 0) {
        await update($, cache, () => ({ read: served, total }))
      }
    }

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('context')) {
      const fill = toFill(e.context)
      const limit = await read($, threshold)
      await update($, context, () => fill)

      if (fill !== null && fill.percent < limit) {
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
    const hit = await read($, cache)
    const fill = await read($, context)
    const limit = await read($, threshold)
    const hitPercent = hit === null ? null : (hit.read / hit.total) * 100
    let picker

    // The mobile surface draws no Select.
    if (e.surface === 'mobile') {
      picker = (
        <Button
          key="threshold"
          label={`Compact at ${limit}%`}
          onPress={() => void cycleThreshold($)}
        />
      )
    } else {
      const { Select } = $.ui.resolve(e)
      picker = (
        <Select
          key="threshold"
          label="Compact at"
          options={OPTIONS}
          value={String(limit)}
          onSelect={value => void setThreshold($, Number(value))}
        />
      )
    }

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" flexWrap="wrap">
          {meter({ Box, Text }, layout, {
            label: 'Cache',
            column: 0,
            percent: hitPercent,
            tone: cacheTone(hitPercent ?? 100),
            detail:
              hit === null ? '' : `(${tokens(hit.read)}/${tokens(hit.total)})`,
          })}
          {meter({ Box, Text }, layout, {
            label: 'Context',
            column: 1,
            percent: fill === null ? null : fill.percent,
            tone: contextTone(fill === null ? 0 : fill.percent, limit),
            detail:
              fill === null
                ? ''
                : `(${tokens(fill.tokens)}/${tokens(fill.window)})`,
          })}
          <Box flexDirection="row" gap={1} flexShrink={0}>
            {picker}
            <Button
              key="compact"
              label="Compact"
              onPress={() => runCommand($, 'compact')}
            />
            <Button
              key="clear"
              label="Clear"
              onPress={() => runCommand($, 'clear')}
            />
          </Box>
        </Box>
        {below}
      </Box>
    )
  })
}
