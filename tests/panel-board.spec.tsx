// @vitest-environment jsdom
// The My work board: each open Ticket in the column its stage puts it in, and the columns never moved by hand.
import { expect, it } from 'vitest'
import { zh } from '../src/client/locales.ts'
import { usePanel, mount, all, click, tab, text } from './fixtures/panel.tsx'
import { server, ticketSummary, threadSummary } from './fixtures/panel-server.ts'

usePanel()
it('puts every Ticket in the column of its stage, with a count per column', async () => {
  server.tickets.open = [
    ticketSummary({ id: 'a', title: '等我回答' }, { stage: 'person', action: 'answer' }),
    ticketSummary({ id: 'b', title: '正在执行' }, { stage: 'working' }),
    ticketSummary({ id: 'c', title: '等评审' }, { stage: 'person', action: 'review' }),
    ticketSummary({ id: 'd', title: '被阻塞' }, { stage: 'person', action: 'blocked' }),
  ]
  await mount()
  await click(tab(zh['tab.board']))
  expect(server.requests.some(request => request.path === 'tickets?state=open&limit=500')).toBe(true)
  expect(server.requests.some(request => request.path === 'tickets?state=ended&limit=50')).toBe(true)
  const columns = all('.dt-board-column')
  expect(columns.map(column => column.querySelector('.dt-section-name')?.textContent)).toEqual([
    zh['board.person'], zh['board.working'], zh['board.review'], zh['board.blocked'], zh['board.ended']])
  expect(columns.map(column => column.querySelector('.dt-count')?.textContent)).toEqual(['1', '1', '1', '1', '1'])
  expect(text()).toContain('等我回答')
  expect(text()).toContain('被阻塞')
})

it('filters the board by the Source a Ticket came from', async () => {
  server.tickets.open = [
    ticketSummary({ id: 'a', title: '来自定时', threads: [threadSummary({ key: 'schedule:schedule', source: 'schedule', title: '定时' })] },
      { stage: 'working' }),
    ticketSummary({ id: 'b', title: '来自 GitHub', threads: [threadSummary({ key: 'github:7', source: 'github', title: '#7' })] },
      { stage: 'working' }),
  ]
  await mount()
  await click(tab(zh['tab.board']))
  const scope = (label: string) => all('.dt-filters .dt-pill').find(pill => pill.textContent === label)!
  await click(scope('GitHub'))
  expect(text()).toContain('来自 GitHub')
  expect(text()).not.toContain('来自定时')
  await click(scope(zh.boardSourceAll))
  expect(text()).toContain('来自定时')
})
