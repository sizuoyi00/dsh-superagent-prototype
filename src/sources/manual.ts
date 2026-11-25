/** Manual Source: a person picks a local git project and a role in the panel, and the request enters like a message would. */
import { z } from 'zod'
import { key, type Trigger } from '../core/index.ts'
import type { VariableSpec } from './kind.ts'
import type { SourceKind } from './kind.ts'

export const SOURCE = 'manual'
const ConfigSchema = z.object({
  /** Local git projects a person can pick; each path is a repository working tree on this machine. */
  projects: z.array(z.object({ path: z.string().trim().min(1), name: z.string().trim().max(80).optional() }).strict()).default([]),
}).strict()
export type ManualConfig = z.infer<typeof ConfigSchema>

/** The role a manual request runs as; the orchestrator prefixes the ticket title with the same word. */
export const ROLES = ['开发', '排查', '测试', '发布'] as const
export type ManualRole = typeof ROLES[number]

/** A readable project name: the configured one, else its directory name. */
export const projectName = (project: { path: string; name?: string }): string => project.name || project.path.split('/').filter(Boolean).at(-1) || project.path

/** One manually created request: its text carries the project and the role, so the orchestrator can title the ticket. */
export function manualTrigger(config: ManualConfig, input: { project: string; role: ManualRole; text: string; at?: Date }): Trigger {
  const project = config.projects.find(item => item.path === input.project)
  const at = (input.at ?? new Date()).toISOString()
  const name = project ? projectName(project) : input.project
  // Every request is its own Thread, so a second request never becomes context on the first one's ticket.
  const id = key('manual', input.project, input.role, input.text, at)
  return { id, source: SOURCE, threads: [{ source: SOURCE, id: `${SOURCE}:${id}` }], actor: { source: SOURCE, id: 'operator' }, human: true, at,
    text: `[${input.role}] 项目：${name}（${input.project}）\n\n${input.text.trim()}`, addressed: 'direct',
    meta: { project: input.project, role: input.role } }
}

/** The environment a manual ticket's worker and prepare command read: the chosen project. */
const variables: readonly VariableSpec[] = [
  { key: 'DSH_MANUAL_PROJECT', description: { zh: '手动任务选中的本地 git 项目目录', en: 'The local git project the manual request chose' } },
]

export const manualKind: SourceKind<ManualConfig> = {
  kind: SOURCE,
  title: { zh: '手动', en: 'Manual' },
  description: { zh: '在面板上选一个本地 git 项目、一个角色，写下任务；像一条人发的消息那样被评估和执行。',
    en: 'Pick a local git project and a role in the panel, write the task, and it is assessed and executed like a message.' },
  schema: ConfigSchema,
  fields: [
    { key: 'projects', type: 'rows', label: { zh: '可选的本地项目', en: 'Local projects to choose from' },
      hint: { zh: '每一项是一个本机上的 git 工作树目录；面板的手动任务表单只列出这里配置的项目。',
        en: 'Each entry is a git working tree on this machine; the manual request form lists only these.' },
      columns: [
        { key: 'path', type: 'text', label: { zh: '目录', en: 'Path' }, pattern: '.+' },
        { key: 'name', type: 'text', label: { zh: '显示名', en: 'Name' }, optional: true },
      ] },
  ],
  health: ['manual'],
  policy: {
    schema: z.object({
      allowed: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_.@-]{1,64}$/), name: z.string().trim().max(100).optional() }).strict())
        .refine(accounts => new Set(accounts.map(account => account.id)).size === accounts.length, 'Duplicate accounts').default([]),
    }).strict(),
    fields: [
      { key: 'allowed', type: 'rows', label: { zh: '能创建手动任务的人', en: 'People who may create manual requests' },
        hint: { zh: '面板上的手动任务以本机运营者名义提出，这里给出它的名单。',
          en: 'A manual request asks in the local operator’s name; this list names who may do so.' },
        columns: [
          { key: 'id', type: 'text', label: { zh: '账户', en: 'Account' }, pattern: '[A-Za-z0-9_.@-]{1,64}' },
          { key: 'name', type: 'text', label: { zh: '名称', en: 'Name' }, optional: true },
        ] },
    ],
    explicit: { zh: '手动任务由本机运营者在面板上创建，直接作为明确请求交给智能体。',
      en: 'A manual request is created by the local operator in the panel and enters the agent as an explicit request.' },
    unnamed: { person: { zh: '账户', en: 'Account' }, bot: { zh: '机器人', en: 'Bot' } },
  },
  environment: { variables, values: context => ({ DSH_MANUAL_PROJECT: String(context.trigger?.meta.project ?? '') }) },
}

export const name = 'dsh-superagent-manual'
