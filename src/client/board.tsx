/** My work board: every Ticket in the column its stage puts it in, read-only and filtered by Source. */
import { useMemo, useState } from 'react'
import { usePoll, type TicketRow } from './api.ts'
import { Pill } from './controls.tsx'
import { usePanel } from './provider.tsx'
import { TicketLine } from './rows.tsx'
import { valueLabel } from './text.ts'
import { Hint, LoadState } from './widgets.tsx'

/** Columns in reading order; a Ticket's stage decides its column, so no Ticket is stored against one. */
export const BOARD_COLUMNS = ['person', 'working', 'review', 'blocked', 'ended'] as const
export type BoardColumn = typeof BOARD_COLUMNS[number]
/**
 * The column a Ticket belongs to. Waiting on a person splits by what it waits for: an answer, a review, or a
 * blocked/failed report that needs a retry. A Ticket that is open but not running, such as one waiting for its next
 * Trigger, stays in progress.
 */
export function boardColumn(ticket: TicketRow): BoardColumn {
  if (ticket.state === 'ended') return 'ended'
  if (ticket.stage !== 'person') return 'working'
  if (ticket.action === 'review') return 'review'
  if (ticket.action === 'blocked' || ticket.action === 'failed') return 'blocked'
  return 'person'
}

export function BoardPage() {
  const { t, call } = usePanel()
  const [source, setSource] = useState('')
  const open = usePoll(() => call('GET tickets', { query: { state: 'open', limit: 500 } }), [])
  const ended = usePoll(() => call('GET tickets', { query: { state: 'ended', limit: 50 } }), [])
  const tickets = useMemo(() => [...open.data?.items ?? [], ...ended.data?.items ?? []], [open.data, ended.data])
  const sources = useMemo(() => [...new Set(tickets.flatMap(ticket => ticket.threads.map(thread => thread.source)))].sort(), [tickets])
  const shown = source ? tickets.filter(ticket => ticket.threads.some(thread => thread.source === source)) : tickets
  const reload = open.reload
  return <>
    <div className="dt-row-meta"><span className="dt-hint">{t('board.intro')}</span></div>
    <div className="dt-filters">
      <Pill active={!source} onClick={() => setSource('')}>{t('boardSourceAll')}</Pill>
      {sources.map(id => <Pill key={id} active={source === id} onClick={() => setSource(id)}>{valueLabel(t, 'source', id)}</Pill>)}
    </div>
    <LoadState error={open.error ?? ended.error} loading={!open.data || !ended.data} />
    {open.data && ended.data && <div className="dt-board">
      {BOARD_COLUMNS.map(column => {
        const columnTickets = shown.filter(ticket => boardColumn(ticket) === column)
        return <section key={column} className="dt-board-column">
          <h3 className="dt-section-title"><span className="dt-section-name">{t(`board.${column}`)}</span>
            <span className="dt-count">{columnTickets.length}</span></h3>
          {columnTickets.length
            ? <ul className="dt-list">{columnTickets.map(ticket => <TicketLine key={ticket.id} ticket={ticket}
              question={column === 'person' || column === 'blocked'} onChanged={reload} />)}</ul>
            : <Hint>{t('boardEmpty')}</Hint>}
        </section>
      })}
    </div>}
  </>
}
