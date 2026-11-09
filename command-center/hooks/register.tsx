import { atom, read, update } from 'claude-code'
import type { AgentOfferInput, CommandInfo, EngineInterface, FsEntry, Register } from 'claude-code'

import type { Choice } from '../types'

const NONE = '-'
const ALL = '*'
const AGENTS_KEY = 'agents'
const USED_KEY = 'used'
const DESCRIPTION_LENGTH = 40
// AbovePrompt refuses a Select with more than 64 options; one of them is the empty pick.
const MAX_CHOICES = 63
// The desktop's native Select and Button are taller than one text row and spill onto the row above.
const DESKTOP_ROWS = 2
const MANUAL_ONLY = /^disable-model-invocation:\s*true\s*$/m

type Installed = { plugins?: Record<string, { installPath: string }[]> }

const agents = atom({ plugin: 'command-center', key: 'agents' } as const, [])
const slashes = atom({ plugin: 'command-center', key: 'slashes' } as const, [])
const agent = atom({ plugin: 'command-center', key: 'agent' } as const, NONE)
const slash = atom({ plugin: 'command-center', key: 'slash' } as const, NONE)
const source = atom({ plugin: 'command-center', key: 'source' } as const, ALL)

const byName = (a: Choice, b: Choice) => a.name.localeCompare(b.name)

async function configDir($: EngineInterface) {
  const own = await $.env.get('CLAUDE_CONFIG_DIR')

  if (own !== undefined && own !== '') {
    return own
  }

  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? ''

  return `${home}/.claude`
}

async function foldersIn($: EngineInterface, dir: string) {
  const entries = await $.fs.list(dir).catch(() => [] as FsEntry[])

  return entries.filter(entry => entry.kind === 'dir' || entry.isLink).map(entry => entry.name)
}

// command.list mixes skills with commands; only the skill folders tell them apart.
async function skillFolders($: EngineInterface) {
  const [config, root] = await Promise.all([configDir($), $.session.root()])
  const folders = new Map<string, string>()

  for (const dir of [`${config}/skills`, `${root}/.claude/skills`]) {
    for (const name of await foldersIn($, dir)) {
      folders.set(name, `${dir}/${name}`)
    }
  }

  const installed = await $.fs
    .read(`${config}/plugins/installed_plugins.json`)
    .then(text => JSON.parse(text) as Installed)
    .catch(() => ({}) as Installed)

  for (const [key, installs] of Object.entries(installed.plugins ?? {})) {
    const plugin = key.split('@')[0] ?? key
    const pluginRoot = installs[0]?.installPath

    if (pluginRoot !== undefined) {
      for (const name of await foldersIn($, `${pluginRoot}/skills`)) {
        folders.set(`${plugin}:${name}`, `${pluginRoot}/skills/${name}`)
      }
    }
  }

  return folders
}

// A skill with disable-model-invocation can only be started by the person, so no agent can be told to use it.
async function isManualOnly($: EngineInterface, folder: string) {
  const text = await $.fs.read(`${folder}/SKILL.md`).catch(() => '')
  const end = text.indexOf('\n---', 3)

  return text.startsWith('---') && end > 0 && MANUAL_ONLY.test(text.slice(3, end))
}

async function commandFilesIn($: EngineInterface, dir: string) {
  const entries = await $.fs.list(dir).catch(() => [] as FsEntry[])
  const names: string[] = []

  for (const entry of entries) {
    if (entry.kind === 'file' && entry.name.endsWith('.md')) {
      names.push(entry.name.slice(0, -'.md'.length))
    } else if (entry.kind === 'dir' || entry.isLink) {
      for (const name of await commandFilesIn($, `${dir}/${entry.name}`)) {
        names.push(name, `${entry.name}:${name}`)
      }
    }
  }

  return names
}

// command.list reports the repository's skills and commands as user ones; only their folders tell them apart.
async function projectNames($: EngineInterface) {
  const root = await $.session.root()

  return new Set([
    ...(await foldersIn($, `${root}/.claude/skills`)),
    ...(await commandFilesIn($, `${root}/.claude/commands`)),
  ])
}

const sourceOf = (one: CommandInfo, project: Set<string>) => {
  if (one.source === 'user' && project.has(one.name)) {
    return 'Project'
  }

  if (one.source === 'builtin') {
    return 'Built-in'
  }

  if (one.source === 'mcp') {
    return 'MCP'
  }

  if (one.source === 'user') {
    return 'User'
  }

  return one.plugin ?? (one.name.includes(':') ? one.name.split(':')[0] : undefined) ?? 'Plugin'
}

