/** The Manual Source: one request from the panel becomes a Trigger naming its project and role. */
import { describe, expect, it } from 'vitest'
import { manualTrigger, projectName } from '../src/sources/manual.ts'

const config = { projects: [{ path: '/home/sizuoyi/workspace/fs/fs-paas-ai' }, { path: '/w/x', name: 'Task' }] }

describe('a manual request', () => {
  it('names the finished project, else its directory, and carries the role and the project path', () => {
    const trigger = manualTrigger(config, { project: '/w/x', role: '开发', text: '加一个字段', at: new Date('2026-11-22T00:00:00Z') })
    expect(trigger.text).toBe('[开发] 项目：Task（/w/x）\n\n加一个字段')
    expect(trigger.meta).toEqual({ project: '/w/x', role: '开发' })
    expect(trigger.addressed).toBe('direct')
    expect(trigger.human).toBe(true)
  })
  it('gives each request its own thread and id, so two requests never share a ticket', () => {
    const at = new Date('2026-11-22T00:00:00Z')
    const first = manualTrigger(config, { project: '/w/x', role: '排查', text: '查日志', at })
    const second = manualTrigger(config, { project: '/w/x', role: '排查', text: '查配置', at })
    expect(first.id).not.toBe(second.id)
    expect(first.threads[0]).not.toEqual(second.threads[0])
  })
  it('falls back to the last path segment for a project without a name', () => {
    expect(projectName({ path: '/home/sizuoyi/workspace/fs/fs-paas-ai' })).toBe('fs-paas-ai')
  })
})
