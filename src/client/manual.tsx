/** Manual requests: pick a local project and a role, write the task, and it enters like a message would. */
import { useState } from 'react'
import { usePoll } from './api.ts'
import { usePanel } from './provider.tsx'
import { Hint } from './widgets.tsx'

/** The roles a manual request may run as; the ticket title carries the same word. */
const ROLES = ['开发', '排查', '测试', '发布'] as const

export function ManualPage() {
  const { t, call } = usePanel()
  const settings = usePoll(() => call('GET settings'), [])
  const [project, setProject] = useState('')
  const [role, setRole] = useState<string>('开发')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; message: string }>()
  const projects = (settings.data?.sources.find(source => source.id === 'manual')?.value.config.projects ?? []) as { path: string; name?: string }[]
  const label = (item: { path: string; name?: string }) => item.name || item.path.split('/').filter(Boolean).at(-1) || item.path
  const submit = async () => {
    setBusy(true)
    setResult(undefined)
    try {
      await call('POST manual/requests', { body: { project: project || projects[0]?.path || '', role, text } })
      setText('')
      setResult({ ok: true, message: t('manual.created') })
    } catch (error) {
      setResult({ ok: false, message: error instanceof Error ? error.message : String(error) })
    } finally { setBusy(false) }
  }
  if (!projects.length) return <Hint>{t('manual.noProjects')}</Hint>
  return <div className="dt-column">
    <h2 className="dt-section-title">{t('manual.title')}</h2>
    <Hint>{t('manual.intro')}</Hint>
    <div className="dt-fieldset">
      <div className="dt-field"><span className="dt-field-head"><label htmlFor="manual-project">{t('manual.project')}</label></span>
        <select id="manual-project" className="dt-select" value={project || projects[0]?.path}
          onChange={event => setProject(event.target.value)}>
          {projects.map(item => <option key={item.path} value={item.path}>{label(item)}</option>)}
        </select></div>
      <div className="dt-field"><span className="dt-field-head"><label htmlFor="manual-role">{t('manual.role')}</label></span>
        <select id="manual-role" className="dt-select" value={role} onChange={event => setRole(event.target.value)}>
          {ROLES.map(item => <option key={item} value={item}>{item}</option>)}
        </select></div>
      <div className="dt-field"><span className="dt-field-head"><label htmlFor="manual-text">{t('manual.text')}</label></span>
        <textarea id="manual-text" className="dt-textarea" rows={8} value={text} onChange={event => setText(event.target.value)} /></div>
      <div className="dt-actions">
        <button type="button" className="dt-btn dt-btn-primary" disabled={busy || !text.trim()} onClick={() => void submit()}>{t('manual.submit')}</button>
      </div>
    </div>
    {result && <p className={result.ok ? 'dt-hint' : 'dt-error'} role={result.ok ? undefined : 'alert'}>{result.message}</p>}
  </div>
}
