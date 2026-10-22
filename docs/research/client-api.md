# DSH Web 插件客户端 half：加载契约、assistant-actions 槽位与最小骨架

> 调研对象：本机安装的 DSH 0.2.1-rc.2（`C:\Users\yuxua\AppData\Local\Programs\DeepSeek Harness\resources\app.asar`）。
> 同时交叉验证了参考实现 `E:\projects\DSHWorkspace\.tmp\dsh-reply-forge-v3`、技能 `cordis-plugin-development` 的
> `references/ui-plugin.md` / `references/host-plugin.md` / `references/practices.md` / `templates/decoration/*`。
> 审查对象：`E:\projects\DSHWorkspace\dsh-reply-edit\client.js`（259 行，lead 版本）。

## 0. 先说结论（可直接执行的五条）

1. **客户端 half 必须是自包含单文件 classic script**：宿主把一个或多个 `client.js` 拼成 combo URL，用
   `<script src>` 注入（`dsh-client-modules/lib/client.js` 原文注释 “Default bundle-load hook: same-origin
   external classic script.”）。因此 **ESM `import`/`export`、相对路径 import 全部不可用**；唯一的模块获取方式是
   `window.__ModuleLoader__.load({ id, factory })` 里的 `factory(require)`，`require` 只能解析内置 seed 表与已注册的
   包 id。参考仓库 `scripts/build-client.mjs` 自己写了个 ESM→CJS 内联器，就是为了这个。
2. **`conversation.chat.assistant-actions` 的 owner props 只有 `{ messageId }`**——没有 seq、没有文本。
   `sessionId` 不在 owner props 里，但它是 **session scope 的标准 prop**，能拿到。文本必须自己取（推荐交给宿主路由）。
3. **`ctx.slots.inject(slot, cb)` 返回 disposer**，`cb` 在槽位已声明时同步执行、否则等声明出现再执行；
   `ctx.slots.register(options, Component)` 返回 disposer。外层再包 `ctx.effect` **冗余但无害**。
4. **fetch 同源可用且不需要手动 token**：页面首请求带 `?token=` 换 Cookie 并重定向到干净的 `./`，之后同源 `fetch`
   自动带 Cookie（见 §5）。但官方约定用 **document-relative** 路径（`api/...`，无前导 `/`），比 `/api/...` 稳。
5. 现有 client.js 有 **1 个确定的显示缺陷**（`<style>` 只在弹层打开时才渲染 → 关闭态按钮没有样式）和 **3 处建议修正**
   （locale 注册未纳入 effect、`id` 建议带包名前缀、弹层建议 `createPortal` 到 body）。逐行见 §7。

## 1. 客户端 half 的加载契约（权威依据）

### 1.1 package.json

```json
{
  "name": "@local/my-reply-edit",
  "type": "module",
  "exports": { ".": "./index.js", "./client": "./client.js" },
  "files": ["index.js", "client.js", "cordis.patch.yml", "locale/*.json", "icon.svg"],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "immediately": true,
      "inject": ["@deepseek-ai/dsh-client-locale", "@deepseek-ai/dsh-client-ui-conversation"],
      "external": []
    }
  }
}
```

`dsh.client` 的字段由 `dsh-client-modules/lib/index.js` 的 `parseDshClient()` 校验，**只认这四个**：

| 字段 | 必填 | 含义 |
|---|---|---|
| `platform` | 是 | 必须是 `"web"`，否则该包不算 web 客户端 |
| `inject` | 否 | 字符串数组；**包名/id**（官方包写的是 `@deepseek-ai/dsh-client-ui-chat` 这类 id）。它被原样写进 `__DSH_BOOT__` 的 rows，但当前浏览器端 `ClientEntries.create(loader, id)` 只用 `{ name: id }` 建 entry，**不拿它做注入等待**；**不是**运行时服务依赖。照官方写法填包名即可，运行时依赖放模块导出 |
| `external` | 否 | 字符串数组；声明“非 seed 的运行时 import”，由启动图提供 |
| `immediately` | 否 | 布尔；是否在首屏 prefetch tier 预取（`TZ.prefetchImmediateTier()` 只对 `immediately` 的模块 preload） |

