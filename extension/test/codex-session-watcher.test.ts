import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { it } from 'node:test'
import { CodexSessionWatcher } from '../src/codex-session-watcher'
import { ACTIVE_SESSION_AGE_S, ORCHESTRATOR_NAME } from '../src/constants'
import type { AgentEvent } from '../src/protocol'

it('discovers new chats and nests Codex rollouts under their owning chat', async () => {
  const originalHome = process.env.CODEX_HOME
  const home = mkdtempSync(join(tmpdir(), 'agent-flow-codex-'))
  process.env.CODEX_HOME = home
  const date = new Date().toISOString().slice(0, 10).replaceAll('-', '/')
  const dir = join(home, 'sessions', date)
  mkdirSync(dir, { recursive: true })

  const root = '00000000-0000-0000-0000-000000000001'
  const child = '00000000-0000-0000-0000-000000000002'
  const grandchild = '00000000-0000-0000-0000-000000000003'
  const guardian = '00000000-0000-0000-0000-000000000004'
  const otherRoot = '00000000-0000-0000-0000-000000000005'
  const historicalRoot = '00000000-0000-0000-0000-000000000006'
  const rootWorkspace = join(home, 'project-one')
  const otherWorkspace = join(home, 'project-two')

  const write = (order: number, id: string, meta: object, records: object[] = []) => {
    const file = join(dir, `rollout-2026-01-01T00-00-0${order}-${id}.jsonl`)
    writeFileSync(file, [
      { type: 'session_meta', payload: { id, ...meta } },
      ...records,
    ].map(x => JSON.stringify(x)).join('\n') + '\n')
    return file
  }
  const nestedSource = (parent: string, nickname: string) => ({
    subagent: { thread_spawn: { parent_thread_id: parent, agent_nickname: nickname } },
  })
  const childEvent = (type: string) => ({ type: 'event_msg', payload: { type } })
  const age = new Date(Date.now() - (ACTIVE_SESSION_AGE_S + 60) * 1000)
  utimesSync(write(0, historicalRoot, { cwd: rootWorkspace }), age, age)
  // The child belongs in the graph even if its work completed before startup.
  utimesSync(write(2, child, { cwd: otherWorkspace, source: nestedSource(root, 'Scout') }, [
    { type: 'response_item', payload: { type: 'function_call', call_id: 'check', name: 'read_file' } },
    childEvent('task_complete'),
    childEvent('task_complete'),
  ]), age, age)
  write(1, grandchild, { cwd: otherWorkspace, source: nestedSource(child, 'Reader') })
  write(3, guardian, { cwd: rootWorkspace, thread_source: 'guardian_review', parent_thread_id: root })
  write(4, root, { cwd: rootWorkspace })

  const global = new CodexSessionWatcher()
  const scoped = new CodexSessionWatcher(rootWorkspace)
  try {
    const events: AgentEvent[] = []
    const tabs: string[] = []
    global.onEvent(event => events.push(event))
    global.onSessionDetected(id => tabs.push(id))
    global.start()
    scoped.start()
    assert.deepEqual(tabs, [root])
    assert.deepEqual(global.getActiveSessions().map(s => s.id), [root])

    const spawns = events.filter(e => e.type === 'agent_spawn')
    assert.equal(spawns.length, 3)
    assert.deepEqual(spawns.map(e => e.sessionId), [root, root, root])
    assert.equal(spawns[0].payload.name, ORCHESTRATOR_NAME)
    assert.equal(spawns[1].payload.parent, ORCHESTRATOR_NAME)
    assert.equal(spawns[2].payload.parent, spawns[1].payload.name)
    assert.equal(events.find(e => e.type === 'tool_call_start')?.payload.agent, spawns[1].payload.name)
    assert.equal(events.filter(e => e.type === 'agent_complete').length, 1)

    write(5, otherRoot, { cwd: otherWorkspace })
    for (let attempt = 0; attempt < 40 && tabs.length < 2; attempt++) await delay(50)
    assert.deepEqual(tabs, [root, otherRoot])
    assert.deepEqual(scoped.getActiveSessions().map(s => s.id), [root])
  } finally {
    global.dispose()
    scoped.dispose()
    if (originalHome === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = originalHome
    rmSync(home, { recursive: true, force: true })
  }
})
