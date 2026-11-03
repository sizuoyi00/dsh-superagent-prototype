const SCHEMA_VERSION = 1

export class ConflictError extends Error {
  constructor(action, phase, allowedPhases) {
    super(`${action} is not allowed while the lifecycle is ${phase}`)
    this.name = 'ConflictError'
    this.code = 'CONFLICT'
    this.action = action
    this.phase = phase
    this.allowedPhases = [...allowedPhases]
  }
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
    return value
  }

  for (const child of Object.values(value)) {
    deepFreeze(child)
  }

  return Object.freeze(value)
}

function clone(value) {
  return structuredClone(value)
}

function finalize(value) {
  return deepFreeze(clone(value))
}

function assertPhase(state, action, allowedPhases) {
  if (!allowedPhases.includes(state.phase)) {
    throw new ConflictError(action, state.phase, allowedPhases)
  }
}

function requiredString(value, fieldName) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${fieldName} must be a non-empty string`)
  }
  return value.trim()
}

function appendEvent(state, type, at, details = {}) {
  const sequence = state.timeline.length + 1
  return [
    ...state.timeline,
    {
      id: `event-${sequence}`,
      sequence,
      type,
      at,
      ...details,
    },
  ]
}

function normalizeFailure(failureInput) {
  const message = failureInput instanceof Error
    ? failureInput.message
    : typeof failureInput === 'string'
      ? failureInput
      : failureInput?.message

  return {
    name: failureInput instanceof Error
      ? failureInput.name
      : failureInput?.name ?? 'Error',
    message: typeof message === 'string' && message.length > 0
      ? message
      : 'Assignment failed',
    ...(failureInput?.code ? { code: String(failureInput.code) } : {}),
  }
}

export function createState() {
  return finalize({
    schemaVersion: SCHEMA_VERSION,
    phase: 'ready',
    source: {
      id: 'source-local',
      kind: 'local',
      label: 'Local Issue simulator',
    },
    triggers: [],
    evals: [],
    decisions: [],
    mandates: [],
    tickets: [],
    assignments: [],
    reports: [],
    threads: [],
    timeline: [],
  })
}

export function receiveIssue(state, issueInput) {
  assertPhase(state, 'receiveIssue', ['ready'])
  const issue = clone(issueInput)
  const title = requiredString(issue?.title, 'issue.title')
  const at = issue?.receivedAt ?? new Date().toISOString()
  const thread = {
    id: 'thread-1',
    sourceId: state.source.id,
    kind: 'issue',
    externalId: issue.number ?? null,
    title,
    url: issue.url ?? null,
    subscribed: true,
    ticketIds: ['ticket-1'],
  }
  const trigger = {
    id: 'trigger-1',
    sourceId: state.source.id,
    threadId: thread.id,
    kind: 'issue',
    explicit: true,
    author: issue.author ?? 'demo-user',
    title,
    body: issue.body ?? '',
    receivedAt: at,
  }
  const evaluation = {
    id: 'eval-1',
    triggerId: trigger.id,
    kind: 'explicit',
    status: 'accepted',
    evaluatedAt: at,
  }
  const decision = {
    id: 'decision-1',
    triggerId: trigger.id,
    evalId: evaluation.id,
    action: 'accept',
    decidedAt: at,
  }
  const mandate = {
    id: 'mandate-1',
    triggerId: trigger.id,
    decisionId: decision.id,
    status: 'active',
    createdAt: at,
  }
  const ticket = {
    id: 'ticket-1',
    mandateId: mandate.id,
    status: 'queued',
    branch: 'agent/demo-discount-boundary',
    sessionId: 'session-1',
    triggerIds: [trigger.id],
    threadIds: [thread.id],
    assignmentIds: [],
    commits: [],
    createdAt: at,
  }
  const timelineTypes = [
    'issue.received',
    'eval.accepted',
    'decision.accepted',
    'mandate.created',
    'ticket.queued',
  ]

  return finalize({
    ...state,
    phase: 'queued',
    triggers: [trigger],
    evals: [evaluation],
    decisions: [decision],
    mandates: [mandate],
    tickets: [ticket],
    threads: [thread],
    timeline: timelineTypes.map((type, index) => ({
      id: `event-${index + 1}`,
      sequence: index + 1,
      type,
      at,
      ticketId: ticket.id,
    })),
  })
}

export function startAssignment(state, optionsInput = {}) {
  assertPhase(state, 'startAssignment', ['queued'])
  const options = clone(optionsInput)
  const at = options.startedAt ?? new Date().toISOString()
  const ticket = state.tickets.at(-1)
  const assignment = {
    id: `assignment-${state.assignments.length + 1}`,
    ticketId: ticket.id,
    triggerId: ticket.triggerIds.at(-1),
    kind: state.assignments.length === 0 ? 'initial' : 'follow-up',
    status: 'running',
    branch: ticket.branch,
    sessionId: ticket.sessionId,
    startedAt: at,
  }
  const runningTicket = {
    ...ticket,
    status: 'running',
    assignmentIds: [...ticket.assignmentIds, assignment.id],
  }

  return finalize({
    ...state,
    phase: 'running',
    tickets: state.tickets.map((candidate) => (
      candidate.id === ticket.id ? runningTicket : candidate
    )),
    assignments: [...state.assignments, assignment],
    timeline: appendEvent(state, 'assignment.started', at, {
      ticketId: ticket.id,
      assignmentId: assignment.id,
    }),
  })
}

export function completeAssignment(state, resultInput = {}) {
  assertPhase(state, 'completeAssignment', ['running'])
  const result = clone(resultInput)
  const at = result.completedAt ?? new Date().toISOString()
  const ticket = state.tickets.at(-1)
  const assignment = state.assignments.at(-1)
  const completedAssignment = {
    ...assignment,
    status: 'completed',
    completedAt: at,
    result,
  }
  const commits = result.commits
    ? [...ticket.commits, ...result.commits]
    : result.commit
      ? [...ticket.commits, result.commit]
      : [...ticket.commits]
  const existingPullRequestThread = state.threads.find((thread) => (
    thread.kind === 'pull-request' && thread.ticketIds.includes(ticket.id)
  ))
  const pullRequestThread = existingPullRequestThread ?? {
    id: `thread-${state.threads.length + 1}`,
    sourceId: state.source.id,
    kind: 'pull-request',
    externalId: result.pullRequest?.number ?? `local-${ticket.id}`,
    title: result.pullRequest?.title ?? `Local review for ${ticket.id}`,
    url: result.pullRequest?.url ?? null,
    subscribed: true,
    ticketIds: [ticket.id],
  }
  const reviewTicket = {
    ...ticket,
    status: 'awaiting_review',
    commits,
    threadIds: existingPullRequestThread
      ? [...ticket.threadIds]
      : [...ticket.threadIds, pullRequestThread.id],
  }

  return finalize({
    ...state,
    phase: 'awaiting_review',
    tickets: state.tickets.map((candidate) => (
      candidate.id === ticket.id ? reviewTicket : candidate
    )),
    assignments: state.assignments.map((candidate) => (
      candidate.id === assignment.id ? completedAssignment : candidate
    )),
    threads: existingPullRequestThread
      ? [...state.threads]
      : [...state.threads, pullRequestThread],
    timeline: appendEvent(state, 'assignment.completed', at, {
      ticketId: ticket.id,
      assignmentId: assignment.id,
    }),
  })
}

export function receiveFollowUp(state, followUpInput) {
  assertPhase(state, 'receiveFollowUp', ['awaiting_review', 'failed'])
  const followUp = clone(followUpInput)
  const text = requiredString(followUp?.text, 'followUp.text')
  const at = followUp?.receivedAt ?? new Date().toISOString()
  const ticket = state.tickets.at(-1)
  const defaultThread = [...state.threads].reverse().find((thread) => (
    thread.subscribed && thread.ticketIds.includes(ticket.id)
  ))
  const thread = followUp.threadId
    ? state.threads.find((candidate) => candidate.id === followUp.threadId)
    : defaultThread

  if (!thread?.subscribed || !thread.ticketIds.includes(ticket.id)) {
    throw new TypeError('follow-up thread must be subscribed to the active Ticket')
  }

  const trigger = {
    id: `trigger-${state.triggers.length + 1}`,
    sourceId: state.source.id,
    threadId: thread.id,
    kind: 'follow-up',
    explicit: true,
    author: followUp.author ?? 'demo-reviewer',
    body: text,
    ownedByTicketId: ticket.id,
    receivedAt: at,
  }
  const queuedTicket = {
    ...ticket,
    status: 'queued',
    triggerIds: [...ticket.triggerIds, trigger.id],
  }

  return finalize({
    ...state,
    phase: 'queued',
    triggers: [...state.triggers, trigger],
    tickets: state.tickets.map((candidate) => (
      candidate.id === ticket.id ? queuedTicket : candidate
    )),
    timeline: appendEvent(state, 'follow-up.received', at, {
      ticketId: ticket.id,
      triggerId: trigger.id,
      threadId: thread.id,
    }),
  })
}

export function recoverState(state, optionsInput = {}) {
  assertPhase(state, 'recoverState', [
    'queued',
    'running',
    'awaiting_review',
    'failed',
  ])
  const options = clone(optionsInput)
  const at = options.recoveredAt ?? new Date().toISOString()

  return finalize({
    ...state,
    timeline: appendEvent(state, 'state.recovered', at, {
      ticketId: state.tickets.at(-1).id,
    }),
  })
}

export function failAssignment(state, failureInput, optionsInput = {}) {
  assertPhase(state, 'failAssignment', ['running'])
  const failure = normalizeFailure(failureInput)
  const options = clone(optionsInput)
  const at = options.failedAt ?? new Date().toISOString()
  const ticket = state.tickets.at(-1)
  const assignment = state.assignments.at(-1)
  const failedAssignment = {
    ...assignment,
    status: 'failed',
    failedAt: at,
    error: failure,
  }
  const failedTicket = {
    ...ticket,
    status: 'failed',
  }
  const report = {
    id: `report-${state.reports.length + 1}`,
    ticketId: ticket.id,
    assignmentId: assignment.id,
    state: 'failed',
    summary: failure.message,
    visible: true,
    createdAt: at,
  }

  return finalize({
    ...state,
    phase: 'failed',
    tickets: state.tickets.map((candidate) => (
      candidate.id === ticket.id ? failedTicket : candidate
    )),
    assignments: state.assignments.map((candidate) => (
      candidate.id === assignment.id ? failedAssignment : candidate
    )),
    reports: [...state.reports, report],
    timeline: appendEvent(state, 'assignment.failed', at, {
      ticketId: ticket.id,
      assignmentId: assignment.id,
      reportId: report.id,
    }),
  })
}

export function mergeTicket(state, optionsInput = {}) {
  assertPhase(state, 'mergeTicket', ['awaiting_review'])
  const options = clone(optionsInput)
  const at = options.mergedAt ?? new Date().toISOString()
  const ticket = state.tickets.at(-1)
  const endedTicket = {
    ...ticket,
    status: 'ended',
    outcome: 'merged',
    endedAt: at,
  }

  return finalize({
    ...state,
    phase: 'merged',
    tickets: state.tickets.map((candidate) => (
      candidate.id === ticket.id ? endedTicket : candidate
    )),
    mandates: state.mandates.map((mandate) => (
      mandate.id === ticket.mandateId
        ? { ...mandate, status: 'fulfilled', fulfilledAt: at }
        : mandate
    )),
    timeline: appendEvent(state, 'ticket.merged', at, {
      ticketId: ticket.id,
    }),
  })
}