另外两条硬约束（源码校验，写错直接抛）：

- `exports["./client"]` 必须存在，否则 `MissingClientBundleError: declares dsh.client but exports no "./client" bundle`。
- `exports["./client"]` 只能是字符串或 `{ default: string }`。
- **`window.__ModuleLoader__.load({ id })` 里的 `id` 必须等于 `package.json` 的 `name`**。`stripClientSuffix()` 会把
  `<pkg>/client` 归一成 `<pkg>`，模块表按包名索引（不是 cordis 行 id）。参考仓库 build 脚本从 manifest 读包名生成，
  也是因为踩过这个坑。

运行时服务依赖写在**模块导出**里：`export const inject = ['slots', 'locale']`（等于返回对象上的 `inject: [...]`）。
这里用的是客户端 **Service 名**（`slots`、`locale`、`sessions`、`uiSession`、`remote`…），和 `dsh.client.inject` 不是一回事。

### 1.2 浏览器模块系统

- 启动内核在 `dsh-web-frontend/dist/assets/index-*.js`，它先建 `window.__ModuleLoader__`（queue 模式），再
  `create({ boot, staticModules, ... })` 转 live；之后任何 `client.js` 里的 `load()` 都是“登记 factory”。
- **factory 是懒的**：脚本执行只登记；`factory(require)` 在首次 import/require 时才跑并 memoize（`loadCache`）。
  CSS 注入、事件监听等副作用应放在 factory/apply 内，不要放在脚本顶层。
- 内置 seed 表（`function SZ(){...}`，`react` 就是页面自己的 React 实例，所以 hooks 可用）：

  ```
  react, react/jsx-runtime, react-dom, react-dom/client, @deepseek-ai/cordis, zod,
  @tanstack/react-virtual, @deepseek-ai/dsh-client-store,
  @deepseek-ai/dsh-client-ui-slots, @deepseek-ai/dsh-client-ui-primitives,
  @deepseek-ai/dsh-client-ui-dockkit
  ```

  其它 `@deepseek-ai/*` 包要么通过 `dsh.client.external` 由启动图提供，要么打进单文件。
  ⚠️ `practices.md` 明确要求**不要** `require` primitives/ui-* 这类宿主 UI 包（会随版本变、无类型检查、抛错会空白整个槽位）；
  自己写控件、只共享 `--dsw-alias-*` token。
- 允许的“拆分”只有 bundler 产物级别的 **package-local chunk**（`client.<name>.js`，通过
  `__ModuleLoader__.load({ id, chunk, factory })` 登记），不是普通相对 import；极简插件不要用。

### 1.3 factory 的返回形状

模板 `templates/decoration/client.js` 是权威最小例子：

```js
window.__ModuleLoader__.load({
  id: '@local/my-decoration',
  factory(require) {
    const React = require('react')
    return { inject: ['slots'], apply(ctx) { /* ... */ } }
  },
})
```

- **`factory` 直接 `return { name, inject, apply }` 完全可行**：返回值就是该模块的 exports 对象，cordis Loader 把它
  当插件（对象插件形式，支持 `apply/inject/name`）。参考仓库里的 `var module = {exports:{}}; ... return module.exports`
  只是 rolldown 生成器的写法，两者等价。lead 当前写法 ✅。
- `name` 可选（模板就没有）；cordis 行 id 已由 `__ModuleLoader__.load` 的 `id` 决定。

## 2. slot 注册 API 精确签名

依据：`dsh-client-ui-renderer/lib/client.js` 的 `SlotRegistry`（service 名 `slots`）+ 启动包内 `SlotCore`。

### 2.1 `ctx.slots.inject(key, callback) → () => void`

```ts
inject(key: SlotKey, callback: () => void | (() => void) | Iterable<() => void>): () => void
```

- 槽位已声明：`callback` **同步**执行；未声明：等声明提交后再执行（`subscribeDeclaration` + `declarationEpoch`）。
- 声明坍缩（宿主页面切走/组件卸载）时回收 callback 的返回 disposer，重新声明时再跑一次。
- 返回幂等 disposer。
- 原文注释：“The controller belongs to the caller's fiber, so plugin unload cancels a pending wait and removes any
  active contribution.”

