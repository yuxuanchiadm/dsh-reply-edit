// HTTP 路由：网页端（浏览器 half）唯一的入口。一个前缀四件事：
//   GET  /api/reply-edit/targets?sessionId           列出本会话所有可改写目标（含压缩摘要）
//   GET  /api/reply-edit/blocks?sessionId&messageId   读一条消息的可编辑块（模型所见文本）
//   POST /api/reply-edit/patch                       写入改写（立即生效）
//   GET  /api/reply-edit/health                      诊断（commit shim 是否就绪）
//
// 请求/响应都是普通 JSON；业务失败一律 200 + {ok:false, code}，让 UI 拿 code 给人话。

import { liveSession, readBlocks, readMarks, readTargets, writeEdit } from './session.js'
import { state } from './stamp.js'

const PREFIX = '/api/reply-edit'
const MAX_BODY = 1024 * 1024
const MAX_TEXT = 512 * 1024

function json(res, status, body) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', chunk => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('body-too-large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new Error('invalid-json'))
      }
    })
    req.on('error', reject)
  })
}

/**
 * 等会话进入内存。UI 打开历史会话时先 prepare、再异步 promote→resume→enter，
 * 这段窗口里 sessions.get() 还是 undefined；用户点按钮的瞬间可能正好撞上。
 */
async function waitLive(sessions, sessionId) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (liveSession(sessions, sessionId) !== undefined) return true
    await new Promise(resolve => setTimeout(resolve, 150))
  }
  return false
}

/**
 * @param {{sessions: object|undefined}} deps Cordis 上下文里解析出来的服务
 * @returns {object} webServer 路由定义
 */
export function createRoute({ sessions }) {
  return {
    kind: 'prefix',
    path: PREFIX,
    async handler(req, res) {
      const url = new URL(req.url, 'http://127.0.0.1')
      const action = url.pathname.slice(PREFIX.length).replace(/^\/+/, '')

      if (action === 'health') {
        json(res, 200, { ok: true, service: 'reply-edit', writer: state() })
        return
      }

      if (action === 'marks') {
        if (req.method !== 'GET') return json(res, 405, { ok: false, code: 'BAD_REQUEST' })
        const sessionId = url.searchParams.get('sessionId') ?? ''
        if (sessionId === '') return json(res, 400, { ok: false, code: 'BAD_REQUEST' })
        await waitLive(sessions, sessionId)
        return json(res, 200, readMarks(sessions, sessionId))
      }

      if (action === 'targets') {
        if (req.method !== 'GET') return json(res, 405, { ok: false, code: 'BAD_REQUEST' })
        const sessionId = url.searchParams.get('sessionId') ?? ''
        const messageId = url.searchParams.get('messageId') ?? ''
        if (sessionId === '') return json(res, 400, { ok: false, code: 'BAD_REQUEST' })
        await waitLive(sessions, sessionId)
        return json(res, 200, readTargets(sessions, sessionId, messageId === '' ? undefined : messageId))
      }

      if (action === 'blocks') {
        if (req.method !== 'GET') return json(res, 405, { ok: false, code: 'BAD_REQUEST' })
        const sessionId = url.searchParams.get('sessionId') ?? ''
        const messageId = url.searchParams.get('messageId') ?? ''
        if (sessionId === '' || messageId === '') {
          return json(res, 400, { ok: false, code: 'BAD_REQUEST' })
        }
        await waitLive(sessions, sessionId)
        return json(res, 200, readBlocks(sessions, sessionId, messageId))
      }

      if (action === 'patch') {
        if (req.method !== 'POST') return json(res, 405, { ok: false, code: 'BAD_REQUEST' })
        // 自定义头挡住同源下别的脚本顺手 POST 一下这种误触。
        if (req.headers['x-reply-edit'] !== '1') {
          return json(res, 403, { ok: false, code: 'BAD_REQUEST' })
        }
        let body
        try {
          body = await readBody(req)
        } catch (error) {
          return json(res, 400, { ok: false, code: 'BAD_REQUEST', error: String(error.message) })
        }
        const request = body !== null && typeof body === 'object' ? body : {}
        if (typeof request.sessionId !== 'string' || typeof request.messageId !== 'string') {
          return json(res, 400, { ok: false, code: 'BAD_REQUEST' })
        }
        if (typeof request.text !== 'string' || request.text.trim() === '') {
          return json(res, 400, { ok: false, code: 'BAD_REQUEST', error: 'text required' })
        }
        if (request.text.length > MAX_TEXT) return json(res, 413, { ok: false, code: 'BAD_REQUEST' })
        if (!Number.isSafeInteger(request.blockIndex) || request.blockIndex < 0) {
          return json(res, 400, { ok: false, code: 'BAD_REQUEST' })
        }
        await waitLive(sessions, request.sessionId)
        return json(res, 200, writeEdit(sessions, {
          sessionId: request.sessionId,
          messageId: request.messageId,
          blockIndex: request.blockIndex,
          kind: typeof request.kind === 'string' ? request.kind : '',
          text: request.text,
          expect: typeof request.expect === 'string' ? request.expect : undefined,
        }))
      }

      return json(res, 404, { ok: false, code: 'BAD_REQUEST', error: `unknown action ${action}` })
    },
  }
}
