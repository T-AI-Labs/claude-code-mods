import { atom, read, update } from 'claude-code'
import type { Color, Elements, EngineInterface, Register } from 'claude-code'

import type { CacheHit } from '../types'

const MINUTE = 60_000
const SHORT_TTL_MS = 5 * MINUTE
const LONG_TTL_MS = 60 * MINUTE
const TTL_KEY = 'ttlMs'
const TICK_MS = 1000
// A refresh starts this long before the entry would lapse; the TTL counts from the start of a request.
const LEAD_MS = 40_000
const GRACE_MS = 30_000
const LAPSED_SHARE = 0.5
const REFRESH_PROMPT = 'Reply with the single word OK.'

// Shared with usage-limits so the columns of both rows line up.
const LABEL_WIDTH = 5
const SEGMENTS = 5
const PERCENT_WIDTH = 4
const DETAIL_WIDTH = 10

type Tags = Pick<Elements['terminal'], 'Box' | 'Text'>
type Layout = { hasGauge: boolean; hasDetails: boolean }

const cache = atom({ plugin: 'cache-meter', key: 'cache' } as const, null)
const warmth = atom({ plugin: 'cache-meter', key: 'warmth' } as const, {
  sentAt: null,
  ttlMs: SHORT_TTL_MS,
})
const keepWarm = atom({ plugin: 'cache-meter', key: 'keepWarm' } as const, {
  isOn: false,
  until: null,
  refreshes: 0,
})
const now = atom({ plugin: 'cache-meter', key: 'now' } as const, 0)

const tokens = (count: number) => {
  const thousands = Math.round(count / 1000)

  if (count < 1000) {
    return String(count)
  }

  return thousands < 1000
    ? `${thousands}k`
    : `${Number((count / 1_000_000).toFixed(1))}M`
}

const clockText = (duration: number) => {
  const seconds = Math.max(0, Math.ceil(duration / 1000))

  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

const cacheTone = (percent: number): Color =>
  percent < 40 ? 'warning' : 'text'

const meter = (
  { Box, Text }: Tags,
  layout: Layout,
  hit: CacheHit | null,
) => {
  const percent = hit === null ? null : (hit.read / hit.total) * 100
  const tone = cacheTone(percent ?? 100)
  const filled =
    percent === null
      ? 0
      : Math.max(0, Math.min(SEGMENTS, Math.round((percent / 100) * SEGMENTS)))

  return (
    <Box flexDirection="row" flexShrink={0}>
      <Box minWidth={LABEL_WIDTH} marginRight={1} flexShrink={0}>
        <Text dimColor>Cache</Text>
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
            {hit === null ? '' : `(${tokens(hit.read)}/${tokens(hit.total)})`}
          </Text>
        </Box>
      )}
    </Box>
  )
}

let limitMs = 60 * MINUTE
let isWorking = false
let isRefreshing = false
let hasRefreshedSinceTurn = false

function stopKeeping($: EngineInterface, why: string) {
  $.ui.toast(`cache-meter: Keep warm stopped, ${why}.`)
  void update($, keepWarm, held => ({ ...held, isOn: false, until: null }))
}

async function refresh($: EngineInterface) {
  isRefreshing = true

  try {
    const at = await $.clock.now()
    const result = await $.model.fork({ prompt: REFRESH_PROMPT })

    if (!result.isAnswered) {
      if (result.reason !== 'nothing-to-fork') {
        stopKeeping($, `the refresh failed (${result.reason})`)
      }

      return
    }

    const { usage } = result
    const total = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens

    if (total > 0 && usage.cache_read_input_tokens / total < LAPSED_SHARE) {
      stopKeeping($, 'the cache had already lapsed')

      return
    }

    hasRefreshedSinceTurn = true
    await update($, warmth, held => ({ ...held, sentAt: at }))
    await update($, keepWarm, held => ({ ...held, refreshes: held.refreshes + 1 }))
  } finally {
    isRefreshing = false
  }
}

async function tick($: EngineInterface) {
  const at = await $.clock.now()
  const held = await read($, warmth)

  if (held.sentAt === null || at - held.sentAt > held.ttlMs + TICK_MS * 2) {
    return
  }

  await update($, now, () => at)
  const keep = await read($, keepWarm)
  const isDue = at >= held.sentAt + held.ttlMs - LEAD_MS && at < held.sentAt + held.ttlMs

  if (keep.isOn && keep.until !== null && at < keep.until && isDue && !isWorking && !isRefreshing) {
    await refresh($)
  }
}

