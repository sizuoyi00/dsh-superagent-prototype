/** What the delivery layer does with failures: a permanent refusal is dropped, and an aggregate keeps its causes. */
import { expect, it } from 'vitest'
import { described } from '../src/executor/dsh.ts'
import { Permanent, checkedImText } from '../src/infra/text.ts'
it('describes an aggregate by its causes', () => {
  expect(described(new Error('plain'))).toBe('Error: plain')
  const aggregate = new AggregateError([new Error('job gone'), new TypeError('wrong shape')], 'Stopping the background work of worker-1 failed')
  expect(described(aggregate)).toContain('Stopping the background work of worker-1 failed')
  expect(described(aggregate)).toContain('cause: Error: job gone')
  expect(described(aggregate)).toContain('cause: TypeError: wrong shape')
  // The guard allows 1000 words; past it a message is refused permanently rather than retried.
  expect(() => checkedImText('字 '.repeat(1001))).toThrow(Permanent)
})