### 2.2 `ctx.slots.register(options, Component) → () => void`

```ts
register(options: {
  name: string                 // 必填，槽位 key
  id?: string                  // kind=list 必填；同一 priority 下同 id 会抛
  key?: string                 // kind=keyed 必填
  select?: (props) => ...      // kind=chain 必填
  order?: number               // list 排序：priority 升序 → order 升序
  priority?: number            // 默认 0；同 cell 高 priority 可遮蔽低 priority
  label?: string | (() => string)  // options.label ?? 允许函数（resolveSlotLabel）
  locale?: string              // 声明后组件自动获得 t
  inject?: (standard, actions) => { props?, hooks?, keyedHooks? }  // 额外注入
  children?: Record<string, { kind: 'single'|'keyed'|'list'|'chain', scope: 'root'|'session'|'session-maybe', inline?: true }>
  store?: ...
}, Component) => () => void
```

- 未声明就 `register` 直接抛：`slot "..." is not declared (a parent entry's children table must declare it)`。
  所以**必须**走 `ctx.slots.inject(SLOT, () => ctx.slots.register(...))`（lead 写法正确）。
- `register` 内部已用 `ctx.effect` 管生命周期，返回 disposer；把它作为 `inject` callback 的返回值即可。
- 组件 props 合成顺序（`renderEntry`）：`kit`（standard） → `injected`（本 entry 的 inject） → `slotInjected.props`
  → `ownerProps`（**最后展开，owner 覆盖其它**）。

## 3. `conversation.chat.assistant-actions` 的真相

### 3.1 声明（`dsh-client-ui-chat/lib/client.js`，`registerConversationNodes`）

```js
ctx.slots.inject("conversation.chat.node", () => ctx.slots.register({
  name: "conversation.chat.node",
  key: "turn-tail",
  locale: NS,
  inject: () => ({ hooks: { performanceUsage } }),
  children: {
    "conversation.chat.turnTail": { kind: "list", scope: "session" },
    "conversation.chat.assistant-actions": { kind: "list", scope: "session" },
  },
}, TurnTailNodeView));
```

→ **kind=list，scope=session，父声明是 `conversation.chat.node` 的 `turn-tail`**。

### 3.2 渲染点与 owner props（同一文件 `TurnTailNodeView`）

```js
const messageId = closing.finalNode.messageId;
const assistantActions = messageId === void 0 ? null
  : renderSlot("conversation.chat.assistant-actions", { messageId });
...
h(MessageIconActions, { text: assistantText(closing.blocks), ..., extraActions: assistantActions, ... })
```

- owner props = **`{ messageId }`，仅此一个**。
- `messageId` 来源：`finalNode = { seq, messageId: event.data.message.id, blocks: toAssistantBlocks(message.content), ... }`，
  即该 turn **最后一条** `assistant/message` 的 message id。`closing === null` 或 `messageId === undefined` 时槽位不渲染。
- 位置：`MessageIconActions` 的 `extraActions`，夹在「复制」和「分支」图标按钮之间；外层 turn-tail 带
  `data-actions-reveal="always" | "hover"`（悬停/常显由宿主控制，插件按钮自然继承）。
- ⚠️ **每个 turn 只渲染一次**（多步 turn 只在最终助手消息上出现一个按钮），不是每个 assistant step 一个。

### 3.3 组件实际能拿到的 props

`StrictSessionEntry` → `SessionEntry` → `standardKit(...)` + `renderEntry(...)`：

1. **owner props**：`{ messageId }`
2. **session scope 标准 props**（`dsh-client-ui-session/lib/client.js` 的 `BUILTIN_SOURCE`）：
   - `sessionId`（`props: { sessionId: binding.sessionId }`）✅
   - `useSession`（hook `session`）、`useProjection`（keyed hook `projection`）、`useAccess`（keyed hook `access`）