async function toggle($: EngineInterface) {
  const at = await $.clock.now()
  const held = await read($, warmth)
  const isWarm = held.sentAt !== null && at - held.sentAt < held.ttlMs

  await update($, keepWarm, keep =>
    keep.isOn
      ? { ...keep, isOn: false, until: null }
      : { isOn: true, until: isWarm ? at + limitMs : null, refreshes: 0 },
  )
}

export const register: Register = (on, options) => {
  const layout: Layout = {
    hasGauge: options.display !== 'text',
    hasDetails: options.details !== false,
  }
  limitMs = Number(options.keepWarmMinutes ?? 60) * MINUTE || 60 * MINUTE

  on('session.start', async ($, e, next) => {
    const learned = await $.store.get(TTL_KEY)
    const at = await $.clock.now()

    if (learned === LONG_TTL_MS) {
      await update($, warmth, held => ({ ...held, ttlMs: LONG_TTL_MS }))
    }

    await update($, now, () => at)
    $.clock.every(TICK_MS, () => void tick($))

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, cache, () => null)
      await update($, warmth, held => ({ ...held, sentAt: null }))
      await update($, keepWarm, held => ({ ...held, until: null }))
    }

    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined || isRefreshing) {
      return yield* next(e)
    }

    const at = await $.clock.now()
    const held = await read($, warmth)
    const gap = held.sentAt === null ? null : at - held.sentAt
    const wasRefreshed = hasRefreshedSinceTurn
    isWorking = true
    hasRefreshedSinceTurn = false
    await update($, warmth, before => ({ ...before, sentAt: at }))

    const result = yield* next(e)
    const usage = result.usage
    const total =
      usage === null
        ? 0
        : usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
    // A hit after a gap past the short TTL, with no refresh between, shows the session caches for an hour.
    const isLongTtl =
      e.index === 0 &&
      !wasRefreshed &&
      held.ttlMs === SHORT_TTL_MS &&
      gap !== null &&
      gap > SHORT_TTL_MS + GRACE_MS &&
      usage !== null &&
      total > 0 &&
      usage.cache_read_input_tokens / total >= LAPSED_SHARE

    if (isLongTtl) {
      await update($, warmth, before => ({ ...before, ttlMs: LONG_TTL_MS }))
      await $.store.set(TTL_KEY, LONG_TTL_MS)
    }

    return result
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      isWorking = false
      const at = await $.clock.now()
      await update($, keepWarm, keep => (keep.isOn ? { ...keep, until: at + limitMs } : keep))

      if (e.usage !== undefined) {
        const served = e.usage.cache_read_input_tokens
        const total = e.usage.input_tokens + served + e.usage.cache_creation_input_tokens

        if (total > 0) {
          await update($, cache, () => ({ read: served, total }))
        }
      }
    }

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)

    if (e.props.hasSurvey) {
      return below
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    const hit = await read($, cache)
    const held = await read($, warmth)
    const keep = await read($, keepWarm)
    const at = await read($, now)
    const left = held.sentAt === null ? null : held.sentAt + held.ttlMs - at
    const keepLeft = keep.until === null ? null : keep.until - at
    const keepLabel = !keep.isOn
      ? 'Keep warm'
      : keepLeft === null
        ? 'Keep warm: after next turn'
        : keepLeft > 0
          ? `Keeping warm ${Math.ceil(keepLeft / MINUTE)}m · ${keep.refreshes}×`
          : `Kept warm · ${keep.refreshes}×`

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" flexWrap="wrap">
          {meter({ Box, Text }, layout, hit)}
          {left !== null && (
            <Box minWidth={10} marginRight={1} flexShrink={0}>
              {left > 0 ? (
                <Text dimColor>warm {clockText(left)}</Text>
              ) : (
                <Text color="warning">cold</Text>
              )}
            </Box>
          )}
          <Box flexDirection="row" flexShrink={0}>
            <Button
              key="keep-warm"
              label={keepLabel}
              variant={keep.isOn ? 'primary' : 'secondary'}
              onPress={() => void toggle($)}
            />
          </Box>
        </Box>
        {below}
      </Box>
    )
  })
}
