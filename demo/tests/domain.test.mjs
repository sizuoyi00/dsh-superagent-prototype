import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  ConflictError,
  completeAssignment,
  createState,
  failAssignment,
  mergeTicket,
  receiveFollowUp,
  receiveIssue,
  recoverState,
  startAssignment,
} from '../src/domain.mjs'

const issue = {
  author: 'alice',
  body: 'A 100% discount should return zero.',
  number: 42,
  receivedAt: '2026-11-03T01:00:00.000Z',
  title: 'Fix the discount boundary',
  url: 'https://example.test/issues/42',
}

const firstResult = {
  branch: 'agent/demo-discount-boundary',
  commit: {
    sha: '1111111',
    subject: 'fix: handle a 100% discount',
  },
  completedAt: '2026-11-03T01:02:00.000Z',
  files: ['src/discount.mjs', 'test/discount.test.mjs'],
  patch: 'demo patch',
  pullRequest: {
    number: 1,
    title: 'Fix the discount boundary',
    url: 'http://127.0.0.1/local-pr/1',
  },
  tests: {
    passed: true,
    summary: '2 tests passed',
  },
}

const followUpResult = {
  branch: 'agent/demo-discount-boundary',
  commit: {
    sha: '2222222',
    subject: 'fix: reject non-finite discounts',
  },
  completedAt: '2026-11-03T01:05:00.000Z',
  files: ['src/discount.mjs', 'test/discount.test.mjs'],
  patch: 'follow-up patch',
  tests: {
    passed: true,
    summary: '4 tests passed',
  },
}

function createAwaitingReviewState() {
  const queued = receiveIssue(createState(), issue)
  const running = startAssignment(queued, {
    startedAt: '2026-11-03T01:01:00.000Z',
  })
  return completeAssignment(running, firstResult)
}

describe('lifecycle intake', () => {
  it('creates an empty ready state', () => {
    const state = createState()

    assert.equal(state.phase, 'ready')
    assert.equal(state.source.kind, 'local')
    assert.deepEqual(state.triggers, [])
    assert.deepEqual(state.evals, [])
    assert.deepEqual(state.decisions, [])
    assert.deepEqual(state.mandates, [])
    assert.deepEqual(state.tickets, [])
    assert.deepEqual(state.assignments, [])
    assert.deepEqual(state.reports, [])
    assert.deepEqual(state.threads, [])
    assert.deepEqual(state.timeline, [])
  })

  it('accepts an explicit Issue into one queued Ticket without changing the ready state', () => {
    const ready = createState()
    const readySnapshot = structuredClone(ready)
    const issueInput = structuredClone(issue)

    const queued = receiveIssue(ready, issueInput)
    issueInput.body = 'changed after intake'

    assert.deepEqual(ready, readySnapshot)
    assert.notStrictEqual(queued, ready)
    assert.equal(queued.phase, 'queued')
    assert.equal(queued.triggers.length, 1)
    assert.equal(queued.evals.length, 1)
    assert.equal(queued.decisions.length, 1)
    assert.equal(queued.mandates.length, 1)
    assert.equal(queued.tickets.length, 1)
    assert.equal(queued.threads.length, 1)

    const [trigger] = queued.triggers
    const [evaluation] = queued.evals
    const [decision] = queued.decisions
    const [mandate] = queued.mandates
    const [ticket] = queued.tickets
    const [thread] = queued.threads

    assert.equal(trigger.kind, 'issue')
    assert.equal(trigger.explicit, true)
    assert.equal(trigger.title, issue.title)
    assert.equal(trigger.body, issue.body)
    assert.equal(evaluation.kind, 'explicit')
    assert.equal(evaluation.status, 'accepted')
    assert.equal(evaluation.triggerId, trigger.id)
    assert.equal(decision.action, 'accept')
    assert.equal(decision.evalId, evaluation.id)
    assert.equal(mandate.decisionId, decision.id)
    assert.equal(mandate.status, 'active')
    assert.equal(ticket.mandateId, mandate.id)
    assert.equal(ticket.status, 'queued')
    assert.deepEqual(ticket.triggerIds, [trigger.id])
    assert.deepEqual(ticket.threadIds, [thread.id])
    assert.equal(thread.kind, 'issue')
    assert.equal(thread.subscribed, true)
    assert.deepEqual(thread.ticketIds, [ticket.id])
    assert.deepEqual(queued.timeline.map((event) => event.sequence), [1, 2, 3, 4, 5])
    assert.deepEqual(queued.timeline.map((event) => event.type), [
      'issue.received',
      'eval.accepted',
      'decision.accepted',
      'mandate.created',
      'ticket.queued',
    ])
    assert.equal(Object.isFrozen(queued), true)
  })

  it('rejects a second Issue with a typed conflict', () => {
    const queued = receiveIssue(createState(), issue)

    assert.throws(
      () => receiveIssue(queued, issue),
      (error) => error instanceof ConflictError
        && error.code === 'CONFLICT'
        && error.phase === 'queued'
        && error.action === 'receiveIssue',
    )
  })

  it('rejects an Issue without a non-empty title', () => {
    assert.throws(
      () => receiveIssue(createState(), { title: '   ' }),
      (error) => error instanceof TypeError && /issue\.title/.test(error.message),
    )
  })
})