3. **`ui-chat` 通过 `ctx.uiSession.provide({ hooks: ["chat"], ... })` 给所有 session scope 条目加的 `useChat`**
4. `t`（**仅当 register 时声明了 `locale`**；`kit.t = localeSeat(face, entry.locale)`）
5. `renderSlot` / `renderFactorySlot`（声明 children 时才有 `renderSlot`；本槽位无 children，故只有 `renderFactorySlot`）
6. `useStore` / `actions`（声明 `store` 才有）

**所以：`sessionId` ✅、`messageId` ✅、`seq` ❌、`text` ❌。**

### 3.4 文本怎么拿

- **推荐（lead 现方案）：宿主路由 `GET /api/reply-edit/blocks?sessionId&messageId`**。客户端不碰投影，
  宿主读自己注册的 projection，模型所见 = UI 所见，最稳。
- 纯客户端备选：`useChat((snapshot) => ...)`（`react.useSyncExternalStore` 包装，selector 返回值必须是
  **稳定引用/原始值**，返回新数组会引发重渲染循环）。节点形状：

  ```js
  // assistant-step 节点：node.data = { status, turn, step, blocks, time, finalNode?, usage? }
  //   node.data.finalNode.messageId === 我们的 messageId
  //   blocks: [{ kind:'text', text }, { kind:'reasoning', text }, ...]
  const text = useChat(snap => {
    for (const n of snap.nodes.values()) {
      if (n.kind !== 'assistant-step') continue
      if (n.data.finalNode?.messageId !== messageId) continue
      return n.data.blocks.map(b => b.kind === 'text' ? b.text : '').join('') // 返回 string 才稳定
    }
  })
  ```

  注意这里的 blocks 是**客户端由 session 事件渲染出来的内容**；宿主侧 message projection 改写是否同步到客户端
  渲染需实测（见 §8 验证项），所以仍推荐“读接口”而不是 `useChat`。
- **不推荐**再注册 `conversation.chat.node` 的 `assistant-step`：该 key 已被官方占用，同 priority 同 key 会抛
  “keyed slot ... already has an entry for key”。

## 4. 最小骨架（<60 行，可直接粘贴；已按权威 API 修正）

```js
// 单文件 classic script。id 必须 === package.json "name"。
window.__ModuleLoader__.load({
  id: '@local/my-reply-edit',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const PKG = '@local/my-reply-edit'
    const NS = 'my-reply-edit'
    const SLOT = 'conversation.chat.assistant-actions'
    const CSS = `[data-ppe-trigger]{height:22px;padding:0 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);
      background:transparent;color:inherit;font:inherit;font-size:12px;cursor:pointer;opacity:.6}
      [data-ppe-trigger]:hover{opacity:1;background:var(--dsw-alias-interactive-bg-hover)}
      [data-ppe-mask]{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;
      background:var(--dsw-alias-bg-mask-1)}
      [data-ppe-card]{width:min(720px,92vw);padding:14px;border-radius:12px;background:var(--dsw-alias-bg-layer-2);
      color:var(--dsw-alias-label-primary);box-shadow:var(--dsw-shadow-lv1);display:flex;flex-direction:column;gap:8px}
      [data-ppe-body]{min-height:220px;resize:vertical;background:var(--dsw-alias-bg-layer-1);color:inherit;
      border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:10px;font:inherit}`

    function Action({ sessionId, messageId }) {
      const [open, setOpen] = React.useState(false)
      const [text, setText] = React.useState('')
      const [note, setNote] = React.useState('')
      const openPanel = () => {
        setOpen(true); setNote('')
        fetch(`api/reply-edit/blocks?sessionId=${encodeURIComponent(sessionId)}&messageId=${encodeURIComponent(messageId)}`)
          .then(r => r.json()).then(j => {
            const b = (j.blocks ?? []).find(x => x.kind === 'text') ?? (j.blocks ?? [])[0]
            setText(b ? b.text : '')
          }).catch(() => setNote('load failed'))
      }
      const save = () => fetch('api/reply-edit/patch', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-reply-edit': '1' },
        body: JSON.stringify({ sessionId, messageId, text }),
      }).then(r => r.json()).then(j => setNote(j.ok ? 'saved' : `failed: ${j.code ?? j.error ?? ''}`))
      return h(React.Fragment, null,
        h('button', { type: 'button', 'data-ppe-trigger': '', onClick: openPanel }, '✎'),
        open && require('react-dom').createPortal(
          h('div', { 'data-ppe-mask': '', onMouseDown: e => { if (e.target === e.currentTarget) setOpen(false) } },
            h('div', { 'data-ppe-card': '', role: 'dialog', onKeyDown: e => { if (e.key === 'Escape') setOpen(false) } },
              h('textarea', { 'data-ppe-body': '', autoFocus: true, value: text, onChange: e => setText(e.target.value) }),
              note && h('div', null, note),
              h('button', { type: 'button', onClick: save }, 'save'))),
          document.body))
    }

    return {
      name: PKG,
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => {
          const el = document.createElement('style')
          el.dataset.plugin = PKG
          el.textContent = CSS
          document.head.append(el)
          return () => el.remove()
        }, 'css')
        ctx.effect(() => ctx.locale.register(NS, { zh: { action: '改写' }, en: { action: 'Rewrite' } }), 'locale')
        ctx.slots.inject(SLOT, () => ctx.slots.register({
          name: SLOT, id: NS, order: 25, locale: NS, label: () => 'Rewrite',
        }, Action))
      },
    }
  },
})
```