const agentSourceOf = (offer: AgentOfferInput) => {
  if (offer.source === 'built-in') {
    return 'Built-in'
  }

  if (offer.source === 'plugin') {
    return offer.agent.includes(':') ? (offer.agent.split(':')[0] ?? offer.agent) : offer.provider.plugin
  }

  if (offer.source === 'userSettings') {
    return 'User'
  }

  return offer.source === 'projectSettings' || offer.source === 'localSettings' ? 'Project' : offer.source
}

const usedOf = async ($: EngineInterface) =>
  ((await $.store.get(USED_KEY)) ?? {}) as Record<string, number>

// The most recently used come first, the rest by name, so the cap drops the ones not used.
const ranked = (list: readonly Choice[], used: Record<string, number>) =>
  [...list].sort((a, b) => (used[b.name] ?? 0) - (used[a.name] ?? 0) || byName(a, b))

async function loadSlashes($: EngineInterface) {
  const [list, folders, project, used] = await Promise.all([
    $.command.list(),
    skillFolders($),
    projectNames($),
    usedOf($),
  ])
  const choices = await Promise.all(
    list.map(async (one): Promise<Choice> => {
      const folder = folders.get(one.name)
      const base = { name: one.name, description: one.description, source: sourceOf(one, project) }

      return folder === undefined
        ? { ...base, kind: 'command' }
        : { ...base, kind: 'skill', isManualOnly: await isManualOnly($, folder) }
    }),
  )

  await update($, slashes, () => ranked(choices, used))
}

const sourcesOf = (...lists: (readonly Choice[])[]) =>
  [...new Set(lists.flat().map(one => one.source))].sort((a, b) => a.localeCompare(b)).slice(0, MAX_CHOICES)

const inSource = (list: readonly Choice[], from: string) =>
  list.filter(one => from === ALL || one.source === from).slice(0, MAX_CHOICES)

const pickIn = (list: readonly Choice[], value: string) => (list.some(one => one.name === value) ? value : NONE)

// Built-in and other commands steer the session, and a manual-only skill is the person's to start: neither takes an agent.
const takesAgent = (one: Choice | undefined) => one === undefined || (one.kind === 'skill' && !one.isManualOnly)

async function loadAgents($: EngineInterface) {
  const [stored, used] = await Promise.all([
    $.store.get(AGENTS_KEY) as Promise<Record<string, Choice> | undefined>,
    usedOf($),
  ])
  await update($, agents, () => ranked(Object.values(stored ?? {}), used))
}

async function markUsed($: EngineInterface, name: string) {
  const used = await usedOf($)
  await $.store.set(USED_KEY, { ...used, [name]: await $.clock.now() })
}

async function remember($: EngineInterface, offer: AgentOfferInput) {
  const stored = ((await $.store.get(AGENTS_KEY)) ?? {}) as Record<string, Choice>
  const seen = { name: offer.agent, description: offer.description, source: agentSourceOf(offer) }
  const before = stored[seen.name]

  if (before?.description !== seen.description || before.source !== seen.source) {
    const all = { ...stored, [seen.name]: seen }
    await $.store.set(AGENTS_KEY, all)
    await loadAgents($)
  }
}

const picked = (value: string) => (value === NONE ? undefined : value)

async function insert($: EngineInterface) {
  const [slashPick, agentPick] = [picked(await read($, slash)), picked(await read($, agent))]
  const prefix = (slashPick === undefined ? '' : `/${slashPick} `) + (agentPick === undefined ? '' : `@agent-${agentPick} `)

  if (prefix === '') {
    $.ui.toast('Pick a skill, a command or an agent first.')

    return
  }

  const { text } = await $.prompt.read()
  await $.prompt.fill({ text: text.startsWith(prefix) ? text : prefix + text })
}

