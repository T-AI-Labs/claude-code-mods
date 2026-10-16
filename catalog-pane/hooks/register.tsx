import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import {
  EVERYWHERE,
  KINDS,
  detail,
  explainInto,
  explanationKey,
  firstLine,
  labelOf,
  originsOf,
  refresh,
  snapshot,
  startCatalog,
  trackCatalog,
  usageOf,
  usageText,
  visible,
} from './catalog'
import type { Sort, View } from '../types'

const PANE = 'catalog'
const PAGE = 20

const START: View = {
  kind: 'skill',
  selected: null,
  trail: [],
  query: '',
  sort: 'usage',
  origin: EVERYWHERE,
  page: 0,
}

const view = atom({ plugin: 'catalog-pane', key: 'view' } as const, START)

const startFrom = (args: string): Partial<View> => {
  const word = args.trim().toLowerCase()
  const kind = KINDS.find(one => one.kind === word || one.label.toLowerCase() === word)?.kind

  if (word === '') {
    return {}
  }

  return kind === undefined ? { query: args.trim(), page: 0, selected: null } : { kind, selected: null, page: 0 }
}

export const register: Register = (on, options) => {
  const language = typeof options.language === 'string' && options.language !== '' ? options.language : 'English'

  trackCatalog(on)

  on('session.start', async ($, e, next) => {
    await startCatalog($)
    await $.command.register({
      name: 'catalog',
      description: 'Browse skills, commands, agents, plugins, MCP servers and tools in a pane',
      argumentHint: '[category or search]',
    })
    void refresh($)

    if (e.surface === 'desktop') {
      void $.ui.open({ id: PANE, title: 'Catalog' })
    }

    return next(e)
  })

  // The desktop app attaches after the session started, so session.start sees no surface there.
  on('session.attach', async ($, e, next) => {
    if (e.surface === 'desktop') {
      void $.ui.open({ id: PANE, title: 'Catalog' })
    }

    return next(e)
  })

  on('command.run', { command: 'catalog' }, async ($, e) => {
    await update($, view, current => ({ ...current, trail: [], ...startFrom(e.args ?? '') }))
    await refresh($)
    await $.ui.open({ id: PANE, title: 'Catalog' })

    return { text: 'Opened the catalog pane.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const tags = $.ui.resolve(e)
    const { Box, Button, Text } = tags
    const { list, totals, notes, busy, isLoading: loading } = await snapshot($)
    const state = await read($, view)
    const selected = state.selected === null ? undefined : list.find(one => one.id === state.selected)

    const go = (patch: Partial<View>) => update($, view, current => ({ ...current, ...patch }))
    const open = (id: string) =>
      update($, view, current => {
        const target = list.find(one => one.id === id)

        return {
          ...current,
          kind: target?.kind ?? current.kind,
          trail: current.selected === null ? current.trail : [...current.trail, current.selected],
          selected: id,
        }
      })
    const back = () =>
      update($, view, current => ({
        ...current,
        selected: current.trail.at(-1) ?? null,
        trail: current.trail.slice(0, -1),
      }))

    const tabs = (
      <Box flexDirection="row" flexWrap="wrap" gap={1}>
        {KINDS.map(({ kind, label }) => (
          <Button
            key={`tab-${kind}`}
            label={`${label} ${list.filter(one => one.kind === kind).length}`}
            variant={kind === state.kind ? 'primary' : 'secondary'}
            onPress={() => go({ kind, selected: null, trail: [], origin: EVERYWHERE, page: 0 })}
          />
        ))}
        <Button key="refresh" label={loading ? 'Loading…' : 'Refresh'} plain onPress={() => refresh($)} />
      </Box>
    )

    if (selected !== undefined) {
      const crumbs = [...state.trail, selected.id]
        .map(id => list.find(one => one.id === id)?.name ?? id)
        .join(' › ')

      return (
        <Box flexDirection="column" gap={1}>
          {tabs}
          <Box flexDirection="row" gap={1}>
            <Button key="back" label="‹ Back" onPress={back} />
            <Text dimColor wrap="truncate-end">
              {labelOf(selected.kind)} › {crumbs}
            </Text>
          </Box>
          {detail($, tags, {
            entry: selected,
            list,
            totals,
            explanation: notes[explanationKey(language, selected.id)],
            isExplaining: busy.includes(selected.id),
            onOpen: id => void open(id),
            onExplain: () => void explainInto($, selected, language),
          })}
        </Box>
      )
    }

    const rows = visible(list, totals, state)
    const pages = Math.max(1, Math.ceil(rows.length / PAGE))
    const page = Math.min(state.page, pages - 1)
    const shown = rows.slice(page * PAGE, (page + 1) * PAGE)

    const filters =
      'Select' in tags ? (
        <Box flexDirection="row" flexWrap="wrap" gap={1}>
          <tags.Input
            key="query"
            label="Filter"
            placeholder="name or description"
            value={state.query}
            onInput={query => void go({ query, page: 0 })}
            onSubmit={query => void go({ query, page: 0 })}
          />
          <tags.Select
            key="sort"
            label="Sort"
            value={state.sort}
            options={[
              { value: 'usage', label: 'Most used' },
              { value: 'name', label: 'Name' },
            ]}
            onSelect={sort => void go({ sort: sort as Sort, page: 0 })}
          />
          <tags.Select
            key="origin"
            label="From"
            value={state.origin}
            options={[
              { value: EVERYWHERE, label: 'Everywhere' },
              ...originsOf(list, state.kind).map(origin => ({ value: origin })),
            ]}
            onSelect={origin => void go({ origin, page: 0 })}
          />
        </Box>
      ) : undefined

    return (
      <Box flexDirection="column" gap={1}>
        {tabs}
        {filters}
        {list.length === 0 && <Text dimColor>{loading ? 'Collecting…' : 'Nothing found yet. Press Refresh.'}</Text>}
        {list.length > 0 && rows.length === 0 && <Text dimColor>Nothing matches.</Text>}
        <Box flexDirection="column" gap={1}>
          {shown.map(one => (
            <Box key={`row-${one.id}`} flexDirection="column">
              <Button key={`open-${one.id}`} plain onPress={() => open(one.id)}>
                {one.name} <Text dimColor>{one.origin} · {usageText(usageOf(one, list, totals))}</Text>
              </Button>
              {one.description !== '' && (
                <Text dimColor wrap="truncate-end">
                  {firstLine(one.description)}
                </Text>
              )}
            </Box>
          ))}
        </Box>
        {pages > 1 && (
          <Box flexDirection="row" gap={1} alignItems="center">
            <Button key="previous" label="‹ Previous" onPress={() => go({ page: Math.max(0, page - 1) })} />
            <Text dimColor>
              {page * PAGE + 1}–{Math.min(rows.length, (page + 1) * PAGE)} of {rows.length}
            </Text>
            <Button key="next" label="Next ›" onPress={() => go({ page: Math.min(pages - 1, page + 1) })} />
          </Box>
        )}
      </Box>
    )
  })
}
