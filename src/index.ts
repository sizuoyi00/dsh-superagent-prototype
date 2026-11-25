/** Main plugin entry: mounts the Runtime and provides its restart callback for deployment account changes. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-settings'
import { Runtime } from './app/runtime.ts'
import { Config, machineOf, type DeploymentConfig } from './deployment.ts'

export const name = 'dsh-superagent'
export const inject = ['agents', 'sessionController', 'sessionPersistence', 'workspaceRegistry', 'permissionPresets', 'tools', 'systemPrompt', 'skills', 'webServer', 'llm', 'subprocess']
export { Config }
export async function apply(ctx: Context, config: DeploymentConfig): Promise<void> {
  const machine = machineOf(config)
  // The management panel provides its own settings UI, so disable DSH's auto-generated settings page.
  ctx.inject(['settings'], child => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
  // Volatile limits update in place without a restart; account changes restart dsh-superagent. DSH's settings service stops
  // serving this entry while dsh-superagent restarts and rereads it only on a configuration write, so trigger `describe()`
  // after restart to keep open configuration forms editable without a page reload.
  // TODO: drop the read once DSH's settings service rereads an entry whose plugin becomes active again.
  //
  // A restart replaces this plugin's tools and state, so it waits for the main Session's turn to end: restarting in the
  // middle of a turn unregisters the orchestrator_* tools that turn is calling, and cancelling the turn instead would
  // report "tool call aborted" for a restart the turn itself asked for. One restart is scheduled at a time.
  let restarting = false
  const restart = (): void => {
    if (restarting) return
    restarting = true
    const run = (): void => {
      ctx.fiber.restart().then(() => { ctx.get('settings')?.describe() })
        .catch((error: unknown) => { ctx.logger.error('dsh-superagent restart failed: %s', String(error)) })
        .finally(() => { restarting = false })
    }
    const master = ctx.agents.get(runtime.masterId as SessionId)
    if (master !== undefined && master.status === 'running') void master.whenIdle().then(run, run)
    else run()
  }
  let runtime: Runtime
  runtime = new Runtime(ctx, machine, restart)
  ctx.effect(() => async () => { await runtime.stop() })
  await runtime.ready
  ctx.logger.info(runtime.configured() ? 'dsh-superagent ready; the Superagent sidebar entry opens the management panel' : `dsh-superagent is waiting for setup: ${runtime.setupProblem?.detail ?? ''}`)
}
export type { Deployment, DeploymentConfig } from './deployment.ts'
export * from './core/index.ts'
