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
  expectSource(source).toContain("create(cwd, role === 'worker' ? title : undefined)")
})