describe('assignment lifecycle', () => {
  it('starts queued work without changing the queued state', () => {
    const queued = receiveIssue(createState(), issue)
    const queuedSnapshot = structuredClone(queued)

    const running = startAssignment(queued, {
      startedAt: '2026-11-03T01:01:00.000Z',
    })

    assert.deepEqual(queued, queuedSnapshot)
    assert.equal(running.phase, 'running')
    assert.equal(running.tickets.length, 1)
    assert.equal(running.tickets[0].id, queued.tickets[0].id)
    assert.equal(running.tickets[0].status, 'running')
    assert.deepEqual(running.tickets[0].assignmentIds, ['assignment-1'])
    assert.equal(running.assignments.length, 1)
    assert.equal(running.assignments[0].status, 'running')
    assert.equal(running.assignments[0].kind, 'initial')
    assert.equal(running.assignments[0].ticketId, queued.tickets[0].id)
    assert.equal(running.assignments[0].branch, queued.tickets[0].branch)
    assert.equal(running.assignments[0].sessionId, queued.tickets[0].sessionId)
    assert.equal(running.timeline.at(-1).sequence, 6)
    assert.equal(running.timeline.at(-1).type, 'assignment.started')
  })

  it('rejects starting work outside the queued phase', () => {
    assert.throws(
      () => startAssignment(createState()),
      (error) => error instanceof ConflictError && error.action === 'startAssignment',
    )
  })

  it('completes running work into an awaiting-review Ticket and subscribed PR Thread', () => {
    const running = startAssignment(receiveIssue(createState(), issue), {
      startedAt: '2026-11-03T01:01:00.000Z',
    })
    const runningSnapshot = structuredClone(running)
    const resultInput = structuredClone(firstResult)

    const awaitingReview = completeAssignment(running, resultInput)
    resultInput.patch = 'changed after completion'

    assert.deepEqual(running, runningSnapshot)
    assert.equal(awaitingReview.phase, 'awaiting_review')
    assert.equal(awaitingReview.tickets[0].status, 'awaiting_review')
    assert.deepEqual(awaitingReview.tickets[0].commits, [firstResult.commit])
    assert.equal(awaitingReview.assignments[0].status, 'completed')
    assert.equal(awaitingReview.assignments[0].result.patch, firstResult.patch)
    assert.equal(awaitingReview.threads.length, 2)
    assert.equal(awaitingReview.threads[1].kind, 'pull-request')
    assert.equal(awaitingReview.threads[1].subscribed, true)
    assert.deepEqual(awaitingReview.threads[1].ticketIds, [awaitingReview.tickets[0].id])
    assert.deepEqual(awaitingReview.tickets[0].threadIds, ['thread-1', 'thread-2'])
    assert.equal(awaitingReview.timeline.at(-1).type, 'assignment.completed')
  })

  it('rejects completing work unless an assignment is running', () => {
    const queued = receiveIssue(createState(), issue)

    assert.throws(
      () => completeAssignment(queued, firstResult),
      (error) => error instanceof ConflictError && error.action === 'completeAssignment',
    )
  })
})