要点说明：`require('react-dom')` 也在 seed 表内；CSS 挂在 `style[data-plugin]` 上，便于宿主在自己的
`removeOwnedStyles(id)` 里清理；`t` 若需要可从 `locale` 选项自动获得，也可自己 `ctx.locale.bind(NS)`。

## 5. fetch 的前缀与鉴权（桌面端）

- 页面入口：`dsh-web-app` 用 `connection.authenticatedUrl(webUrl)` 生成 `http://127.0.0.1:<port>/?token=<launchToken>` 并打开；
  `BrowserAuth.authenticateIndex()`：**有效 token → 种 Cookie 并 302 到干净的 `./`**；之后“有效 Cookie 才允许取 index”。
  即鉴权换成了**同源 Cookie**。
- 所以客户端里 `fetch('api/...')` / `fetch('/api/...')`：同源、自动带 Cookie（fetch 默认 `credentials: 'same-origin'`），
  **不需要显式 token、不需要 Authorization 头**。`withCredentials` 只是上传 worker 的显式写法。
- 但官方客户端统一用 **document-relative**（`'/api/x'.slice(1)`）形式，理由是应用可能挂在子目录
  （`dsh-client-modules` 注释 + `dsh-client-ui-deliverables` 的 `CHANGED_FILES_ROUTE = CHANGED_FILES_PATH.slice(1)`）。
  桌面默认根挂载下 `/api/...` 也能用，建议改成 `api/...` 更稳。
- 宿主路由：`ctx.webServer.register({ kind: 'exact' | 'prefix', path, handler(req, res) })`（`webServer` service，返回 disposer）。
  匹配顺序（`dsh-host-webserver/lib/index.js` 的 `match`）：**exact 表优先，然后最长 prefix**。
  `dsh-client-connection` 已占用 `/api` 这个 prefix，所以插件的 `/api/reply-edit` prefix 或 `/api/reply-edit/blocks` exact
  都能先命中，不会冲突。
- 自定义请求头（如 `x-reply-edit: 1`）是防同源误触的约定做法（参考实现用 `x-rf3-forge`），宿主必须校验才有意义。

## 6. 主题 token

`dsh-client-ui-theme/lib/client.js` 里定义了 403 个 `--dsw-*` token。lead 用到的 13 个**全部存在**（已逐个核对）：
`--dsw-alias-bg-mask-1`、`--dsw-alias-border-l1/l2`、`--dsw-alias-bg-layer-1/2`、`--dsw-alias-label-primary`、
`--dsw-alias-label-secondary`、`--dsw-alias-label-primary-foreground`、`--dsw-alias-interactive-bg-hover`、
`--dsw-alias-button-primary-fill`、`--dsw-alias-brand-primary`、`--dsw-alias-state-success-primary`、
`--dsw-alias-state-error-primary`、`--dsw-shadow-lv1`（另有 `--dsw-elevation-*`、`--dsw-shadow-lv1-blur/lv2/lv3`）。

