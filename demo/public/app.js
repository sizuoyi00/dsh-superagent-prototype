(() => {
  'use strict';

  const ROUTES = Object.freeze({
    state: '/api/state',
    doctor: '/api/doctor',
    reset: '/api/reset',
    issue: '/api/issue',
    run: '/api/run',
    followUp: '/api/follow-up',
    recover: '/api/recover',
    merge: '/api/merge',
  });

  const DEFAULT_ISSUE = Object.freeze({
    title: 'Fix the 100 percent discount boundary',
    requester: 'demo-user',
    text: 'A 100 percent discount should produce a zero total.',
  });
  const DEFAULT_FOLLOW_UP = Object.freeze({
    requester: 'demo-reviewer',
    text: 'Reject non-finite inputs and document the boundary.',
  });
  const PHASE_LABELS = Object.freeze({
    ready: 'READY / INTAKE',
    queued: 'QUEUED / ASSIGNED',
    running: 'RUNNING / WORKER',
    awaiting_review: 'AWAITING / REVIEW',
    failed: 'FAILED / VISIBLE',
    merged: 'ENDED / MERGED',
  });
  const EVENT_LABELS = Object.freeze({
    'issue.received': '收到本地 Issue',
    'eval.accepted': 'Eval 接受请求',
    'decision.accepted': 'Decision 授权执行',
    'mandate.created': '创建 Mandate',
    'ticket.queued': 'Ticket 进入队列',
    'assignment.started': 'Worker 开始 assignment',
    'assignment.completed': 'Worker 完成并提交证据',
    'follow-up.received': 'PR thread 收到跟进',
    'state.recovered': '从持久化状态恢复',
    'assignment.failed': 'Assignment 失败并上报',
    'ticket.merged': 'Ticket 合并并结束',
  });
  const TICKET_STATUSES = Object.freeze([
    'queued', 'running', 'awaiting_review', 'failed', 'ended',
  ]);
  const CHECK_STATUSES = Object.freeze(['ready', 'blocked']);

  const elements = Object.freeze({
    main: document.querySelector('main'),
    headerPhase: document.querySelector('#header-phase'),
    currentPhase: document.querySelector('#current-phase'),
    actionDescription: document.querySelector('#action-description'),
    issueText: document.querySelector('#issue-text'),
    guidedButton: document.querySelector('#guided-action-button'),
    ticketStatus: document.querySelector('#ticket-status'),
    ticketId: document.querySelector('#ticket-id'),
    workerSlot: document.querySelector('#worker-slot'),
    ticketSession: document.querySelector('#ticket-session'),
    ticketBranch: document.querySelector('#ticket-branch'),
    ticketCommits: document.querySelector('#ticket-commits'),
    ticketTests: document.querySelector('#ticket-tests'),
    commitList: document.querySelector('#commit-list'),
    timelineCount: document.querySelector('#timeline-count'),
    timelineList: document.querySelector('#timeline-list'),
    patchMeta: document.querySelector('#patch-meta'),
    patchOutput: document.querySelector('#patch-output'),
    doctorStatus: document.querySelector('#doctor-status'),
    doctorChecks: document.querySelector('#doctor-checks'),
    doctorBlockers: document.querySelector('#doctor-blockers'),
    operationStatus: document.querySelector('#operation-status'),
    doctorButton: document.querySelector('#doctor-refresh-button'),
    resetButton: document.querySelector('#reset-button'),
    pipelineStages: [...document.querySelectorAll('.pipeline > li')],
  });

  class ApiError extends Error {
    constructor(code, message, status) {
      super(message);
      this.name = 'ApiError';
      this.code = code;
      this.status = status;
    }
  }

  let appState = null;
  let doctorState = null;
  let busy = false;

  function text(value, fallback = '—') {
    if (value === null || value === undefined || value === '') return fallback;
    return String(value);
  }

  function allowedStatus(value, allowedValues, fallback) {
    return allowedValues.includes(value) ? value : fallback;
  }

  function latestTicket(state) {
    return state?.tickets?.at(-1) ?? null;
  }

  function latestResult(state) {
    return [...(state?.assignments ?? [])]
      .reverse()
      .find((assignment) => assignment?.result)?.result ?? null;
  }

  function hasRecovery(state) {
    return (state?.timeline ?? []).some((event) => event.type === 'state.recovered');
  }

  function issuePayload() {
    const operatorText = elements.issueText.value.trim();
    return {
      ...DEFAULT_ISSUE,
      text: operatorText || DEFAULT_ISSUE.text,
    };
  }

  function deriveAction(state) {
    if (!state) {
      return Object.freeze({
        label: '状态不可用',
        description: '无法读取本地状态，请检查下方错误。',
        disabled: true,
      });
    }

    const ticket = latestTicket(state);
    const commitCount = ticket?.commits?.length ?? 0;

    if (!state.repository?.initialCommit) {
      return Object.freeze({
        label: '初始化本地实战仓库',
        description: '创建隔离 repository 与基线 commit，准备真实 Git 执行环境。',
        route: ROUTES.reset,
        success: '本地实战仓库已初始化，可以接收 Issue。',
      });
    }
    if (ticket?.status === 'ended' || state.phase === 'merged') {
      return Object.freeze({
        label: '开始新一轮演示',
        description: '当前 Ticket 已结束。重建本地 runtime，开始一条全新控制链。',
        route: ROUTES.reset,
        success: '新一轮本地演示已就绪。',
      });
    }
    if (state.phase === 'ready') {
      return Object.freeze({
        label: '接收 Issue → 生成 Ticket',
        description: '把显式请求评估为 Mandate，并建立可追踪 Ticket。',
        route: ROUTES.issue,
        body: issuePayload,
        success: 'Issue 已接收，Ticket 已排队。',
      });
    }
    if (state.phase === 'queued') {
      const isFollowUp = commitCount > 0;
      return Object.freeze({
        label: isFollowUp ? '运行跟进 Worker' : '运行 Worker：RED → GREEN',
        description: isFollowUp
          ? '沿同一 Session 与 branch 执行 review 跟进，并新增 commit。'
          : '先写回归测试确认 RED，再修复实现、确认 GREEN 并提交。',
        route: ROUTES.run,
        success: isFollowUp
          ? '跟进 assignment 完成，第二个 commit 已写入。'
          : '初始 assignment 完成，真实测试与 commit 已记录。',
      });
    }
    if (state.phase === 'awaiting_review' && commitCount === 1) {
      return Object.freeze({
        label: '注入 PR Review 跟进',
        description: '模拟订阅 thread 的新反馈；Ticket、Session 和 branch 保持不变。',
        route: ROUTES.followUp,
        body: () => DEFAULT_FOLLOW_UP,
        success: 'Review 跟进已归属到原 Ticket。',
      });
    }
    if (
      state.phase === 'awaiting_review' &&
      commitCount >= 2 &&
      !hasRecovery(state)
    ) {
      return Object.freeze({
        label: '模拟重启 → 恢复状态',
        description: '从持久化 state 与 Git history 恢复，不重复执行已经完成的工作。',
        route: ROUTES.recover,
        success: '恢复事件已记录；commit 与 Ticket 身份保持稳定。',
      });
    }
    if (
      state.phase === 'awaiting_review' &&
      commitCount >= 2 &&
      hasRecovery(state)
    ) {
      return Object.freeze({
        label: '合并并结束 Ticket',
        description: '将本地 review 标记为通过，结束 Mandate 与 Ticket。',
        route: ROUTES.merge,
        success: 'Ticket 已合并并进入 ended 终态。',
      });
    }
    if (state.phase === 'failed') {
      return Object.freeze({
        label: '提交失败后的跟进',
        description: '失败保持可见；通过同一 thread 添加修正请求后重新排队。',
        route: ROUTES.followUp,
        body: () => DEFAULT_FOLLOW_UP,
        success: '失败跟进已排队，可以再次运行 Worker。',
      });
    }

    return Object.freeze({
      label: '等待当前操作',
      description: '控制面正在处理 assignment，请等待状态刷新。',
      disabled: true,
    });
  }

  async function requestJson(route, options = {}) {
    const method = options.method ?? 'GET';
    const requestOptions = { method };
    if (method !== 'GET') {
      requestOptions.headers = { 'content-type': 'application/json' };
      requestOptions.body = JSON.stringify(options.body ?? {});
    }

    const response = await fetch(route, requestOptions);
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new ApiError('INVALID_RESPONSE', '本地服务返回了无法解析的响应。', response.status);
    }
    if (!response.ok) {
      throw new ApiError(
        text(payload?.code, `HTTP_${response.status}`),
        text(payload?.error, '本地服务拒绝了操作。'),
        response.status,
      );
    }
    return payload;
  }

  function setOperationStatus(message, tone = 'neutral') {
    elements.operationStatus.textContent = message;
    elements.operationStatus.dataset.tone = tone;
  }

  function formatError(error) {
    const errorCode = error?.code ?? 'CLIENT_ERROR';
    const errorMessage = error?.message ?? '未知错误';
    return `[${errorCode}] ${errorMessage}`;
  }

  function phaseProgress(state) {
    if (!state?.repository?.initialCommit) return -1;
    if (state.phase === 'ready') return 0;
    if (state.phase === 'queued' || state.phase === 'running' || state.phase === 'failed') return 4;
    if (state.phase === 'awaiting_review') return 5;
    if (state.phase === 'merged') return 6;
    return -1;
  }

  function renderPipeline(state) {
    const progress = phaseProgress(state);
    elements.pipelineStages.forEach((stage, index) => {
      const isComplete = progress > index || (progress === 6 && index === 6);
      const isCurrent = progress === index && !(progress === 6 && index === 6);
      stage.classList.toggle('is-complete', isComplete);
      stage.classList.toggle('is-current', isCurrent);
      if (isCurrent) stage.setAttribute('aria-current', 'step');
      else stage.removeAttribute('aria-current');
      const stageName = stage.dataset.stage ?? `阶段 ${index + 1}`;
      const stageStatus = isComplete ? '已完成' : isCurrent ? '当前' : '等待中';
      stage.setAttribute('aria-label', `${stageName}，${stageStatus}`);
    });
  }

  function renderGuided(state) {
    const phase = PHASE_LABELS[state?.phase] ?? 'UNAVAILABLE';
    const action = deriveAction(state);
    elements.headerPhase.textContent = phase;
    elements.currentPhase.textContent = phase;
    elements.actionDescription.textContent = action.description;
    elements.guidedButton.textContent = busy ? '执行中…' : action.label;
    elements.guidedButton.disabled = busy || action.disabled === true;
    elements.issueText.disabled = busy || state?.phase !== 'ready';
  }

  function createListItem(primary, secondary, className) {
    const item = document.createElement('li');
    if (className) item.className = className;
    const mainText = document.createElement('span');
    mainText.textContent = primary;
    item.append(mainText);
    if (secondary) {
      const detail = document.createElement('small');
      detail.textContent = secondary;
      item.append(detail);
    }
    return item;
  }

  function renderTicket(state) {
    const ticket = latestTicket(state);
    const result = latestResult(state);
    const commits = ticket?.commits ?? [];
    const lastAssignment = state?.assignments?.at(-1);
    const workerSlotOccupied = ticket !== null && ticket.status !== 'ended';
    const ticketStatus = allowedStatus(ticket?.status, TICKET_STATUSES, 'empty');
    const testDataStatus = result?.tests?.ok
      ? 'pass'
      : lastAssignment?.status === 'failed' ? 'failed' : 'waiting';
    const testStatus = result?.tests?.ok
      ? `PASS · ${text(result.tests.command, 'TEST')}`
      : lastAssignment?.status === 'failed' ? 'FAILED' : 'WAITING';

    elements.ticketStatus.textContent = text(ticket?.status, 'NOT CREATED').toUpperCase();
    elements.ticketStatus.dataset.status = ticketStatus;
    elements.ticketId.textContent = text(ticket?.id);
    elements.workerSlot.textContent = workerSlotOccupied ? '1 / 1' : '0 / 1';
    elements.ticketSession.textContent = text(ticket?.sessionId);
    elements.ticketBranch.textContent = text(ticket?.branch);
    elements.ticketCommits.textContent = String(commits.length);
    elements.ticketTests.textContent = testStatus;
    elements.ticketTests.dataset.status = testDataStatus;

    const commitItems = commits.length > 0
      ? commits.map((commit) => createListItem(
        text(commit.hash).slice(0, 8),
        text(commit.message, '无提交说明'),
      ))
      : [createListItem('尚无 worker commit')];
    elements.commitList.replaceChildren(...commitItems);
  }

  function formatEventTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'LOCAL TIME';
    return new Intl.DateTimeFormat('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(date);
  }

  function renderTimeline(state) {
    const timeline = state?.timeline ?? [];
    elements.timelineCount.textContent = `${String(timeline.length).padStart(2, '0')} EVENTS`;
    if (timeline.length === 0) {
      elements.timelineList.replaceChildren(
        createListItem('等待第一个事件', '初始化后从 Issue 开始', 'timeline-list__empty'),
      );
      return;
    }

    const items = [...timeline].reverse().map((event) => {
      const item = document.createElement('li');
      const sequence = document.createElement('span');
      const content = document.createElement('div');
      const eventName = document.createElement('strong');
      const metadata = document.createElement('small');
      sequence.className = 'timeline-list__sequence';
      sequence.textContent = String(event.sequence).padStart(2, '0');
      eventName.textContent = EVENT_LABELS[event.type] ?? text(event.type, '未知事件');
      metadata.textContent = `${formatEventTime(event.at)} · ${text(event.ticketId, 'CONTROL')}`;
      content.append(eventName, metadata);
      item.append(sequence, content);
      return item;
    });
    elements.timelineList.replaceChildren(...items);
  }

  function renderPatch(state) {
    const result = latestResult(state);
    const patch = result?.patch ?? '';
    const files = result?.files ?? [];
    elements.patchOutput.textContent = patch || '# Worker 完成 assignment 后，这里显示真实 git diff。';
    elements.patchMeta.textContent = patch
      ? `${files.length} FILES · ${patch.split('\n').length} LINES`
      : 'NO DIFF';
  }

  function renderDoctor(doctor) {
    const checks = doctor?.checks ?? [];
    const blockers = doctor?.blockers ?? [];
    elements.doctorStatus.textContent = doctor?.ready ? 'PRODUCTION READY' : 'LOCAL ONLY';
    elements.doctorStatus.dataset.ready = doctor?.ready ? 'true' : 'false';

    const checkItems = checks.length > 0
      ? checks.map((check) => {
        const checkStatus = allowedStatus(check.status, CHECK_STATUSES, 'blocked');
        const item = createListItem(
          text(check.label, check.id),
          text(check.detail, '无详细信息'),
          `check-list__item check-list__item--${checkStatus}`,
        );
        const stateMark = document.createElement('b');
        stateMark.textContent = checkStatus.toUpperCase();
        item.prepend(stateMark);
        return item;
      })
      : [createListItem('没有可用检查结果')];
    elements.doctorChecks.replaceChildren(...checkItems);

    const blockerItems = blockers.length > 0
      ? blockers.map((blocker) => createListItem(
        typeof blocker === 'string'
          ? blocker
          : text(blocker.detail, blocker.label ?? blocker.id),
      ))
      : [createListItem('无阻塞项；可以配置生产 adapter。')];
    elements.doctorBlockers.replaceChildren(...blockerItems);
  }

  function renderState(state) {
    renderGuided(state);
    renderPipeline(state);
    renderTicket(state);
    renderTimeline(state);
    renderPatch(state);
  }

  function setBusy(nextBusy) {
    busy = nextBusy;
    elements.main.setAttribute('aria-busy', String(nextBusy));
    elements.resetButton.disabled = nextBusy;
    elements.doctorButton.disabled = nextBusy;
    renderGuided(appState);
  }

  async function refreshAll() {
    const [nextState, nextDoctor] = await Promise.all([
      requestJson(ROUTES.state),
      requestJson(ROUTES.doctor),
    ]);
    appState = nextState;
    doctorState = nextDoctor;
    renderState(appState);
    renderDoctor(doctorState);
  }

  async function performOperation(operation, successMessage) {
    if (busy) return;
    setBusy(true);
    setOperationStatus('操作执行中，请勿重复提交。', 'working');
    try {
      await operation();
      await refreshAll();
      setOperationStatus(successMessage, 'success');
    } catch (error) {
      try {
        await refreshAll();
      } catch {
        // 保留原始 API 错误；下一次刷新仍可重试读取状态。
      }
      setOperationStatus(formatError(error), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function runGuidedAction() {
    const action = deriveAction(appState);
    if (!action.route || action.disabled) return;
    await performOperation(
      () => requestJson(action.route, {
        method: 'POST',
        body: typeof action.body === 'function' ? action.body() : {},
      }),
      action.success,
    );
  }

  async function refreshDoctor() {
    await performOperation(async () => {
      const nextDoctor = await requestJson(ROUTES.doctor);
      doctorState = nextDoctor;
      renderDoctor(doctorState);
    }, 'Doctor 已刷新；检查过程不会修改本机配置。');
  }

  async function resetDemo() {
    const confirmed = window.confirm(
      '重置会重建 demo runtime 下的本地 repository。确认继续吗？',
    );
    if (!confirmed) {
      setOperationStatus('已取消重置；当前持久化状态保持不变。');
      return;
    }
    await performOperation(
      () => requestJson(ROUTES.reset, { method: 'POST', body: {} }),
      '本地演示已重置；已创建新的基线 commit。',
    );
  }

  elements.guidedButton.addEventListener('click', runGuidedAction);
  elements.doctorButton.addEventListener('click', refreshDoctor);
  elements.resetButton.addEventListener('click', resetDemo);

  async function initialize() {
    setBusy(true);
    try {
      await refreshAll();
      setOperationStatus('本地控制面已连接。使用“唯一下一步”推进演示。', 'success');
    } catch (error) {
      setOperationStatus(formatError(error), 'error');
    } finally {
      setBusy(false);
    }
  }

  void initialize();
})();
