// 测试夹具：宿主 Session 的最小假实现，让业务逻辑脱离宿主跑。
//
// 业务代码只用到 Session 的这几处：surface.nodes / eventAt(seq) /
// deriveEventMessage(event) / snapshotEvents()，写路径再加 append()。
// 只要这五个形状对得上，逻辑就能被验证——不需要启动 DSH。

/** assistant/message 事件（助手回复）。一轮多步时用 turn/step 区分。 */
export function assistantEvent(seq, message, { turn = 1, step = 1 } = {}) {
  return { type: 'assistant/message', seq, time: 1, data: { turn, step, stream: [], message } }
}

/** 压缩摘要事件（宿主压缩历史时插入的 user/message）。 */
export function checkpointEvent(seq, id, text) {
  return {
    type: 'user/message',
    seq,
    time: 1,
    data: { id, role: 'user', source: { kind: 'compact-checkpoint' }, content: [{ type: 'text', text }] },
  }
}

/**
 * 把事件列表包装成 Session 的最小形状。
 * @param {Array<object>} events 会话事件（按 seq 建立 surface）
 * @param {{project?: (event: object) => object}} [options] 覆盖 deriveEventMessage，用来模拟「已被改写」
 */
export function fakeSession(events, { project } = {}) {
  const bySeq = new Map(events.map(event => [event.seq, event]))
  return {
    surface: { nodes: [...bySeq.keys()].sort((a, b) => a - b) },
    eventAt: seq => bySeq.get(seq),
    deriveEventMessage: event => project?.(event)
      ?? (event.type === 'user/message' ? event.data : event.data?.message),
    snapshotEvents: () => events,
    append: (type, data) => ({ type, data, seq: 42 }),
  }
}

/** sessions 服务的最小形状：只认得给定 id。 */
export function fakeSessions(entries) {
  const sessions = new Map(Object.entries(entries))
  return { get: id => sessions.get(id) }
}

/** projection 的 context 形状：events 按 seq - baseSeq 索引，所以用稀疏数组。 */
export function projectContext(events, nodes) {
  const indexed = []
  for (const event of events) indexed[event.seq] = event
  return { nodes, events: indexed, baseSeq: 0, messages: new Map() }
}
