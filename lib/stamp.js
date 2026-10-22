// 让本插件自己的事件在进入会话日志时带上 `ignorable: true`。
//
// 为什么必须有：宿主读会话时有一道 fail-closed 闸门（持久化层 validateStoredEvents）：
// 「不认识的 event.type 且没有 ignorable:true」→ 抛错、**整条日志拒读**（会话打不开，
// 表现为列表能看见、点开报错）。我们的 patch 事件对宿主就是未知类型。
//
// 为什么选 commit：`Session.append()` 不接受这个字段，但 `commit(event, entry)` 是
// 事件进入 log 的**唯一**漏斗（append / 插件记录 / fork seed / 迁移都走它），在
// 那里改事件信封，所有落盘路径天然继承标记——不依赖某个持久化后端实现的内部结构。
//
// 只改自己类型的事件；别人的一字不动；拿不到 commit 就拒绝在线写入（fail-closed），
// 绝不把用户会话写坏。

import { EVENT_TYPE } from './core.js'

const BRAND = Symbol('dsh-reply-edit.stamp')
const patched = new WeakSet()
let patchedProtos = 0

/** 只给本插件自己的事件补标记；已标记或别人的事件原样返回。 */
function stamp(event) {
  if (event?.type !== EVENT_TYPE || event.ignorable === true) return event
  return Object.freeze({ ...event, ignorable: true })
}

/**
 * 保证这个会话所属 Session 类的 commit 已被包装。
 * @returns {boolean} 为 false 时必须拒绝在线写入
 */
export function ready(session) {
  if (session === null || typeof session !== 'object') return false
  const proto = Object.getPrototypeOf(session)
  if (proto === null || typeof proto.commit !== 'function') return false
  if (patched.has(proto)) return proto.commit[BRAND] === true
  const original = proto.commit
  const wrapper = function (event, entry) {
    return original.call(this, stamp(event), entry)
  }
  wrapper[BRAND] = true
  proto.commit = wrapper
  patched.add(proto)
  patchedProtos += 1
  return true
}

/** 诊断信息（health 路由用）。 */
export function state() {
  return { ok: true, patched: patchedProtos }
}
