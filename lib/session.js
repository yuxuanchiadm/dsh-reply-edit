// 活会话读写：把「模型看得见的消息」翻译成可编辑块，把改写追加成 patch 事件。
//
// 可改写的消息事件有两类：
//   · assistant/message —— 助手回复（推理块 + 正文）；
//   · user/message 且 source.kind === 'compact-checkpoint' —— 压缩摘要。宿主压缩
//     历史时正是用它把被压缩的区间替换掉，所以它也是「模型看到的那句话」，
//     改它等于改紧凑记忆本身。真实用户消息不在此列（source.kind === 'user'）。
//
// 业务失败一律返回 {ok:false, code}，不抛：路由层拿 code 做分支，UI 拿 code 给人话。

import { EVENT_TYPE, buildEdit, listBlocks, readBlock } from './core.js'
import { ready } from './stamp.js'

/** 失败码 → 给用户看的原因。 */
export const REASON = {
  SESSION_NOT_LIVE: '这个会话当前不在内存里（未打开或已关闭），无法在线改写',
  MESSAGE_NOT_FOUND: '这个会话里找不到这条消息（界面可能已过期，刷新后重试）',
  SHADOWED: '这条消息已被压缩摘要取代，模型已经看不见它了（要改的是那条摘要）',
  NOT_EDITABLE: '这个块不是可编辑的正文/思维链',
  KIND_MISMATCH: '块种类与界面显示不符（界面已过期，刷新后重试）',
  STALE_TEXT: '内存里的正文与界面显示的不一致（界面已过期），已拒绝写入',
  APPEND_UNSAFE: '无法确认改写事件落盘时会带上「可忽略」标记，为免写坏会话已拒绝',
  APPEND_FAILED: '宿主拒绝追加改写事件',
  BAD_REQUEST: '请求参数不完整',
}

export function fail(code, extra = {}) {
  return { ok: false, code, error: REASON[code] ?? code, ...extra }
}

/** 取活会话；拿不到返回 undefined。 */
export function liveSession(sessions, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return undefined
  try {
    return sessions?.get?.(sessionId) ?? undefined
  } catch {
    return undefined
  }
}

/** 压缩摘要事件（宿主用它替换被压缩的区间）。 */
function isCheckpoint(event) {
  return event?.type === 'user/message' && event.data?.source?.kind === 'compact-checkpoint'
}

/** 工具结果事件（role: tool 的消息，模型看到的是它）。 */
function isToolResult(event) {
  return event?.type === 'tool/result'
}

/** 事件是否承载一条可改写消息。 */
function editableEvent(event) {
  return event?.type === 'assistant/message' || isCheckpoint(event) || isToolResult(event)
}

/** 事件承载的消息对象：assistant / tool 在 data.message，user 就是 data。 */
function baseMessage(event) {
  if (event?.type === 'assistant/message') return event.data?.message
  if (event?.type === 'user/message') return event.data
  if (event?.type === 'tool/result') return event.data?.message
  return undefined
}

/** 目标来源：助手回复 / 工具结果 / 压缩摘要。 */
function scopeOf(event) {
  if (isCheckpoint(event)) return 'compaction'
  if (isToolResult(event)) return 'tool'
  return 'assistant'
}

/** 消息当前的样子（模型所见）：先走投影，投影缺失再退回原始数据。 */
function projectedMessage(session, event) {
  try {
    return session.deriveEventMessage(event) ?? baseMessage(event) ?? null
  } catch {
    return baseMessage(event) ?? null
  }
}

/** 在 surface 上按 messageId 找一条可改写消息。 */
function findOnSurface(session, messageId) {
  const nodes = session?.surface?.nodes
  if (!Array.isArray(nodes)) return undefined
  for (const seq of nodes) {
    const event = session.eventAt(seq)
    if (!editableEvent(event)) continue
    if (baseMessage(event)?.id === messageId) return { event }
  }
  return undefined
}

/** 不在 surface 上但在日志里：已被压缩遮蔽的历史消息。 */
function findShadowed(session, messageId) {
  let events
  try {
    events = session.snapshotEvents?.() ?? []
  } catch {
    return false
  }
  for (const event of events) {
    if (!editableEvent(event)) continue
    if (baseMessage(event)?.id === messageId) return true
  }
  return false
}

/** 定位消息事件；找不到返回 undefined，被遮蔽返回 {shadowed:true}。 */
function locate(session, messageId) {
  const found = findOnSurface(session, messageId)
  if (found !== undefined) return found
  return findShadowed(session, messageId) ? { shadowed: true } : undefined
}