async function run($: EngineInterface) {
  const slashPick = picked(await read($, slash))
  const type = picked(await read($, agent))
  const chosen = (await read($, slashes)).find(one => one.name === slashPick)

  if (slashPick === undefined && type === undefined) {
    $.ui.toast('Pick a skill, a command or an agent first.')

    return
  }

  if (slashPick !== undefined && chosen?.kind !== 'skill') {
    await update($, slash, () => NONE)
    await $.command.run({ command: slashPick })

    return
  }

  const task = (await $.prompt.read()).text.trim()

  if (type === undefined && slashPick !== undefined) {
    await $.prompt.fill({ text: '' })
    await $.command.run({ command: slashPick, args: task })

    return
  }

  if (task === '') {
    $.ui.toast(`Type the task for ${type} into the prompt first.`)

    return
  }

  const spawned = await $.agent.spawn({
    prompt: slashPick === undefined ? task : `Use the ${slashPick} skill. ${task}`,
    subagentType: type,
    description: task.slice(0, DESCRIPTION_LENGTH),
  })

  if ('deny' in spawned) {
    $.ui.toast(`${type} did not start: ${spawned.deny}`)

    return
  }

  await $.prompt.fill({ text: '' })
  $.ui.toast(`${type} started in the background.`)
}

async function pickSource($: EngineInterface, value: string) {
  const [agentList, slashList] = await Promise.all([read($, agents), read($, slashes)])
  await update($, source, () => value)
  await update($, agent, current => pickIn(inSource(agentList, value), current))
  await update($, slash, current => pickIn(inSource(slashList, value), current))
}

async function pickSlash($: EngineInterface, value: string) {
  const slashList = await read($, slashes)
  await update($, slash, () => value)

  if (!takesAgent(slashList.find(one => one.name === value))) {
    await update($, agent, () => NONE)
  }
}

async function pickAgent($: EngineInterface, value: string) {
  const [slashList, slashPick] = await Promise.all([read($, slashes), read($, slash)])
  await update($, agent, () => value)

  if (value !== NONE && !takesAgent(slashList.find(one => one.name === slashPick))) {
    await update($, slash, () => NONE)
  }
}

const optionsOf = (list: readonly Choice[]) => [
  { value: NONE, label: '–' },
  ...list.map(one => ({ value: one.name, label: one.kind === undefined ? one.name : `${one.name} · ${one.kind}` })),
]

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await Promise.all([loadAgents($), loadSlashes($)])

    return result
  })

  // A /clear wipes every plugin's state after session.end and raises no session.start, only this.
  on('classic.SessionStart', async ($, e, next) => {
    if (e.source === 'clear') {
      await Promise.all([loadAgents($), loadSlashes($)]).catch(() => undefined)
    }

    return next(e)
  })

  // Plugins and skills can change between turns, so the lists follow without a restart.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    await loadSlashes($)

    return result
  })

  on('command.run', async ($, e, next) => {
    await markUsed($, e.command).catch(() => undefined)

    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    await markUsed($, e.subagentType || 'general-purpose').catch(() => undefined)

    return next(e)
  })

  // The engine names every agent type it offers the model here; the store keeps them for the next session's start.
  on('agent.offer', async ($, e, next) => {
    await remember($, e).catch(() => undefined)

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)

    if (e.props.hasSurvey || e.surface === 'mobile') {
      return below
    }

    const { Box, Button, Select } = $.ui.resolve(e)
    const [agentList, slashList, agentValue, slashValue, sourceValue] = await Promise.all([
      read($, agents),
      read($, slashes),
      read($, agent),
      read($, slash),
      read($, source),
    ])
    const sources = sourcesOf(agentList, slashList)
    const from = sources.includes(sourceValue) ? sourceValue : ALL
    const agentsShown = inSource(agentList, from)
    const slashesShown = inSource(slashList, from)

    return (
      <Box flexDirection="column">
        {below}
        <Box
          flexDirection="row"
          flexWrap="wrap"
          alignItems="center"
          columnGap={2}
          minHeight={e.surface === 'desktop' ? DESKTOP_ROWS : undefined}
        >
          <Select
            key="source"
            label="Source"
            options={[{ value: ALL, label: 'All' }, ...sources.map(one => ({ value: one }))]}
            value={from}
            onSelect={value => void pickSource($, value)}
          />
          <Select
            key="agent"
            label="Agent"
            options={optionsOf(agentsShown)}
            value={pickIn(agentsShown, agentValue)}
            onSelect={value => void pickAgent($, value)}
          />
          <Select
            key="slash"
            label="Skill/Command"
            options={optionsOf(slashesShown)}
            value={pickIn(slashesShown, slashValue)}
            onSelect={value => void pickSlash($, value)}
          />
          <Box flexDirection="row" columnGap={1}>
            <Button key="insert" label="Insert" onPress={() => void insert($)} />
            <Button key="run" label="Run" onPress={() => void run($)} />
          </Box>
        </Box>
      </Box>
    )
  })
}
