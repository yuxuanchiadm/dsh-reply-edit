// 纯数据层：零宿主依赖，projection / 路由 / 测试共用同一份实现。
//
// 为什么需要「自有事件 + projection」而不是直接改 assistant/message：
// 宿主的 surface 折叠禁止 assistant/message 携带 sourceEventSeqs，而 replace
// 语义又要求它覆盖被遮蔽节点——两条规则互斥。message projection 是宿主留的
// 正门：按事件类型注册纯函数，折叠时决定「某个 seq 的消息模型看到什么」。

/** 本插件写进会话日志的事件类型（宿主不认识，靠投影解释）。 */
export const EVENT_TYPE = 'reply-edit/patch'

/** 数据版本；形状变化时递增。 */
export const VERSION = 1

/** 可编辑块种类 → 允许的会话块类型。 */
const KINDS = { text: ['text'], reasoning: ['reasoning', 'thinking'] }

/** 会话块类型 → 对外块种类。 */
function kindOf(type) {
  if (type === 'text') return 'text'
  if (type === 'reasoning' || type === 'thinking') return 'reasoning'
  return null
}

const isIndex = v => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0

/** 读一个消息块的可编辑视图；不可编辑返回 null。 */
export function readBlock(content, blockIndex) {
  if (!Array.isArray(content) || !isIndex(blockIndex)) return null
  const block = content[blockIndex]
  if (!block || typeof block !== 'object') return null
  const kind = kindOf(block.type)
  return kind !== null && typeof block.text === 'string' ? { kind, text: block.text } : null
}

/** 列出消息里所有可编辑块（正文 + 思维链）。 */
export function listBlocks(content) {
  if (!Array.isArray(content)) return []
  const out = []
  for (let i = 0; i < content.length; i += 1) {
    const view = readBlock(content, i)
    if (view !== null) out.push({ blockIndex: i, ...view })
  }
  return out
}

/** 校验 patch 数据体；不合规直接抛（投影里必须严格，宁可整条不生效）。 */
export function validate(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('data must be an object')
  if (data.v !== VERSION) throw new Error(`unsupported version ${String(data.v)}`)
  if (!isIndex(data.seq)) throw new Error('seq must be a non-negative safe integer')
  if (!isIndex(data.blockIndex)) throw new Error('blockIndex must be a non-negative safe integer')
  if (!KINDS[data.kind]) throw new Error('kind must be text or reasoning')
  if (typeof data.text !== 'string') throw new Error('text must be a string')
  return data
}

/**
 * 把一条 patch 应用到基准消息上，返回新消息（不改原对象）。
 *
 * 基准取「当前已投影的消息」（由 projection 传入），因此多条 patch 可叠加：
 * 改块 0 的 patch 与改块 1 的 patch 都保留，改同一块的后者覆盖前者。
 */
export function applyEdit(message, data) {
  const content = message?.content
  const view = readBlock(content, data.blockIndex)
  if (view === null || view.kind !== data.kind) return message
  const next = content.slice()
  const block = { ...content[data.blockIndex], text: data.text }
  // 推理块的签名是对**原文**做的，正文一改就与签名不符，部分 provider 会拒掉
  // 整条请求，所以改推理块必须同时剥掉签名。
  if (view.kind === 'reasoning') {
    delete block.signature
    delete block.thinkingSignature
  }
  next[data.blockIndex] = block
  return { ...message, content: next }
}

/**
 * 构造一条 patch 事件的数据体。
 * @param {{seq:number, blockIndex:number, kind:string, text:string, messageId?:string}} edit
 */
export function buildEdit(edit) {
  const data = { v: VERSION, seq: edit.seq, blockIndex: edit.blockIndex, kind: edit.kind, text: edit.text }
  if (typeof edit.messageId === 'string') data.messageId = edit.messageId
  return validate(data)
}