describe('follow-up ownership', () => {
  it('queues a human follow-up on the same Ticket, branch, Session, and PR Thread', () => {
    const awaitingReview = createAwaitingReviewState()
    const awaitingReviewSnapshot = structuredClone(awaitingReview)
    const originalTicket = awaitingReview.tickets[0]
    const pullRequestThread = awaitingReview.threads[1]

    const queued = receiveFollowUp(awaitingReview, {
      author: 'bob',
      receivedAt: '2026-11-03T01:03:00.000Z',
      text: 'Please reject non-finite discount inputs too.',
      threadId: pullRequestThread.id,
    })

    assert.deepEqual(awaitingReview, awaitingReviewSnapshot)
    assert.equal(queued.phase, 'queued')
    assert.equal(queued.tickets.length, 1)
    assert.equal(queued.tickets[0].id, originalTicket.id)
    assert.equal(queued.tickets[0].branch, originalTicket.branch)
    assert.equal(queued.tickets[0].sessionId, originalTicket.sessionId)
    assert.equal(queued.threads.length, awaitingReview.threads.length)
    assert.equal(queued.threads[1].id, pullRequestThread.id)
    assert.equal(queued.assignments.length, 1)
    assert.equal(queued.evals.length, 1)
    assert.equal(queued.decisions.length, 1)
    assert.equal(queued.mandates.length, 1)
    assert.equal(queued.triggers.length, 2)
    assert.equal(queued.triggers[1].kind, 'follow-up')
    assert.equal(queued.triggers[1].threadId, pullRequestThread.id)
    assert.equal(queued.triggers[1].ownedByTicketId, originalTicket.id)
    assert.deepEqual(queued.tickets[0].triggerIds, ['trigger-1', 'trigger-2'])
    assert.equal(queued.timeline.at(-1).type, 'follow-up.received')

    const running = startAssignment(queued, {
      startedAt: '2026-11-03T01:04:00.000Z',
    })
    assert.equal(running.assignments[1].kind, 'follow-up')
    assert.equal(running.assignments[1].ticketId, originalTicket.id)
    assert.equal(running.assignments[1].branch, originalTicket.branch)
    assert.equal(running.assignments[1].sessionId, originalTicket.sessionId)
  })

  it('rejects follow-ups before a Ticket is awaiting review or failed', () => {
    assert.throws(
      () => receiveFollowUp(createState(), { text: 'too soon' }),
      (error) => error instanceof ConflictError && error.action === 'receiveFollowUp',
    )
  })

  it('rejects an empty follow-up at the domain boundary', () => {
    assert.throws(
      () => receiveFollowUp(createAwaitingReviewState(), { text: '  ' }),
      (error) => error instanceof TypeError && /followUp\.text/.test(error.message),
    )
  })
})

describe('durable recovery', () => {
  it('appends a recovery event without duplicating the Ticket or Assignment', () => {
    const awaitingReview = createAwaitingReviewState()
    const durableSnapshot = structuredClone(awaitingReview)
    const durableSnapshotBefore = structuredClone(durableSnapshot)

    const recovered = recoverState(durableSnapshot, {
      recoveredAt: '2026-11-03T01:05:00.000Z',
    })

    assert.deepEqual(durableSnapshot, durableSnapshotBefore)
    assert.equal(Object.isFrozen(durableSnapshot.tickets[0]), false)
    assert.notStrictEqual(recovered, durableSnapshot)
    assert.equal(recovered.phase, awaitingReview.phase)
    assert.deepEqual(
      recovered.tickets.map(({ id }) => id),
      awaitingReview.tickets.map(({ id }) => id),
    )
    assert.deepEqual(
      recovered.assignments.map(({ id }) => id),
      awaitingReview.assignments.map(({ id }) => id),
    )
    assert.equal(recovered.timeline.length, awaitingReview.timeline.length + 1)
    assert.equal(recovered.timeline.at(-1).type, 'state.recovered')
  })

  it('rejects recovery when there is no durable work', () => {
    assert.throws(
      () => recoverState(createState()),
      (error) => error instanceof ConflictError && error.action === 'recoverState',
    )
  })
})

describe('visible failure', () => {
  it('records a failed Assignment as a visible Report and permits same-Ticket follow-up', () => {
    const running = startAssignment(receiveIssue(createState(), issue), {
      startedAt: '2026-11-03T01:01:00.000Z',
    })
    const runningSnapshot = structuredClone(running)

    const failed = failAssignment(running, new Error('fixture tests failed'), {
      failedAt: '2026-11-03T01:02:00.000Z',
    })

    assert.deepEqual(running, runningSnapshot)
    assert.equal(failed.phase, 'failed')
    assert.equal(failed.tickets[0].status, 'failed')
    assert.equal(failed.assignments[0].status, 'failed')
    assert.equal(failed.assignments[0].error.message, 'fixture tests failed')
    assert.equal(failed.reports.length, 1)
    assert.equal(failed.reports[0].state, 'failed')
    assert.equal(failed.reports[0].visible, true)
    assert.equal(failed.reports[0].summary, 'fixture tests failed')
    assert.equal(failed.timeline.at(-1).type, 'assignment.failed')

    const queued = receiveFollowUp(failed, {
      author: 'alice',
      receivedAt: '2026-11-03T01:03:00.000Z',
      text: 'Retry with this additional detail.',
    })
    assert.equal(queued.phase, 'queued')
    assert.equal(queued.tickets.length, 1)
    assert.equal(queued.assignments.length, 1)
    assert.equal(queued.reports[0].state, 'failed')
  })

  it('rejects failure unless an assignment is running', () => {
    assert.throws(
      () => failAssignment(createState(), new Error('not running')),
      (error) => error instanceof ConflictError && error.action === 'failAssignment',
    )
  })
})