/**
 * 列出某条消息的可编辑块。
 * @returns {{ok:true, seq:number, messageId:string, scope:'assistant'|'tool'|'compaction', blocks:Array}
 *          | {ok:false, code:string, error:string}}
 */
export function readBlocks(sessions, sessionId, messageId) {
  const session = liveSession(sessions, sessionId)
  if (session === undefined) return fail('SESSION_NOT_LIVE')
  const found = locate(session, messageId)
  if (found === undefined) return fail('MESSAGE_NOT_FOUND')
  if (found.shadowed === true) return fail('SHADOWED')
  const message = projectedMessage(session, found.event)
  return {
    ok: true,
    seq: found.event.seq,
    messageId,
    scope: scopeOf(found.event),
    blocks: listBlocks(message?.content),
  }
}

/** 目标标签：多步 turn 里按步号区分，拿不到步号就笼统叫「回复」。 */
function stepLabel(entry) {
  return Number.isSafeInteger(entry.step) && entry.step > 0 ? `第 ${entry.step} 步` : '回复'
}

/** 同一个 turn 里的全部助手消息（拿不到 turn 就只返回它自己）。 */
function turnPeers(assistants, anchor) {
  if (anchor.turn === undefined) return [anchor]
  const peers = assistants.filter(item => item.turn === anchor.turn)
  return peers.length === 0 ? [anchor] : peers
}

/** 工具结果属于哪一轮（拿不到 turn 就不算任何一轮）。 */
function inTurn(entry, anchor) {
  return anchor.turn !== undefined && entry.turn === anchor.turn
}

/** callId → 工具名：工具结果光看内容认不出是哪个工具，标签靠它。 */
function callNames(session) {
  const names = new Map()
  let events = []
  try {
    events = session.snapshotEvents?.() ?? []
  } catch {
    events = []
  }
  for (const event of events) {
    if (event?.type !== 'tool/call') continue
    const callId = event.data?.callId
    if (typeof callId === 'string' && typeof event.data?.name === 'string') {
      names.set(callId, event.data.name)
    }
  }
  return names
}

/** 工具结果标签：`第 12 步 · 工具结果 · pwsh`。 */
function toolLabel(entry, names) {
  const tool = names.get(entry.callId)
  const head = Number.isSafeInteger(entry.step) && entry.step > 0 ? `第 ${entry.step} 步 · ` : ''
  return `${head}工具结果${tool === undefined ? '' : ` · ${tool}`}`
}

/**
 * 列出可改写目标：**本轮的全部步骤与工具结果** + 本会话当前生效的压缩摘要。
 *
 * 为什么要列出整轮：一轮里多步（多思维链、多工具调用）是常态，而页面上的操作条是
 * **turn 级**的——只在最终消息上出现一次，中间步骤和工具结果都没有按钮。这里把它们
 * 带出来，否则「第 3 步的思维链」「第 5 步 pwsh 返回了什么」根本点不到。
 *
 * 仍然不返回「历史全部消息」：长会话有上千条，下拉没有意义，往前的回复点各自的操作条即可。
 *
 * @param {object} sessions 宿主 sessions 服务
 * @param {string} sessionId 会话 id
 * @param {string} [messageId] 入口所在消息（助手操作条带过来；标题栏入口不带，取最后一轮）
 */
export function readTargets(sessions, sessionId, messageId) {
  const session = liveSession(sessions, sessionId)
  if (session === undefined) return fail('SESSION_NOT_LIVE')
  const nodes = session.surface?.nodes
  if (!Array.isArray(nodes)) return fail('SESSION_NOT_LIVE')

  const compactions = []
  const assistants = []
  const results = []
  for (const seq of nodes) {
    const event = session.eventAt(seq)
    if (!editableEvent(event)) continue
    const message = projectedMessage(session, event)
    if (typeof message?.id !== 'string') continue
    const blocks = listBlocks(message.content)
    if (blocks.length === 0) continue
    const entry = { seq, messageId: message.id, blocks, turn: event.data?.turn, step: event.data?.step }
    if (isCheckpoint(event)) compactions.push(entry)
    else if (isToolResult(event)) results.push({ ...entry, callId: message.toolCallId })
    else assistants.push(entry)
  }

  const targets = []
  const selected = typeof messageId === 'string' && messageId !== ''
    ? assistants.find(item => item.messageId === messageId)
    : undefined
  // 操作条入口锚定被点的那条；标题栏入口锚定最后一轮的最后一步。
  const anchor = selected ?? assistants[assistants.length - 1]
  if (anchor !== undefined) {
    const names = results.length === 0 ? new Map() : callNames(session)
    const peers = [
      ...turnPeers(assistants, anchor).map(item => ({ item, scope: 'assistant' })),
      ...results.filter(item => inTurn(item, anchor)).map(item => ({ item, scope: 'tool' })),
    ].sort((a, b) => a.item.seq - b.item.seq)
    for (const peer of peers) {
      targets.push({
        seq: peer.item.seq,
        messageId: peer.item.messageId,
        blocks: peer.item.blocks,
        scope: peer.scope,
        label: peer.scope === 'tool'
          ? toolLabel(peer.item, names)
          : (peer.item === selected ? '本条回复' : stepLabel(peer.item)),
      })
    }
  }
  compactions.forEach((item, index) =>
    targets.push({
      seq: item.seq,
      messageId: item.messageId,
      blocks: item.blocks,
      scope: 'compaction',
      label: `压缩摘要 #${index + 1}`,
    }))
  return { ok: true, sessionId, targets }
}

