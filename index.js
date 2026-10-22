// dsh-reply-edit 宿主 half：只做接线，不做业务。
//
//   core.js       纯数据（块读写 / 校验 / 应用改写）——零宿主依赖
//   projection.js patch 事件的解释器——决定模型看见什么
//   session.js    活会话读写——业务失败码都在这里
//   stamp.js      事件信封打标——给自有事件补 ignorable 标记（fail-closed）
//   routes.js     HTTP 入口——浏览器 half 唯一能用到的接口
//
// 投影必须在 apply 里**同步**注册：宿主恢复会话时用已注册的投影列表回放，
// 晚一步注册会让带 patch 的历史会话回放时看不到伪造内容（且不报错）。

import { projection } from './lib/projection.js'
import { createRoute } from './lib/routes.js'

export const name = 'dsh-reply-edit'

// sessions：活会话（读写都要）。webServer：给浏览器 half 的接口。
export const inject = ['sessions', 'webServer']

export function apply(ctx) {
  ctx.effect(() => ctx.sessions.registerMessageProjection(projection), 'reply-edit projection')
  ctx.effect(() => ctx.webServer.register(createRoute({ sessions: ctx.sessions })), 'reply-edit routes')
}