describe('Ticket completion', () => {
  it('ends the same Ticket after follow-up work is reviewed and merged', () => {
    const firstReview = createAwaitingReviewState()
    const queued = receiveFollowUp(firstReview, {
      author: 'bob',
      receivedAt: '2026-11-03T01:03:00.000Z',
      text: 'Please reject non-finite discount inputs too.',
    })
    const running = startAssignment(queued, {
      startedAt: '2026-11-03T01:04:00.000Z',
    })
    const secondReview = completeAssignment(running, followUpResult)

    assert.equal(secondReview.tickets.length, 1)
    assert.equal(secondReview.assignments.length, 2)
    assert.equal(secondReview.threads.length, 2)
    assert.equal(secondReview.threads[1].id, firstReview.threads[1].id)
    assert.equal(secondReview.tickets[0].id, firstReview.tickets[0].id)
    assert.equal(secondReview.tickets[0].branch, firstReview.tickets[0].branch)
    assert.equal(secondReview.tickets[0].sessionId, firstReview.tickets[0].sessionId)
    assert.deepEqual(secondReview.tickets[0].commits, [
      firstResult.commit,
      followUpResult.commit,
    ])

    const reviewSnapshot = structuredClone(secondReview)
    const merged = mergeTicket(secondReview, {
      mergedAt: '2026-11-03T01:06:00.000Z',
    })

    assert.deepEqual(secondReview, reviewSnapshot)
    assert.equal(merged.phase, 'merged')
    assert.equal(merged.tickets.length, 1)
    assert.equal(merged.tickets[0].status, 'ended')
    assert.equal(merged.tickets[0].outcome, 'merged')
    assert.equal(merged.mandates[0].status, 'fulfilled')
    assert.equal(merged.timeline.at(-1).type, 'ticket.merged')
  })

  it('rejects merge until work is awaiting review', () => {
    const queued = receiveIssue(createState(), issue)

    assert.throws(
      () => mergeTicket(queued),
      (error) => error instanceof ConflictError && error.action === 'mergeTicket',
    )
  })
})

describe('boundary defaults', () => {
  it('uses safe defaults while preserving the lifecycle invariants', () => {
    const queued = receiveIssue(createState(), { title: '  Minimal issue  ' })
    assert.equal(queued.triggers[0].title, 'Minimal issue')
    assert.equal(queued.triggers[0].author, 'demo-user')
    assert.equal(queued.triggers[0].body, '')
    assert.equal(queued.threads[0].externalId, null)
    assert.equal(queued.threads[0].url, null)

    const running = startAssignment(queued)
    const firstReview = completeAssignment(running, {
      commits: [{ sha: '3333333', subject: 'test: grouped commits' }],
    })
    assert.equal(firstReview.threads[1].externalId, 'local-ticket-1')
    assert.equal(firstReview.threads[1].url, null)

    const followUpQueued = receiveFollowUp(firstReview, { text: '  retry  ' })
    assert.equal(followUpQueued.triggers[1].author, 'demo-reviewer')
    assert.equal(followUpQueued.triggers[1].body, 'retry')

    const followUpRunning = startAssignment(followUpQueued)
    const secondReview = completeAssignment(followUpRunning)
    assert.equal(secondReview.threads.length, 2)
    assert.equal(secondReview.tickets[0].commits.length, 1)

    const recovered = recoverState(secondReview)
    const merged = mergeTicket(recovered)
    assert.equal(merged.tickets[0].outcome, 'merged')
  })

  it('normalizes string, structured, and empty failures without exposing stacks', () => {
    const running = startAssignment(receiveIssue(createState(), issue))

    const fromString = failAssignment(running, 'worker stopped')
    assert.deepEqual(fromString.assignments[0].error, {
      name: 'Error',
      message: 'worker stopped',
    })

    const fromObject = failAssignment(running, {
      code: 7,
      message: 'worker exited',
      name: 'WorkerError',
      stack: 'must not persist',
    })
    assert.deepEqual(fromObject.assignments[0].error, {
      name: 'WorkerError',
      message: 'worker exited',
      code: '7',
    })

    const fromEmpty = failAssignment(running)
    assert.deepEqual(fromEmpty.assignments[0].error, {
      name: 'Error',
      message: 'Assignment failed',
    })
  })

  it('rejects a follow-up for a Thread that does not own the Ticket', () => {
    assert.throws(
      () => receiveFollowUp(createAwaitingReviewState(), {
        text: 'wrong thread',
        threadId: 'thread-missing',
      }),
      /follow-up thread must be subscribed/,
    )
  })
})