## 7. 对 `dsh-reply-edit/client.js` 的逐行审查

| 行 | 结论 | 说明 / 修法 |
|---|---|---|
| 7-9 | ✅ | `window.__ModuleLoader__.load({ id, factory(require) })` 正确；`@local/dsh-reply-edit` 与 package.json `name` 一致 |
| 10 | ✅ | `require('react')` = 页面同一个 React（seed 表 `react: sC`），hooks 正常。更稳妥的写法只是 `const { useState, Fragment, createElement } = require('react')`，行为相同 |
| 107-118 | ⚠️ | `ctx.locale.register` **没有**放进 `ctx.effect`：插件卸载/HMR 不会回收字典；重复 apply 会抛 `already has locale`（被 try/catch 吞掉，导致改文案不生效）。改成 `ctx.effect(() => ctx.locale.register(NS, STRINGS), 'locale')` |
| 91 | ⚠️ | `fetch('/api/reply-edit' + path)` 在根挂载下可用；建议 `fetch('api/reply-edit' + path)`（document-relative），与官方约定一致 |
| 123-124 | ✅ | `sessionId`（standard prop）与 `messageId`（owner prop）都在；没有 seq/text，靠 `/blocks` 取 ✅ |
| 195-202 | ❌ **确定缺陷** | `<style>` 只在 `open === true` 的 Fragment 里渲染 → **关闭状态下按钮没有任何样式**；且每条助手消息各挂一份 style（N 份重复）。修法二选一：① 把 `h('style', null, CSS)` 放到 `return trigger` 分支（两份都渲染）；② 推荐：在 `apply()` 里 `ctx.effect` 注入 `document.head` + `style.dataset.plugin = PKG`（宿主 `removeOwnedStyles(id)` 会按 `style[data-plugin]` 清理，官方插件都这么做） |
| 220-262 | ⚠️ | 弹层直接渲染在 `MessageIconActions` 的行内 div 里。`.actions` 是 flex 行，`position:fixed` 大多数情况可用，但祖先若有 `transform/filter/contain`，fixed 会被裁剪；且 hover 显隐动画可能影响可见性。**官方做法就是 `react-dom.createPortal(panel, document.body)`**（`dsh-client-ui-chat` 的 TurnUsagePanel/ActivityPill、`dsh-client-ui-conversation` 的 ContextMeter 全都如此），`react-dom` 也在 seed 表里 → 建议改 portal。另有 `shell.overlay` 槽位可作为“第二个注册点”，但 portal 更省事 |
| 265-274 | ✅（冗余） | `ctx.slots.inject` 本身已经用 `ctx.effect` 管生命周期并返回 disposer，外层再包一层 `ctx.effect` 无害但没必要；可以 `ctx.slots.inject(...)` 直接用 |
| 266-272 | ✅ | `{ name, id, order, locale, label }` 全部合法；`label` 支持 `string \| (() => string)`（`resolveSlotLabel`） |
| 268 | ⚠️ | `id: 'reply-edit'` 建议改成带包名的 `'@local/dsh-reply-edit'`，避免与其它插件在同一 list 槽位、同 priority 下撞 id（撞了会抛错，导致本条注册失败） |
| 204-218 | ⚠️ | `Escape` 只在 textarea 聚焦时生效；点过 tab 后焦点离开就关不掉。建议把 `onKeyDown` 挂到 mask 上 |
| 189 | ⚠️ | `setTimeout(..., 900)` 未清理；组件卸载后触发虽多为 no-op，仍建议存 ref 清理 |
| 252-257 | ✅ | `disabled` 条件合理（空文本/未修改不可提交） |
| 261 | ❌ | 同 195 行；`h('style', null, CSS)` 本身是允许的做法（`ui-plugin.md`: component-local styles may render as React elements），问题只在“只在打开时渲染” |
| 全局 | ⚠️ 未验证项 | 宿主 `registerMessageProjection` 改写后，**客户端会话行里的原文是否会同步变化**？客户端 blocks 来自 session 事件；若投影不进 wire，则保存后关闭弹层，消息仍显示原文（需要 DOM 覆盖或重取渲染）。参考 v3 用 DOM 覆盖解决。建议实测一轮，必要时客户端在本条消息上做本地覆盖显示 |

