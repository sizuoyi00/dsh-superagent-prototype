/** A ticket's workspace folder follows the role prefix the orchestrator puts on its title. */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { roleFolder } from '../src/executor/dsh.ts'

describe('the workspace folder of a role', () => {
  it('reads the prefix in either language, and leaves an unprefixed title at the root', () => {
    expect(roleFolder('[排查] 查 AI Engine 昨日错误')).toBe('troubleshoot')
    expect(roleFolder('[开发] 修登录超时')).toBe('dev')
    expect(roleFolder('[测试] 验证发布闭环')).toBe('qa')
    expect(roleFolder('[发布] 发 fstest02')).toBe('release')
    expect(roleFolder('[troubleshoot] check logs')).toBe('troubleshoot')
    expect(roleFolder('查 AI Engine 昨日错误')).toBeUndefined()
    expect(roleFolder('[别的] 前缀')).toBeUndefined()
  })
  it('joins the folder under the execution root, keeping the ticket name and id', () => {
    const root = '/srv/work'
    const name = 'ai-engine-log-8fe137c9cdef'
    const directory = (title: string) => { const folder = roleFolder(title); return join(root, ...(folder ? [folder] : []), name) }
    expect(directory('[排查] x')).toBe('/srv/work/troubleshoot/ai-engine-log-8fe137c9cdef')
    expect(directory('x')).toBe('/srv/work/ai-engine-log-8fe137c9def'.replace('8fe137c9def', '8fe137c9cdef'))
  })
})

/** A worker's DSH workspace is named after its ticket, so the sidebar reads as work rather than as directory ids. */
import { readFileSync } from 'node:fs'
import { expect as expectSource, it as itSource } from 'vitest'
itSource('passes the ticket title as the workspace title, and only for a worker', () => {
  const source = readFileSync(new URL('../src/app/sessions.ts', import.meta.url), 'utf8')
  expectSource(source).toContain("create(cwd, role === 'worker' ? workspaceTitle(cwd, title) : undefined)")
})

/** A worker workspace is titled by role and short name, so the sidebar groups by role and reads apart from the session. */
import { expect as expectTitle, it as itTitle } from 'vitest'
import { workspaceTitle } from '../src/app/sessions.ts'
itTitle('titles a worker workspace with its role and the directory without the ticket id', () => {
  expectTitle(workspaceTitle('/srv/work/troubleshoot/ai-task-log-week-1c70ca7f5677', '[排查] 查 AI Task 近一周错误')).toBe('排查 · ai-task-log-week')
  expectTitle(workspaceTitle('/srv/work/ai-provider-log-week-cb9e2f6b5f95', '查 Provider 周报')).toBe('ai-provider-log-week')
  expectTitle(workspaceTitle('/srv/work/dev/login-fix-abcdefabcdef', '[开发] 修登录')).toBe('开发 · login-fix')
})
