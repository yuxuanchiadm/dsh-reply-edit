// 宿主侧 message projection：patch 事件的解释器（「立即生效」的机制本体）。
//
// project(event, context) 返回 Map<seq, Message>，覆盖「该 seq 的消息模型看到
// 的内容」。只注册在自己的事件类型上：注册到 assistant/message 会让它走
// {kind:'project'} 分支、永远进不了 surface；注册到 user/message 同理。
//
// 目标可以是任何**产生消息的** surface 节点：assistant/message（助手回复）、
// tool/result（工具返回给模型的结果）或压缩摘要那条 user/message。我们不改目标事件
// 本身，只是后来居上地覆盖它的投影结果——所以压缩记忆、普通回复、工具输出走的是
// 同一条路径。
//
// 兜底原则：**绝不抛**。投影抛错会让整个会话折叠失败（会话打不开），代价远大于
// 「这条 patch 不生效」。

import { EVENT_TYPE, applyEdit, validate } from './core.js'

/** 事件承载的原始消息（user/message 的 data 本身就是消息）。 */
function sourceMessage(event) {
  if (event?.type === 'user/message') return event.data
  if (event?.type === 'assistant/message') return event.data?.message
  if (event?.type === 'tool/result') return event.data?.message
  return undefined
}

export const projection = {
  type: EVENT_TYPE,
  project(event, context) {
    const out = new Map()
    let data
    try {
      data = validate(event?.data)
    } catch {
      return out
    }
    // 目标必须仍是 surface 上的当前节点：被压缩遮蔽过的节点模型本来就看不见。
    const nodes = context?.nodes
    if (!Array.isArray(nodes) || nodes.includes(data.seq) === false) return out
    const source = context?.events?.[data.seq - context.baseSeq]
    if (source === undefined) return out
    // 基准取「当前已投影的消息」，这样多条 patch 能叠加。
    const base = context.messages?.get?.(data.seq) ?? sourceMessage(source)
    if (base === undefined || base === null) return out
    try {
      const next = applyEdit(base, data)
      if (next !== base) out.set(data.seq, next)
    } catch {
      // 单条失败不牵连会话
    }
    return out
  },
}
