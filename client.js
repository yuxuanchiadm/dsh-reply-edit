// dsh-reply-edit 浏览器 half（单文件：客户端模块不打包，直接用 require 取 React）。
//
// 两个入口、同一个面板：
//   · 助手回复操作条（conversation.chat.assistant-actions）—— 预选这条消息；
//   · 会话标题右侧工具条（conversation.session.header.utilities）—— 总入口，
//     默认落在最近一条压缩摘要上。
// 面板里「目标」下拉列出本会话当前**模型可见**的全部可改写块：助手回复的正文/思维链、
// 以及压缩摘要的正文。改完 POST 给宿主 half，换成一条 patch 事件。
//
// 样式在 apply 里一次性注入（宿主按 data-plugin 回收），弹层 portal 到 body。

window.__ModuleLoader__.load({
  id: '@local/dsh-reply-edit',
  factory(require) {
    const React = require('react')
    const ReactDOM = require('react-dom')
    const h = React.createElement

    const NS = 'dsh-reply-edit'
    const SLOT_ACTION = 'conversation.chat.assistant-actions'
    const SLOT_HEADER = 'conversation.session.header.utilities'

    const STRINGS = {
      zh: {
        action: '改写',
        title: '改写模型所见',
        target: '目标',
        kindText: '正文',
        kindReasoning: '思维链',
        hint: '写入后，这个会话之后的每一轮模型都只认改后的内容（页面正文仍是原文，本插件只改模型所见）。压缩摘要也在这份目标列表里。',
        cancel: '取消',
        save: '写入改写',
        saving: '写入中…',
        loading: '读取中…',
        empty: '这个会话当前没有可改写的消息',
        saved: '已写入 ✓ 模型下一轮看到的就是改后的内容',
        failed: '写入失败',
        loadFailed: '读不到这个会话的消息',
        edited: '已改写（模型所见已更新）',
        editedCount: '已改写 {n} 处',
      },
      en: {
        action: 'Rewrite',
        title: 'Rewrite what the model sees',
        target: 'Target',
        kindText: 'Text',
        kindReasoning: 'Reasoning',
        hint: 'After writing, every later turn of this session sees only the edited content (the on-page text stays the original). Compaction summaries are in this target list too.',
        cancel: 'Cancel',
        save: 'Write',
        saving: 'Writing…',
        loading: 'Loading…',
        empty: 'This session has no editable message right now',
        saved: 'Written ✓ the model sees it from the next turn on',
        failed: 'Write failed',
        loadFailed: 'Could not read this session',
        edited: 'Rewritten (model sees the edit)',
        editedCount: '{n} rewritten',
      },
    }

    const CSS = `
.dsh-reply-edit-action{width:calc(28px + var(--dsh-content-font-delta,0px));height:calc(28px + var(--dsh-content-font-delta,0px));
  border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;
  justify-content:center;align-items:center;padding:6px;display:inline-flex;font:inherit}
.dsh-reply-edit-action svg{width:calc(17px + var(--dsh-content-font-delta,0px));height:calc(17px + var(--dsh-content-font-delta,0px))}
.dsh-reply-edit-action:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.dsh-reply-edit-action[data-edited]{color:var(--dsw-alias-brand-primary,#1f6feb)}
.dsh-reply-edit-slot{position:relative;display:inline-flex}
.dsh-reply-edit-dot{position:absolute;right:2px;top:2px;width:5px;height:5px;border-radius:50%;
  background:var(--dsw-alias-brand-primary,#1f6feb);pointer-events:none}
.dsh-reply-edit-count{position:absolute;right:-2px;top:-3px;min-width:14px;height:14px;padding:0 3px;
  border-radius:7px;background:var(--dsw-alias-brand-primary,#1f6feb);color:var(--dsw-alias-label-primary-foreground,#fff);
  font-size:9px;line-height:14px;font-weight:600;text-align:center;pointer-events:none;box-sizing:border-box}
.dsh-reply-edit-mask{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;
  padding:24px;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.42))}
.dsh-reply-edit-card{display:flex;flex-direction:column;gap:10px;width:min(780px,92vw);max-height:84vh;
  padding:14px;border-radius:12px;border:1px solid var(--dsw-alias-border-l2);
  background:var(--dsw-alias-bg-layer-2,Canvas);color:var(--dsw-alias-label-primary,CanvasText);
  box-shadow:var(--dsw-shadow-lv1,0 8px 30px rgba(0,0,0,.35));font-size:13px}
.dsh-reply-edit-head{display:flex;align-items:center;gap:8px;font-weight:600}
.dsh-reply-edit-head .sp{flex:1}
.dsh-reply-edit-x{border:0;background:transparent;color:inherit;font:inherit;font-size:16px;line-height:1;
  cursor:pointer;opacity:.6;padding:2px 6px;border-radius:6px}
.dsh-reply-edit-x:hover{opacity:1;background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16))}
.dsh-reply-edit-target{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.dsh-reply-edit-select{flex:1;min-width:0;font:inherit;font-size:12px;padding:4px 8px;border-radius:7px;
  border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1,Canvas);
  color:var(--dsw-alias-label-primary,CanvasText);outline:none}
.dsh-reply-edit-select:focus{border-color:var(--dsw-alias-brand-primary,#1f6feb)}
.dsh-reply-edit-body{flex:1;min-height:220px;max-height:46vh;resize:vertical;box-sizing:border-box;width:100%;
  padding:10px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);
  background:var(--dsw-alias-bg-layer-1,Canvas);color:inherit;font:inherit;font-size:13px;line-height:1.6;outline:none}
.dsh-reply-edit-body:focus{border-color:var(--dsw-alias-brand-primary,#1f6feb)}
.dsh-reply-edit-note{color:var(--dsw-alias-label-secondary);font-size:11.5px;line-height:1.5}
.dsh-reply-edit-status{font-size:12px;line-height:1.5}
.dsh-reply-edit-status[data-kind=ok]{color:var(--dsw-alias-state-success-primary,#2ea043)}
.dsh-reply-edit-status[data-kind=error]{color:var(--dsw-alias-state-error-primary,#d1242f)}
.dsh-reply-edit-foot{display:flex;justify-content:flex-end;gap:8px}
.dsh-reply-edit-btn{font:inherit;font-size:12.5px;line-height:1.6;padding:4px 14px;border-radius:7px;cursor:pointer;
  border:1px solid var(--dsw-alias-border-l2);background:transparent;color:inherit}
.dsh-reply-edit-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16))}
.dsh-reply-edit-btn[data-primary]{border-color:transparent;background:var(--dsw-alias-button-primary-fill,#1f6feb);
  color:var(--dsw-alias-label-primary-foreground,#fff)}
.dsh-reply-edit-btn:disabled{opacity:.5;cursor:default}
`

    /** JSON 请求；业务失败（ok:false）也走 resolve，交给调用方按 code 处理。 */
    async function call(path, init) {
      const response = await fetch('/api/reply-edit' + path, init)
      try {
        return await response.json()
      } catch {
        return { ok: false, error: 'bad response ' + response.status }
      }
    }

    function postEdit(body) {
      return call('/patch', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-reply-edit': '1' },
        body: JSON.stringify(body),
      })
    }

    /** 下拉里显示的一行摘要，用来认出是哪条消息。 */
    function preview(text) {
      const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
      return flat.length > 32 ? flat.slice(0, 32) + '…' : flat
    }

    // ── 「哪些消息已被改写」的共享缓存 ─────────────────────────────────────
    // 每条消息的操作条都要知道自己的状态，但一个会话只该问宿主一次：
    // 同一 sessionId 共享一个 store，首次用到时拉一次 /marks，写入后主动失效重拉。
    const markStores = new Map()

    function marksStore(sessionId) {
      let store = markStores.get(sessionId)
      if (store !== undefined) return store
      store = { status: 'idle', data: null, listeners: new Set() }
      markStores.set(sessionId, store)
      return store
    }

    function loadMarks(sessionId) {
      const store = marksStore(sessionId)
      if (store.status !== 'idle') return
      store.status = 'loading'
      call(`/marks?sessionId=${encodeURIComponent(sessionId)}`)
        .then(result => {
          store.data = result.ok === true ? result : null
        })
        .catch(() => {
          store.data = null
        })
        .finally(() => {
          store.status = 'ready'
          for (const listener of store.listeners) listener()
        })
    }

    /** 写入成功后丢掉缓存，让所有操作条重新取一次状态。 */
    function refreshMarks(sessionId) {
      const store = marksStore(sessionId)
      store.status = 'idle'
      store.data = null
      loadMarks(sessionId)
    }

    function useMarks(sessionId) {
      const [data, setData] = React.useState(null)
      React.useEffect(() => {
        if (typeof sessionId !== 'string' || sessionId === '') return undefined
        const store = marksStore(sessionId)
        const listener = () => setData(store.data)
        store.listeners.add(listener)
        listener()
        loadMarks(sessionId)
        return () => store.listeners.delete(listener)
      }, [sessionId])
      return data
    }

    return {
      name: NS,
      inject: ['slots', 'locale'],
      apply(ctx) {
        // 样式只注入一份，宿主按 data-plugin 回收。
        ctx.effect(() => {
          const style = document.createElement('style')
          style.dataset.plugin = NS
          style.textContent = CSS
          document.head.appendChild(style)
          return () => style.remove()
        }, 'reply-edit styles')

        let t = key => (STRINGS.zh[key] ?? key)
        ctx.effect(() => {
          const dispose = ctx.locale.register(NS, STRINGS)
          const bound = ctx.locale.bind(NS)
          if (typeof bound === 'function') t = bound
          return dispose
        }, 'reply-edit locale')

        // 复用宿主 UI 原语，按钮与消息操作条里其它动作视觉一致；拿不到就退回内联图标。
        let ui = null
        try {
          ui = require('@deepseek-ai/dsh-client-ui-primitives')
        } catch {
          ui = null
        }
        const EditIcon = ui === null ? undefined : ui.IconEditOutlineRegular
        const kindLabel = block => (block.kind === 'reasoning' ? t('kindReasoning') : t('kindText'))

        function ReplyEditPanel(props) {
          const sessionId = props.sessionId
          const initialMessageId = props.initialMessageId
          const [options, setOptions] = React.useState(null)
          const [selected, setSelected] = React.useState(null)
          const [drafts, setDrafts] = React.useState({})
          const [status, setStatus] = React.useState(null)
          const [busy, setBusy] = React.useState(false)

          React.useEffect(() => {
            let alive = true
            setBusy(true)
            const query = `/targets?sessionId=${encodeURIComponent(sessionId)}`
              + (initialMessageId === null ? '' : `&messageId=${encodeURIComponent(initialMessageId)}`)
            call(query)
              .then(result => {
                if (!alive) return
                if (result.ok !== true) {
                  setOptions([])
                  setStatus({ kind: 'error', text: `${t('loadFailed')}：${result.error ?? result.code ?? ''}` })
                  return
                }
                const flat = []
                for (const target of result.targets) {
                  for (const block of target.blocks) {
                    flat.push({ key: `${target.seq}:${block.blockIndex}`, target, block })
                  }
                }
                setOptions(flat)
                if (flat.length === 0) {
                  setStatus({ kind: 'error', text: t('empty') })
                  return
                }
                // 预选顺序：本消息的正文 → 本消息任意块 → 最近一条压缩摘要 → 最后一个正文块。
                const same = initialMessageId === null
                  ? []
                  : flat.filter(item => item.target.messageId === initialMessageId)
                const preferred = same.find(item => item.block.kind === 'text') ?? same[0]
                const compaction = [...flat].reverse().find(item => item.target.scope === 'compaction')
                const lastText = [...flat].reverse().find(item => item.block.kind === 'text')
                setSelected((preferred ?? compaction ?? lastText ?? flat[flat.length - 1]).key)
              })
              .catch(error => {
                if (alive === false) return
                setOptions([])
                setStatus({ kind: 'error', text: String(error?.message ?? error) })
              })
              .finally(() => {
                if (alive) setBusy(false)
              })
            return () => {
              alive = false
            }
          }, [sessionId, initialMessageId])

          const current = options === null || selected === null
            ? undefined
            : options.find(item => item.key === selected)
          const original = current === undefined ? '' : current.block.text
          const text = current !== undefined && drafts[current.key] !== undefined ? drafts[current.key] : original

          function save() {
            if (current === undefined || busy) return
            setBusy(true)
            setStatus(null)
            postEdit({
              sessionId,
              messageId: current.target.messageId,
              blockIndex: current.block.blockIndex,
              kind: current.block.kind,
              text,
              expect: original,
            })
              .then(result => {
                if (result.ok !== true) {
                  setStatus({ kind: 'error', text: `${t('failed')}：${result.error ?? result.code ?? ''}` })
                  return
                }
                // 真实效果在下一轮请求里（模型所见）；页面正文由宿主的消息渲染决定，本插件不动它。
                setStatus({ kind: 'ok', text: t('saved') })
                setOptions(options.map(item => (item.key === selected ? { ...item, block: { ...item.block, text } } : item)))
                setDrafts({})
                refreshMarks(sessionId)
              })
              .catch(error => setStatus({ kind: 'error', text: String(error?.message ?? error) }))
              .finally(() => setBusy(false))
          }

          const body = h('textarea', {
            className: 'dsh-reply-edit-body',
            value: text,
            autoFocus: true,
            spellCheck: false,
            placeholder: busy ? t('loading') : '',
            onChange: event => setDrafts({ ...drafts, [selected]: event.target.value }),
            onKeyDown: event => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault()
                save()
              }
            },
          })

          return h('div', {
            className: 'dsh-reply-edit-mask',
            role: 'dialog',
            'aria-modal': true,
            onKeyDown: event => {
              if (event.key === 'Escape') props.onClose()
            },
            onMouseDown: event => {
              if (event.target === event.currentTarget) props.onClose()
            },
          },
            h('div', { className: 'dsh-reply-edit-card' },
              h('div', { className: 'dsh-reply-edit-head' },
                h('span', null, t('title')),
                h('span', { className: 'sp' }),
                h('button', { type: 'button', className: 'dsh-reply-edit-x', title: t('cancel'), onClick: props.onClose }, '×'),
              ),
              options !== null && options.length > 0
                ? h('label', { className: 'dsh-reply-edit-target' },
                    h('span', null, t('target')),
                    h('select', {
                      className: 'dsh-reply-edit-select',
                      value: selected ?? '',
                      onChange: event => setSelected(event.target.value),
                    }, options.map(item => h('option', { key: item.key, value: item.key },
                      `${item.target.label} · ${kindLabel(item.block)} · ${preview(item.block.text)}`))),
                  )
                : null,
              body,
              h('div', { className: 'dsh-reply-edit-note' }, t('hint')),
              status === null ? null : h('div', { className: 'dsh-reply-edit-status', 'data-kind': status.kind }, status.text),
              h('div', { className: 'dsh-reply-edit-foot' },
                h('button', { type: 'button', className: 'dsh-reply-edit-btn', onClick: props.onClose }, t('cancel')),
                h('button', {
                  type: 'button',
                  className: 'dsh-reply-edit-btn',
                  'data-primary': '',
                  disabled: busy || current === undefined || text === original || text.trim() === '',
                  onClick: save,
                }, busy ? t('saving') : t('save')),
              ),
            ),
          )
        }

        /** 两个入口共用的触发器：点击开面板，messageId 只用来预选目标。 */
        function ReplyEditTrigger(props) {
          const sessionId = props.sessionId
          const [open, setOpen] = React.useState(false)
          const marks = useMarks(sessionId)
          if (typeof sessionId !== 'string' || sessionId === '') return null

          const initialMessageId = typeof props.messageId === 'string' ? props.messageId : null
          const count = marks?.count ?? 0
          // 标题栏入口（没有 messageId）报「本会话改了几处」，操作条入口报「这条改过」。
          const edited = initialMessageId === null
            ? count > 0
            : (marks?.edited ?? []).some(item => item.messageId === initialMessageId)
          const label = edited
            ? (initialMessageId === null ? t('editedCount').replace('{n}', String(count)) : t('edited'))
            : t('title')

          const icon = EditIcon === undefined
            ? h('svg', {
                viewBox: '0 0 16 16',
                width: 17,
                height: 17,
                fill: 'none',
                stroke: 'currentColor',
                strokeWidth: 1.4,
                strokeLinejoin: 'round',
                'aria-hidden': true,
              }, h('path', { d: 'M11.2 2.4 13.6 4.8 5.6 12.8 2.4 13.6 3.2 10.4z' }))
            : h(EditIcon, { size: 17 })

          const button = h('button', {
            type: 'button',
            className: 'dsh-reply-edit-action',
            'aria-label': label,
            'data-edited': edited ? '' : undefined,
            onClick: () => setOpen(true),
          }, icon)

          const badge = edited === false
            ? null
            : h('span', {
                className: initialMessageId === null ? 'dsh-reply-edit-count' : 'dsh-reply-edit-dot',
              }, initialMessageId === null ? String(count) : '')

          // 角标挂在外层相对定位的壳上（按钮自身不定位，避免影响操作条布局）。
          const shell = h('span', { className: 'dsh-reply-edit-slot' }, button, badge)
          const trigger = ui !== null && typeof ui.Tooltip === 'function'
            ? h(ui.Tooltip, { label, side: 'bottom' }, shell)
            : shell

          const mount = typeof document === 'undefined' ? null : document.body
          const panel = open && mount !== null
            ? ReactDOM.createPortal(
                h(ReplyEditPanel, { sessionId, initialMessageId, onClose: () => setOpen(false) }),
                mount,
              )
            : null
          return h(React.Fragment, null, trigger, panel)
        }

        const register = (slot, order) => () => ctx.slots.register({
          name: slot,
          id: `${NS}:${slot === SLOT_HEADER ? 'header' : 'action'}`,
          order,
          locale: NS,
          label: () => t('action'),
        }, ReplyEditTrigger)

        ctx.effect(() => ctx.slots.inject(SLOT_ACTION, register(SLOT_ACTION, 25)), 'reply-edit assistant action')
        ctx.effect(() => ctx.slots.inject(SLOT_HEADER, register(SLOT_HEADER, 15)), 'reply-edit header action')
      },
    }
  },
})
