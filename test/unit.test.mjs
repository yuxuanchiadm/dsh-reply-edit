// 纯逻辑测试：不启动宿主，用假 session 验证投影 / 目标枚举 / 已改写标记。
//
//   node --test test/        （或 npm test）
import test from 'node:test'
import assert from 'node:assert/strict'

import { EVENT_TYPE, applyEdit, buildEdit, listBlocks, readBlock } from '../lib/core.js'
import { projection } from '../lib/projection.js'
import { readBlocks, readMarks, readTargets, writeEdit } from '../lib/session.js'
import {
  assistantEvent, checkpointEvent, fakeSession, fakeSessions, projectContext,
} from './helpers/fake-session.mjs'

const REPLY = assistantEvent(3, {
  id: 'msg-reply',
  role: 'assistant',
  content: [{ type: 'reasoning', text: 'think', signature: 'sig' }, { type: 'text', text: 'hello' }],
})
const SUMMARY = checkpointEvent(5, 'msg-summary', 'SUMMARY')

/** 一条 patch 事件。 */
const patch = (seq, data) => ({ type: EVENT_TYPE, seq, time: 1, data })
/** 合法的 patch 数据体。 */
const edit = (target, blockIndex, kind, text) => ({ v: 1, seq: target, blockIndex, kind, text })

const context = (nodes = [3, 5]) => projectContext([REPLY, SUMMARY], nodes)

test('projection: 压缩摘要被改写，且保留 role: user', () => {
  const projected = projection.project(patch(9, edit(5, 0, 'text', 'EDITED SUMMARY')), context())
  assert.equal(projected.get(5)?.content[0].text, 'EDITED SUMMARY')
  assert.equal(projected.get(5)?.role, 'user')
})

test('projection: 助手正文与推理块都可改写', () => {
  const text = projection.project(patch(9, edit(3, 1, 'text', 'EDITED REPLY')), context())
  assert.equal(text.get(3)?.content[1].text, 'EDITED REPLY')
  const reasoning = projection.project(patch(10, edit(3, 0, 'reasoning', 'x')), context())
  assert.equal(reasoning.get(3)?.content[0].text, 'x')
})

test('projection: 被遮蔽的目标跳过', () => {
  assert.equal(projection.project(patch(9, edit(5, 0, 'text', 'y')), context([3])).size, 0)
})

test('projection: 坏数据不抛，只是不生效', () => {
  assert.equal(projection.project(patch(9, { v: 99 }), context()).size, 0)
  assert.equal(projection.project(patch(9, null), context()).size, 0)
})

test('core: 改推理块会剥掉签名，改正文不会', () => {
  const reasoning = applyEdit(REPLY.data.message, edit(3, 0, 'reasoning', 'z'))
  assert.deepEqual(reasoning.content[0], { type: 'reasoning', text: 'z' })
  const text = applyEdit(REPLY.data.message, edit(3, 1, 'text', 'z'))
  assert.equal(text.content[0].signature, 'sig')
})

test('core: 块种类不符时原样返回（同一个对象）', () => {
  assert.equal(applyEdit(SUMMARY.data, edit(5, 0, 'reasoning', 'z')), SUMMARY.data)
})

test('core: 块读写只认正文与思维链', () => {
  const content = [...REPLY.data.message.content, { type: 'image', url: 'x' }]
  assert.deepEqual(listBlocks(content).map(block => [block.blockIndex, block.kind]), [[0, 'reasoning'], [1, 'text']])
  assert.equal(readBlock(content, 2), null)
  assert.deepEqual(readBlock(content, 1), { kind: 'text', text: 'hello' })
})

test('core: buildEdit 校验数据体', () => {
  assert.equal(buildEdit({ seq: 3, blockIndex: 1, kind: 'text', text: 'a' }).v, 1)
  assert.throws(() => buildEdit({ seq: -1, blockIndex: 0, kind: 'text', text: 'a' }))
  assert.throws(() => buildEdit({ seq: 3, blockIndex: 0, kind: 'image', text: 'a' }))
  assert.throws(() => buildEdit({ seq: 3, blockIndex: 0, kind: 'text', text: 42 }))
})

// ── 目标枚举 / 读块 ──────────────────────────────────────────────────────────
const sessions = fakeSessions({ s1: fakeSession([REPLY, SUMMARY]) })