### 顺带发现的宿主侧问题（不是客户端，但会坏打包）

`E:\projects\DSHWorkspace\dsh-reply-edit\package.json` 的 `files` 与运行时文件不一致：

- 列了 **`lib/persist.js`（不存在）**；
- 漏了 **`lib/stamp.js`（存在，且 `lib/routes.js` 第 9 行 `import { state } from './stamp.js'`）**。

本地 link 方式安装时 `files` 不过滤，所以现在能跑；但一旦 pack/publish 或按技能要求核对打包清单，
会漏 `stamp.js` 而宿主 half 直接 import 失败。技能 `host-plugin.md` 明确要求 `files` 覆盖每个运行时文件。

## 8. 证据与未能完成的验证

**证据（均读自本机 app.asar，路径相对 `resources\app.asar\dsh\node_modules\@deepseek-ai\`）**

| 结论 | 文件 |
|---|---|
| 加载钩子是 classic script、seed 表、`parseDshClient` 字段、relative 约定、chunk | `dsh-client-modules/lib/client.js`、`dsh-client-modules/lib/index.js`、`dsh-web-frontend/dist/assets/index-CN7NIWNw.js`（`function SZ`） |
| `slots.inject/register/provideRoot/installScope`、props 合成顺序、`standardKit`、`StrictSessionEntry` | `dsh-client-ui-renderer/lib/client.js` |
| `SlotCore.register` 校验（id/key/select、priority/order、label 函数）、`resolveSlotLabel` | `dsh-web-frontend/dist/assets/index-CN7NIWNw.js`（`SlotCore` 段） |
| assistant-actions 声明、`renderSlot(..., { messageId })`、`MessageIconActions.extraActions`、finalNode 形状 | `dsh-client-ui-chat/lib/client.js` |
| `BUILTIN_SOURCE: props ["sessionId"]`、session adapter | `dsh-client-ui-session/lib/client.js` |
| `ctx.uiSession.provide({ hooks: ["chat"] })` → `useChat` | `dsh-client-ui-chat/lib/client.js` |
| 鉴权（token→Cookie）、`API_PATH`/`/connect` | `dsh-client-connection/lib/index.js`、`dsh-web-app/lib/index.js` |
| `webServer.register/WebRoute`、exact 优先 + 最长 prefix | `dsh-host-webserver/lib/index.js` |
| 403 个 `--dsw-*` token | `dsh-client-ui-theme/lib/client.js` |
| portal 官方用法 | `dsh-client-ui-chat`、`dsh-client-ui-conversation`（`react_dom.createPortal(..., document.body)`） |
| 技能规范 | `cordis-plugin-development/references/ui-plugin.md`、`practices.md`、`templates/decoration/*` |
| 参考实现 | `.tmp/dsh-reply-forge-v3/scripts/build-client.mjs`（为何必须内联单文件）、`.dsh-plugin/client/index.mjs`（v3 用 DOM 注入而非槽位：“只注入，不注册”）、`package.json`（`exports["./client"]`、`dsh.client`） |

**未完成**：`cordis_inspect_query(platform='client', provider='Slots'/'Builtin'/'Theme')` 在本会话全部 10s 超时
（原文 `Client inspect query ... timed out after 10000ms. Open or reconnect the Harness page, then retry.`）。
因此槽位 catalog 与 token 列表改用“已编译客户端包 + 宿主 SlotRegistry/SlotCore 源码”取证（如上表），
两者结论一致；建议在有页面连接时再跑一次这三条 query 做交叉验证（尤其 `Slots.listSubTree(root='conversation.chat.assistant-actions')`
可以直接确认 props 只有 `{ messageId }`）。