/**
 * 本会话里**哪些消息被改写过**：逐个 surface 消息比对「投影后文本」与「原文文本」。
 *
 * 为什么不数 patch 事件：改回去（再写一次原文）之后事件还在，但内容已经等于原文，
 * 不该再标「已改写」。比对文本是唯一自洽的判据，也顺便覆盖「压缩摘要被改」。
 */
export function readMarks(sessions, sessionId) {
  const session = liveSession(sessions, sessionId)
  if (session === undefined) return fail('SESSION_NOT_LIVE')
  const nodes = session.surface?.nodes
  if (!Array.isArray(nodes)) return fail('SESSION_NOT_LIVE')

  const edited = []
  for (const seq of nodes) {
    const event = session.eventAt(seq)
    if (!editableEvent(event)) continue
    const message = baseMessage(event)
    const content = message?.content
    if (typeof message?.id !== 'string' || !Array.isArray(content)) continue
    const projected = projectedMessage(session, event)?.content
    if (!Array.isArray(projected)) continue

    const blocks = []
    for (let index = 0; index < content.length; index += 1) {
      const origin = readBlock(content, index)
      const current = readBlock(projected, index)
      if (origin === null || current === null) continue
      if (origin.kind !== current.kind || origin.text === current.text) continue
      blocks.push(index)
    }
    if (blocks.length === 0) continue
    edited.push({
      seq,
      messageId: message.id,
      scope: scopeOf(event),
      blocks,
    })
  }
  return { ok: true, sessionId, count: edited.length, edited }
}

/**
 * 追加一条改写事件（立即生效，且随会话落盘）。
 * @param {object} sessions 宿主 sessions 服务
 * @param {{sessionId:string, messageId:string, blockIndex:number, kind?:string,
 *          text:string, expect?:string}} req
 */
export function writeEdit(sessions, req) {
  const session = liveSession(sessions, req?.sessionId)
  if (session === undefined) return fail('SESSION_NOT_LIVE')
  const found = locate(session, req.messageId)
  if (found === undefined) return fail('MESSAGE_NOT_FOUND')
  if (found.shadowed === true) return fail('SHADOWED')
  const event = found.event

  // 原文与投影后文本：前者决定「能不能改」，后者决定「界面是否过期」。
  const original = readBlock(baseMessage(event)?.content ?? [], req.blockIndex)
  if (original === null) return fail('NOT_EDITABLE')
  if (typeof req.kind === 'string' && req.kind !== '' && req.kind !== original.kind) {
    return fail('KIND_MISMATCH', { expected: req.kind, actual: original.kind })
  }
  const message = projectedMessage(session, event)
  const current = readBlock(message?.content ?? [], req.blockIndex)
  if (current === null) return fail('NOT_EDITABLE')
  if (typeof req.expect === 'string' && req.expect !== current.text) {
    return fail('STALE_TEXT', { actual: current.text })
  }

  // fail-closed：标记补不上就不写（否则会话下次可能打不开）。
  if (ready(session) === false) return fail('APPEND_UNSAFE')

  const data = buildEdit({
    seq: event.seq,
    blockIndex: req.blockIndex,
    kind: original.kind,
    text: req.text,
    messageId: req.messageId,
  })
  let appended
  try {
    appended = session.append(EVENT_TYPE, data)
  } catch (error) {
    return fail('APPEND_FAILED', { detail: String(error?.message ?? error) })
  }
  return {
    ok: true,
    seq: event.seq,
    eventSeq: typeof appended?.seq === 'number' ? appended.seq : null,
    blockIndex: req.blockIndex,
    kind: original.kind,
    scope: scopeOf(event),
  }
}
