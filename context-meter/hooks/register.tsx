import { atom, read, update } from 'claude-code'
import type {
  Color,
  Elements,
  EngineInterface,
  Register,
  SessionContextUsage,
} from 'claude-code'

import type { ContextFill } from '../types'

const OFF = 0
const STEPS = [OFF, 97, 90, 70, 60, 50]
const stepLabel = (step: number) => (step === OFF ? 'Off' : `${step}%`)
const OPTIONS = STEPS.map(step => ({ value: String(step), label: stepLabel(step) }))
const DEFAULT_THRESHOLD = 97
const STORE_KEY = 'threshold'

// Shared with cache-meter, context-meter and usage-limits so the gauges of all rows line up.
const LABEL_WIDTH = 7
const SEGMENTS = 5
const PERCENT_WIDTH = 4
const DETAIL_WIDTH = 10

type Tags = Pick<Elements['terminal'], 'Box' | 'Text'>
type Layout = { hasGauge: boolean; hasDetails: boolean }

type Action = { id: string; label: string; onPress: () => void }

const ACTIONS_URL = 'https://context-meter.invalid/'

// The desktop draws every Button as a full-height control; a Markdown link is drawn at text size.
const actionLinks = ({ Markdown }: Pick<Elements['desktop'], 'Markdown'>, actions: Action[]) => (
  <Markdown
    key="actions"
    text={actions.map(one => `[/${one.id}](${ACTIONS_URL}${one.id})`).join(' \u00a0·\u00a0 ')}
    pressableLinks={actions.map(one => ACTIONS_URL + one.id)}
    onLinkPress={link => actions.find(one => ACTIONS_URL + one.id === link.href)?.onPress()}
  />
)

const context = atom({ plugin: 'context-meter', key: 'context' } as const, null)
const threshold = atom(
  { plugin: 'context-meter', key: 'threshold' } as const,
  DEFAULT_THRESHOLD,
)

const toFill = (live: SessionContextUsage): ContextFill | null =>
  live.percent === undefined || live.tokens === undefined
    ? null
    : { percent: live.percent, tokens: live.tokens, window: live.window }

const restore = async ($: EngineInterface) => {
  const stored = await $.store.get(STORE_KEY)

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

const meter = (
  { Box, Text }: Tags,
  layout: Layout,
  fill: ContextFill | null,
  limit: number,
) => {
  const percent = fill === null ? null : fill.percent
  const tone = contextTone(percent ?? 0, limit)
  const filled =
    percent === null
      ? 0
      : Math.max(0, Math.min(SEGMENTS, Math.round((percent / 100) * SEGMENTS)))

  return (
    <Box flexDirection="row" flexShrink={0}>
      <Box minWidth={LABEL_WIDTH} marginRight={1} flexShrink={0}>
        <Text dimColor>Context</Text>
      </Box>
      {layout.hasGauge && (
        <Box minWidth={SEGMENTS} marginRight={1} flexShrink={0}>
          <Text color={tone}>{'▮'.repeat(filled)}</Text>
          <Text dimColor>{'▯'.repeat(SEGMENTS - filled)}</Text>
        </Box>
      )}
      <Box
        minWidth={PERCENT_WIDTH}
        marginRight={1}
        flexShrink={0}
        justifyContent="flex-end"
      >
        <Text color={percent === null ? 'inactive' : tone}>
          {percent === null ? '–' : `${Math.round(percent)}%`}
        </Text>
      </Box>
      {layout.hasDetails && (
        <Box minWidth={DETAIL_WIDTH} marginRight={1} flexShrink={0}>
          <Text dimColor>
            {fill === null ? '' : `(${tokens(fill.tokens)}/${tokens(fill.window)})`}
          </Text>
        </Box>
      )}
    </Box>
  )
}

const runCommand = ($: EngineInterface, command: string) => {
  $.command
    .run({ command })
    .catch(() => $.ui.toast(`context-meter: /${command} could not run`))
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
    await restore($)

    return next(e)
  })

  // A /clear wipes every plugin's state after session.end and raises no session.start, only this.
  on('classic.SessionStart', async ($, e, next) => {
    if (e.source === 'clear') {
      await restore($).catch(() => undefined)
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
    const actions: Action[] = [
      { id: 'compact', label: 'Compact', onPress: () => runCommand($, 'compact') },
      { id: 'clear', label: 'Clear', onPress: () => runCommand($, 'clear') },
    ]
    const fill = await read($, context)
    const limit = await read($, threshold)
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

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" flexWrap="wrap">
          {meter({ Box, Text }, layout, fill, limit)}
          <Box flexDirection="row" gap={1} flexShrink={0}>
            {picker}
            {e.surface === 'desktop'
              ? actionLinks($.ui.resolve(e), actions)
              : actions.map(one => <Button key={one.id} label={one.label} onPress={one.onPress} />)}
          </Box>
        </Box>
        {below}
      </Box>
    )
  })
}
