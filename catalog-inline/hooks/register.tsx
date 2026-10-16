import { atom, memberOf, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import {
  EVERYWHERE,
  KINDS,
  actions,
  detail,
  explainInto,
  explanationKey,
  firstLine,
  labelOf,
  refresh,
  snapshot,
  startCatalog,
  trackCatalog,
  usageOf,
  usageText,
  visible,
} from './catalog'
import type { Kind, View } from '../types'

const COMMAND = 'catalog-inline'

const START: View = {
  kind: 'skill',
  selected: null,
  trail: [],
  query: '',
  sort: 'usage',
  origin: EVERYWHERE,
  page: 0,
}

const views = atom({ plugin: 'catalog-inline', key: 'views' } as const, null)
const band = atom({ plugin: 'catalog-inline', key: 'band' } as const, START)
const isBandOpen = atom({ plugin: 'catalog-inline', key: 'isBandOpen' } as const, false)

const startFrom = (args: string): View => {
  const word = args.trim().toLowerCase()
  const kind = KINDS.find(one => one.kind === word || one.label.toLowerCase() === word)?.kind

  if (word === '') {
    return START
  }

  return kind === undefined ? { ...START, query: args.trim() } : { ...START, kind }
}

export const register: Register = (on, options) => {
  const language = typeof options.language === 'string' && options.language !== '' ? options.language : 'English'

  trackCatalog(on)

  on('session.start', async ($, e, next) => {
    await startCatalog($)
    await $.command.register({
      name: COMMAND,
      description: 'Browse skills, commands, agents, plugins, MCP servers and tools right in the chat',
      argumentHint: '[category or search]',
    })
    void refresh($)

    return next(e)
  })

  on('command.run', { command: COMMAND }, async $ => {
    await refresh($)
    const { list } = await snapshot($)
    const counts = KINDS.map(({ kind, label }) => `${list.filter(one => one.kind === kind).length} ${label.toLowerCase()}`)

    return { text: `Catalog: ${counts.join(', ')}.` }
  })

  on('ui.render', { component: 'CommandOutput', props: { command: COMMAND } }, async ($, e, next) => {
    const tags = $.ui.resolve(e)

    if (!('Select' in tags)) {
      return next(e)
    }

    const { Box, Button, Input, Select, Text } = tags
    const { list, totals, notes, busy } = await snapshot($)
    const member = memberOf(views, e)
    const state = (await read($, member)) ?? startFrom(e.props.args)
    const rows = visible(list, totals, state)
    const chosen = state.selected === null ? undefined : list.find(one => one.id === state.selected)
    const selected = chosen ?? rows[0]
    const isListed = selected !== undefined && rows.some(one => one.id === selected.id)

    const go = (patch: Partial<View>) => update($, member, current => ({ ...(current ?? state), ...patch }))
    const open = (id: string) =>
      update($, member, current => {
        const base = current ?? state
        const target = list.find(one => one.id === id)

        return {
          ...base,
          kind: target?.kind ?? base.kind,
          query: '',
          origin: EVERYWHERE,
          trail: selected === undefined ? base.trail : [...base.trail, selected.id],
          selected: id,
        }
      })
    const back = () =>
      update($, member, current => {
        const base = current ?? state
        const previous = base.trail.at(-1) ?? null
        const target = list.find(one => one.id === previous)

        return { ...base, kind: target?.kind ?? base.kind, selected: previous, trail: base.trail.slice(0, -1) }
      })

    return (
      <Box flexDirection="column" gap={1} borderStyle="round" paddingX={1}>
        <Box flexDirection="row" flexWrap="wrap" gap={1}>
          <Select
            key="kind"
            label="Category"
            value={state.kind}
            options={KINDS.map(({ kind, label }) => ({
              value: kind,
              label: `${label} (${list.filter(one => one.kind === kind).length})`,
            }))}
            onSelect={kind => void go({ kind: kind as Kind, selected: null, trail: [], origin: EVERYWHERE })}
          />
          <Input
            key="query"
            label="Filter"
            placeholder="name or description"
            value={state.query}
            onInput={query => void go({ query, selected: null })}
            onSubmit={query => void go({ query, selected: null })}
          />
          {rows.length > 0 && (
            <Select
              key="entry"
              label={labelOf(state.kind)}
              value={isListed ? selected.id : undefined}
              options={rows.map(one => ({
                value: one.id,
                label: `${one.name} · ${usageOf(one, list, totals).count}×`,
              }))}
              onSelect={id => void go({ selected: id, trail: [] })}
            />
          )}
        </Box>
        {state.trail.length > 0 && (
          <Box flexDirection="row">
            <Button key="back" label="‹ Back" onPress={back} />
          </Box>
        )}
        {selected === undefined ? (
          <Text dimColor>{list.length === 0 ? 'Collecting…' : 'Nothing matches.'}</Text>
        ) : (
          detail($, tags, {
            entry: selected,
            list,
            totals,
            explanation: notes[explanationKey(language, selected.id)],
            isExplaining: busy.includes(selected.id),
            onOpen: id => void open(id),
            onExplain: () => void explainInto($, selected, language),
          })
        )}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    const tags = $.ui.resolve(e)

    if (e.props.hasSurvey || !('Select' in tags)) {
      return below
    }

    const { Box, Button, Select, Text } = tags
    const { list, totals, notes, busy } = await snapshot($)
    const state = await read($, band)
    const isOpen = await read($, isBandOpen)
    const rows = visible(list, totals, state)
    const chosen = state.selected === null ? undefined : list.find(one => one.id === state.selected)
    const selected = chosen ?? rows[0]
    const isListed = selected !== undefined && rows.some(one => one.id === selected.id)
    const go = (patch: Partial<View>) => update($, band, current => ({ ...current, ...patch }))

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" flexWrap="wrap" gap={1} alignItems="center">
          <Text dimColor>Catalog</Text>
          <Select
            key="band-kind"
            value={state.kind}
            options={KINDS.map(({ kind, label }) => ({
              value: kind,
              label: `${label} (${list.filter(one => one.kind === kind).length})`,
            }))}
            onSelect={kind => void go({ kind: kind as Kind, selected: null, trail: [] })}
          />
          {rows.length > 0 && (
            <Select
              key="band-entry"
              value={isListed ? selected.id : undefined}
              options={rows.map(one => ({
                value: one.id,
                label: `${one.name} · ${usageOf(one, list, totals).count}×`,
              }))}
              onSelect={id => void go({ selected: id, trail: [] })}
            />
          )}
          {selected !== undefined && !isOpen && actions($, tags, selected)}
          {selected !== undefined && (
            <Button
              key="band-more"
              plain
              label={isOpen ? 'Less' : 'More'}
              onPress={() => update($, isBandOpen, open => !open)}
            />
          )}
        </Box>
        {selected !== undefined && !isOpen && (
          <Text dimColor wrap="truncate-end">
            {firstLine(selected.description) || labelOf(selected.kind)} · {usageText(usageOf(selected, list, totals))}
          </Text>
        )}
        {selected !== undefined &&
          isOpen &&
          detail($, tags, {
            entry: selected,
            list,
            totals,
            explanation: notes[explanationKey(language, selected.id)],
            isExplaining: busy.includes(selected.id),
            onOpen: id => {
              const target = list.find(one => one.id === id)
              void go({ kind: target?.kind ?? state.kind, selected: id, trail: [] })
            },
            onExplain: () => void explainInto($, selected, language),
          })}
        {below}
      </Box>
    )
  })
}
