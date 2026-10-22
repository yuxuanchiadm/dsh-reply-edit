// 真实会话日志的回归测试（可选，默认跳过）。
//
// 单测用假 session 覆盖逻辑；这个用例补的是「宿主真实产出的事件形状」——
// 真实 assistant/message、真实压缩摘要（带 surfaceOp: replace 的 user/message）、
// 真实写进去的 patch 事件——读路径都能吃下。
//
// 需要一份本地会话日志：
//
//   $env:DSH_SESSION_LOG='C:\Users\<you>\.dsh\sessions\<project>\<session>\session.v4.jsonl.zstd'
//   $env:DSH_PROFILE_DIR='C:\Users\<you>\.dsh\profiles\desktop'   # 用其中的 fzstd 解压（可选）
//   node --test test/
//
// 没有 DSH_SESSION_LOG 时整组跳过，`npm test` 在干净机器上依然全绿。
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { homedir } from 'node:os'

import { readBlocks, readMarks, readTargets } from '../lib/session.js'
import { fakeSession, fakeSessions } from './helpers/fake-session.mjs'

const LOG = process.env.DSH_SESSION_LOG ?? ''
const SKIP = existsSync(LOG) ? false : '设置 DSH_SESSION_LOG 指向一个真实的 session.v4.jsonl(.zstd) 才运行'

/** 读会话日志：支持 .jsonl 与 .jsonl.zstd（后者用 profile 里的 fzstd）。 */
function readEvents(file) {
  const raw = readFileSync(file)
  let bytes = raw
  if (file.endsWith('.zstd')) {
    const profile = process.env.DSH_PROFILE_DIR ?? join(homedir(), '.dsh', 'profiles', 'desktop')
    const require = createRequire(join(profile, 'node_modules') + '/')
    bytes = Buffer.from(require('fzstd').decompress(raw))
  }
  const events = []
  for (const line of bytes.toString('utf8').split('\n')) {
    if (line.trim() === '') continue
    try {
      const record = JSON.parse(line)
      events.push(record.event ?? record)
    } catch {
      // 尾部可能有不完整行，跳过
    }
  }
  return events
}

/** 把日志里的消息事件当作 surface（等价于宿主折叠后的样子，用于验证读路径）。 */
function sessionFromLog(events) {
  const messages = events.filter(event => event.type === 'assistant/message'
    || event.type === 'tool/result'
    || (event.type === 'user/message' && event.data?.source?.kind === 'compact-checkpoint'))
  return fakeSession(messages, { extra: events.filter(event => event.type === 'tool/call') })
}

test('真实日志：可改写目标枚举正常，压缩摘要都在', { skip: SKIP }, () => {
  const events = readEvents(LOG)
  assert.ok(events.length > 0, '日志为空')

  const { ok, targets } = readTargets(fakeSessions({ live: sessionFromLog(events) }), 'live')
  assert.equal(ok, true)
  const compactions = targets.filter(target => target.scope === 'compaction')
  const checkpoints = events.filter(event => event.type === 'user/message'
    && event.data?.source?.kind === 'compact-checkpoint')
  assert.equal(compactions.length, checkpoints.length, '每条压缩摘要都应成为目标')
  for (const target of targets) {
    assert.ok(target.blocks.length > 0, `${target.label} 没有可编辑块`)
    for (const block of target.blocks) assert.ok(block.kind === 'text' || block.kind === 'reasoning')
  }
})

test('真实日志：读块与已改写标记不抛', { skip: SKIP }, () => {
  const events = readEvents(LOG)
  const sessions = fakeSessions({ live: sessionFromLog(events) })
  const { targets } = readTargets(sessions, 'live')
  for (const target of targets) {
    const blocks = readBlocks(sessions, 'live', target.messageId)
    assert.equal(blocks.ok, true)
    assert.ok(blocks.blocks.length > 0)
  }
  // 日志里没有投影参与时，模型所见 = 原文，所以标记必然为 0。
  const marks = readMarks(sessions, 'live')
  assert.equal(marks.ok, true)
  assert.equal(marks.count, 0)
})

test('真实日志：最后一轮的每一步都能选', { skip: SKIP }, () => {
  const events = readEvents(LOG)
  const messages = events.filter(event => event.type === 'assistant/message')
  assert.ok(messages.length > 0, '日志里没有助手消息')
  const lastTurn = messages[messages.length - 1].data?.turn
  const editable = messages.filter(event => event.data?.turn === lastTurn
    && (event.data.message?.content ?? []).some(block => block.type === 'text'
      || block.type === 'reasoning' || block.type === 'thinking'))

  const { targets } = readTargets(fakeSessions({ live: sessionFromLog(events) }), 'live')
  const assistants = targets.filter(target => target.scope === 'assistant')
  assert.equal(assistants.length, editable.length, '最后一轮的每一步都该在目标列表里')
  assert.deepEqual(assistants.map(target => target.messageId), editable.map(event => event.data.message.id))
  for (const target of assistants) {
    assert.match(target.label, /^(本条回复|第 \d+ 步|回复)$/)
  }
})

test('真实日志：最后一轮的工具结果也在目标里', { skip: SKIP }, () => {
  const events = readEvents(LOG)
  const messages = events.filter(event => event.type === 'assistant/message')
  const lastTurn = messages[messages.length - 1].data?.turn
  const results = events.filter(event => event.type === 'tool/result'
    && event.data?.turn === lastTurn
    && (event.data.message?.content ?? []).some(block => typeof block.text === 'string'))

  const { targets } = readTargets(fakeSessions({ live: sessionFromLog(events) }), 'live')
  const tools = targets.filter(target => target.scope === 'tool')
  assert.equal(tools.length, results.length, '最后一轮的工具结果都该在目标列表里')
  for (const target of tools) {
    assert.match(target.label, /^第 \d+ 步 · 工具结果( · .+)?$/)
    assert.ok(target.blocks.length > 0)
  }
})

test('真实日志：写进去的 patch 事件形状自洽', { skip: SKIP }, () => {
  const patches = readEvents(LOG).filter(event => event.type === 'reply-edit/patch')
  for (const item of patches) {
    assert.equal(item.data.v, 1)
    assert.equal(typeof item.data.seq, 'number')
    assert.equal(typeof item.data.text, 'string')
    // 宿主读日志的 fail-closed 闸门要求：未知事件类型必须带 ignorable。
    assert.equal(item.ignorable, true, `seq ${item.seq} 缺 ignorable 标记`)
  }
})