test('targets: 标题栏入口列出最后一轮的全部步骤 + 压缩摘要', () => {
  const { targets } = readTargets(sessions, 's1')
  assert.deepEqual(targets.map(target => target.label), ['第 1 步', '压缩摘要 #1'])
  assert.deepEqual(targets.map(target => target.scope), ['assistant', 'compaction'])
})

test('targets: 操作条入口 = 本轮全部步骤（本条在最后）+ 压缩摘要', () => {
  const { targets } = readTargets(sessions, 's1', 'msg-reply')
  assert.deepEqual(targets.map(target => target.label), ['本条回复', '压缩摘要 #1'])
  assert.deepEqual(targets.map(target => target.scope), ['assistant', 'compaction'])
})

test('targets: 一轮多步时中间步骤也能选，别轮不混进来', () => {
  const step = (n, content) => assistantEvent(10 + n * 2, { id: `msg-s${n}`, role: 'assistant', content }, { turn: 7, step: n })
  const earlier = assistantEvent(2, {
    id: 'msg-old', role: 'assistant', content: [{ type: 'text', text: '上一轮' }],
  }, { turn: 6, step: 1 })
  const multi = fakeSessions({
    s1: fakeSession([
      earlier,
      step(1, [{ type: 'reasoning', text: 'think 1' }, { type: 'text', text: 'call tool' }]),
      step(2, [{ type: 'reasoning', text: 'think 2' }]),
      step(3, [{ type: 'reasoning', text: 'think 3' }, { type: 'text', text: 'final' }]),
    ]),
  })
  // 操作条入口锚定第 3 步：仍然把整轮带出来，本条标记为「本条回复」
  const action = readTargets(multi, 's1', 'msg-s3').targets
  assert.deepEqual(action.map(target => target.label), ['第 1 步', '第 2 步', '本条回复'])
  assert.deepEqual(action.map(target => target.messageId), ['msg-s1', 'msg-s2', 'msg-s3'])
  // 标题栏入口锚定最后一轮的第 3 步
  const header = readTargets(multi, 's1').targets
  assert.deepEqual(header.map(target => target.label), ['第 1 步', '第 2 步', '第 3 步'])
  // 中间步骤读得到块，而且就是这一步自己的思维链
  const blocks = readBlocks(multi, 's1', 'msg-s2').blocks
  assert.deepEqual(blocks.map(block => [block.kind, block.text]), [['reasoning', 'think 2']])
})

test('blocks: 回复两块 / 摘要一块', () => {
  assert.deepEqual(readBlocks(sessions, 's1', 'msg-reply').blocks.map(block => block.kind), ['reasoning', 'text'])
  assert.deepEqual(readBlocks(sessions, 's1', 'msg-summary').blocks.map(block => block.kind), ['text'])
})

test('write: 拿不到可包装的 commit 时 fail-closed', () => {
  const result = writeEdit(sessions, {
    sessionId: 's1', messageId: 'msg-summary', blockIndex: 0, kind: 'text', text: 'NEW', expect: 'SUMMARY',
  })
  assert.equal(result.code, 'APPEND_UNSAFE')
})

// ── 已改写标记：比对「投影后文本」与原文，不是数事件 ──────────────────────────
test('marks: 只标真正改过的块', () => {
  const edited = fakeSession([REPLY, SUMMARY], {
    project: event => (event.seq === 3
      ? { ...REPLY.data.message, content: [{ type: 'reasoning', text: 'EDITED THINK' }, { type: 'text', text: 'EDITED' }] }
      : event.data),
  })
  const marks = readMarks(fakeSessions({ s1: edited }), 's1')
  assert.deepEqual(marks.edited.map(item => item.messageId), ['msg-reply'])
  assert.deepEqual(marks.edited[0].blocks, [0, 1])
  assert.equal(marks.count, 1)
})

test('marks: 压缩摘要被改也算，scope 为 compaction', () => {
  const edited = fakeSession([REPLY, SUMMARY], {
    project: event => (event.type === 'user/message'
      ? { ...event.data, content: [{ type: 'text', text: 'EDITED SUMMARY' }] }
      : event.data.message),
  })
  const marks = readMarks(fakeSessions({ s1: edited }), 's1')
  assert.deepEqual(marks.edited.map(item => [item.messageId, item.scope]), [['msg-summary', 'compaction']])
})

test('marks: 原文 = 投影时没有任何标记（改回去就消失）', () => {
  assert.deepEqual(readMarks(sessions, 's1').count, 0)
})
