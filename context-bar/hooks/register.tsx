import { atom, read, update } from 'claude-code'
import type {
  Color,
  ElementConstructor,
  EngineInterface,
  Register,
  SessionContextUsage,
  TextProps,
} from 'claude-code'

import type { ContextFill } from '../types'

const STEPS = [97, 90, 70, 60, 50]
const DEFAULT_THRESHOLD = 97
const STORE_KEY = 'threshold'
const MAX_BAR = 12
const ROW_WITHOUT_BARS = 72

const cache = atom({ plugin: 'context-bar', key: 'cache' } as const, null)
const context = atom({ plugin: 'context-bar', key: 'context' } as const, null)
const threshold = atom(
  { plugin: 'context-bar', key: 'threshold' } as const,
  DEFAULT_THRESHOLD,
)

const toFill = (live: SessionContextUsage): ContextFill | null =>
  live.percent === undefined || live.tokens === undefined
    ? null
    : { percent: live.percent, tokens: live.tokens, window: live.window }

const barWidth = (columns: number) =>
  Math.max(0, Math.min(MAX_BAR, Math.floor((columns - ROW_WITHOUT_BARS) / 2)))

const cacheColor = (percent: number): Color =>
  percent >= 70 ? 'success' : percent >= 40 ? 'warning' : 'error'

const contextColor = (percent: number, limit: number): Color =>
  percent >= limit ? 'error' : percent >= limit - 15 ? 'warning' : 'success'

const meter = (
  Text: ElementConstructor<TextProps>,
  label: string,
  percent: number | null,
  color: Color,
  width: number,
) => {
  const filled =
    percent === null
      ? 0
      : Math.max(0, Math.min(width, Math.round((percent / 100) * width)))

  return [
    <Text dimColor>{label} </Text>,
    <Text color={color}>{'━'.repeat(filled)}</Text>,
    <Text dimColor>{'━'.repeat(width - filled)}</Text>,
    <Text bold color={percent === null ? 'inactive' : color}>
      {width > 0 ? ' ' : ''}
      {percent === null ? '–' : `${Math.round(percent)}%`}
    </Text>,
  ]
}

const runCommand = ($: EngineInterface, command: string) => {
  $.command
    .run({ command })
    .catch(() => $.ui.toast(`context-bar: /${command} could not run`))
}

const cycleThreshold = async ($: EngineInterface) => {
  const value = await update(
    $,
    threshold,
    held => STEPS[(STEPS.indexOf(held) + 1) % STEPS.length] ?? DEFAULT_THRESHOLD,
  )
  await $.store.set(STORE_KEY, value)
}

export const register: Register = on => {
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
      const tokens = compacted.tokensAfter
      await update($, context, held =>
        held === null || tokens === undefined
          ? null
          : {
              tokens,
              window: held.window,
              percent: Math.round((tokens / held.window) * 100),
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
    const width = barWidth(e.props.bodyColumns)
    const hitPercent = hit === null ? null : (hit.read / hit.total) * 100
    const fillPercent = fill === null ? null : fill.percent

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={2}>
          <Box flexDirection="row">
            {meter(
              Text,
              'Cache',
              hitPercent,
              cacheColor(hitPercent ?? 0),
              width,
            )}
          </Box>
          <Box flexDirection="row">
            {meter(
              Text,
              'Context',
              fillPercent,
              contextColor(fillPercent ?? 0, limit),
              width,
            )}
          </Box>
          <Button
            key="threshold"
            label={`Auto-compact ${limit}%`}
            onPress={() => void cycleThreshold($)}
          />
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
        {below}
      </Box>
    )
  })
}
