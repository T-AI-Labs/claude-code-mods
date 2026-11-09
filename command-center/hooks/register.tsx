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

type Installed = { plugins?: Record<string, { installPath: string }[]> }

const agents = atom({ plugin: 'command-center', key: 'agents' } as const, [])
const skills = atom({ plugin: 'command-center', key: 'skills' } as const, [])
const commands = atom({ plugin: 'command-center', key: 'commands' } as const, [])
const agent = atom({ plugin: 'command-center', key: 'agent' } as const, NONE)
const skill = atom({ plugin: 'command-center', key: 'skill' } as const, NONE)
const command = atom({ plugin: 'command-center', key: 'command' } as const, NONE)
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
async function skillNames($: EngineInterface) {
  const [config, root] = await Promise.all([configDir($), $.session.root()])
  const names = new Set([
    ...(await foldersIn($, `${config}/skills`)),
    ...(await foldersIn($, `${root}/.claude/skills`)),
  ])
  const installed = await $.fs
    .read(`${config}/plugins/installed_plugins.json`)
    .then(text => JSON.parse(text) as Installed)
    .catch(() => ({}) as Installed)

  for (const [key, installs] of Object.entries(installed.plugins ?? {})) {
    const plugin = key.split('@')[0] ?? key
    const root = installs[0]?.installPath

    if (root !== undefined) {
      for (const name of await foldersIn($, `${root}/skills`)) {
        names.add(`${plugin}:${name}`)
      }
    }
  }

  return names
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

const choiceOf = (one: CommandInfo, project: Set<string>): Choice => ({
  name: one.name,
  description: one.description,
  source: sourceOf(one, project),
})

const usedOf = async ($: EngineInterface) =>
  ((await $.store.get(USED_KEY)) ?? {}) as Record<string, number>

// The most recently used come first, the rest by name, so the cap drops the ones not used.
const ranked = (list: readonly Choice[], used: Record<string, number>) =>
  [...list].sort((a, b) => (used[b.name] ?? 0) - (used[a.name] ?? 0) || byName(a, b))

async function loadCommands($: EngineInterface) {
  const [list, names, project, used] = await Promise.all([
    $.command.list(),
    skillNames($),
    projectNames($),
    usedOf($),
  ])
  const choices = list.map(one => choiceOf(one, project))

  await update($, skills, () => ranked(choices.filter(one => names.has(one.name)), used))
  await update($, commands, () => ranked(choices.filter(one => !names.has(one.name)), used))
}

// A list stored by 0.1.0 has no source until the next turn loads the commands again.
const sourcesOf = (...lists: (readonly Choice[])[]) =>
  [...new Set(lists.flat().flatMap(one => (typeof one.source === 'string' ? [one.source] : [])))]
    .sort((a, b) => a.localeCompare(b))
    .slice(0, MAX_CHOICES)

const inSource = (list: readonly Choice[], from: string) =>
  list.filter(one => from === ALL || one.source === from).slice(0, MAX_CHOICES)

const pickIn = (list: readonly Choice[], value: string) => (list.some(one => one.name === value) ? value : NONE)

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
  const chosen = picked(await read($, command))
  const prefix =
    chosen !== undefined
      ? `/${chosen} `
      : [picked(await read($, skill)), picked(await read($, agent))]
          .map((one, index) => (one === undefined ? '' : index === 0 ? `/${one} ` : `@agent-${one} `))
          .join('')

  if (prefix === '') {
    $.ui.toast('Pick an agent, a skill or a command first.')

    return
  }

  const { text } = await $.prompt.read()
  await $.prompt.fill({ text: text.startsWith(prefix) ? text : prefix + text })
}

async function run($: EngineInterface) {
  const chosen = picked(await read($, command))

  if (chosen !== undefined) {
    await update($, command, () => NONE)
    await $.command.run({ command: chosen })

    return
  }

  const type = picked(await read($, agent))
  const withSkill = picked(await read($, skill))

  if (type === undefined && withSkill === undefined) {
    $.ui.toast('Pick an agent, a skill or a command first.')

    return
  }

  const task = (await $.prompt.read()).text.trim()

  if (type === undefined && withSkill !== undefined) {
    await $.prompt.fill({ text: '' })
    await $.command.run({ command: withSkill, args: task })

    return
  }

  if (task === '') {
    $.ui.toast(`Type the task for ${type} into the prompt first.`)

    return
  }

  const spawned = await $.agent.spawn({
    prompt: withSkill === undefined ? task : `Use the ${withSkill} skill. ${task}`,
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
  const [agentList, skillList, commandList] = await Promise.all([
    read($, agents),
    read($, skills),
    read($, commands),
  ])
  await update($, source, () => value)
  await update($, agent, current => pickIn(inSource(agentList, value), current))
  await update($, skill, current => pickIn(inSource(skillList, value), current))
  await update($, command, current => pickIn(inSource(commandList, value), current))
}

// The prompt takes one slash command, so a command and a skill or agent pick never stand together.
async function pickCommand($: EngineInterface, value: string) {
  await update($, command, () => value)

  if (value !== NONE) {
    await update($, agent, () => NONE)
    await update($, skill, () => NONE)
  }
}

async function pickAgent($: EngineInterface, value: string) {
  await update($, agent, () => value)

  if (value !== NONE) {
    await update($, command, () => NONE)
  }
}

async function pickSkill($: EngineInterface, value: string) {
  await update($, skill, () => value)

  if (value !== NONE) {
    await update($, command, () => NONE)
  }
}

const optionsOf = (list: readonly Choice[]) => [
  { value: NONE, label: '–' },
  ...list.map(one => ({ value: one.name })),
]

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await Promise.all([loadAgents($), loadCommands($)])

    return result
  })

  // Plugins and skills can change between turns, so the lists follow without a restart.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    await loadCommands($)

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
    const [agentList, skillList, commandList] = await Promise.all([
      read($, agents),
      read($, skills),
      read($, commands),
    ])
    const [agentValue, skillValue, commandValue, sourceValue] = await Promise.all([
      read($, agent),
      read($, skill),
      read($, command),
      read($, source),
    ])
    const sources = sourcesOf(agentList, skillList, commandList)
    const from = sources.includes(sourceValue) ? sourceValue : ALL
    const agentsShown = inSource(agentList, from)
    const skillsShown = inSource(skillList, from)
    const commandsShown = inSource(commandList, from)

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
            key="skill"
            label="Skill"
            options={optionsOf(skillsShown)}
            value={pickIn(skillsShown, skillValue)}
            onSelect={value => void pickSkill($, value)}
          />
          <Select
            key="command"
            label="Command"
            options={optionsOf(commandsShown)}
            value={pickIn(commandsShown, commandValue)}
            onSelect={value => void pickCommand($, value)}
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
