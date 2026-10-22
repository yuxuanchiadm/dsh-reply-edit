# DSH 宿主侧最小可行路径（message projection + append + ignorable）

> 调研对象：本机安装的 DeepSeek Harness（asar 包），**不是** master 源码。
> - asar：`C:\Users\yuxua\AppData\Local\Programs\DeepSeek Harness\resources\app.asar`
> - 包版本：`@deepseek-ai/dsh-session` = `0.2.1-rc.2`（`package.json:4`）；`SESSION_FORMAT_VERSION = 4`（`dsh-session/lib/index.js:56`）
> - DSH home / profile：`C:\Users\yuxua\.dsh`，profile = `desktop`
>
> **证据方法**：asar 是单文件，shell/glob/grep 读不了、`read` 工具能读单个文件。为了能用 grep 逐行定位，写了一个零依赖 asar 解析器
> `.tmp/hostapi-tools/extract.mjs`，把相关包解到 `.tmp/hostapi-src/`（只读取证，未改任何宿主文件）。
> 下文行号全部来自**asar 内的真实文件**（解包后的字节与 asar 内一致）。为简洁，约定：
> - `SESS = dsh/node_modules/@deepseek-ai/dsh-session/lib/index.js`（**宿主实际加载的 bundle 入口**，Session/SessionStore 的唯一实现）
> - `PCORE = dsh/node_modules/@deepseek-ai/dsh-session-persistence/lib/index.js`
> - `JSONL = dsh/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js`
> - `Q = dsh/node_modules/@deepseek-ai/dsh-session-query/lib/index.js`
> - `API = dsh/node_modules/@deepseek-ai/dsh-api-session-controller/lib/index.js`
> - `LOOP = dsh/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js`
> - `CORDIS = dsh/node_modules/@deepseek-ai/cordis/lib/index.js`
>
> 另：`dsh-session/lib/types/*.js` 是同一份源码的可读 ESM 模块（`@deepseek-ai/dsh-session/surface`、`/fork` 等子路径用），
> 而 `Session`/`SessionStore` 只从 `lib/index.js` 加载（唯一副本）。必要处同时给出两边行号。

---

## 0. 结论速览（TL;DR）

1. **`ctx.sessions.registerMessageProjection(projection)` 存在**，签名/形状与调研前预期一致；注册后由宿主的 surface 折叠在**接受事件时同步调用** `project()`，返回 `Map<seq, Message>` 覆盖「该 seq 模型可见的消息」。这就是「改完立即被模型采信」的正门。
2. **`Session.append(type, data, ...opts)` 没有第二个 options**：非 surface 事件只接受 `[]`；信封里 **不存在从 append 参数注入 `ignorable` 的路径**。`ignorable: true` 只有一条官方产生路径：`appendPluginRecord()` → `#appendRecord()`（`SESS:1548-1562`）。
3. **持久化读取闸门是 fail-closed**：未知 type 且 `ignorable !== true` → `SessionFormatUnsupportedError`，该会话**日志整条拒读（会话打不开）**；但 `stat`/`list` 只读 header，所以**列表里还看得见**，更隐蔽。
4. **最小打标记 seam 不在持久化层，而在 `Session.prototype.commit`**（`SESS:1579`）。在 commit 内给「自己的 type」换一个 `ignorable:true` 的冻结信封，再交给原 commit，只需 **~12 行**；它比包 `persistContiguous` 更小、更安全（所有落盘路径都从 log 出发，包括 `handle.append(seed)`、fork、未来格式迁移）。
5. 当前实现 `dsh-reply-edit` 的持久化假设**全部成立**（seam 行号见 §3.3），但有 **1 个会直接导致插件加载失败的 Cordis effect 用法错误**（`index.js:23`），以及类型命名、热卸载两个隐患（§5）。
6. **UI 打开历史会话 ≠ 立刻 `sessions.get()` 拿到活对象**：历史会话先以「prepared（未入 store）」形式被读取，随后**异步 promote（resume）**才 enter + announce。所以存在一个「已显示但拿不到活会话」的窗口；`page`（翻页）不 promote，subagent 地址不 promote，resume 失败则永远 live 不了（§4）。

---

## 1. `ctx.sessions` 服务契约（逐项证据）

### 1.1 服务与注册方法

`SessionStore` 是 `sessions` 服务的实现（`SESS:1714`），`registerMessageProjection` 在 `SESS:1729-1737`：

```js
registerMessageProjection(projection) {
  if (this.projections.some((item) => item.type === projection.type)) throw new Error(...already registered)
  return this.ctx.effect(() => {
    this.projections.push(projection)
    return () => { this.projections.splice(this.projections.indexOf(projection), 1) }
  }, 'sessions.registerMessageProjection()')
}
```

- **签名**：`registerMessageProjection(projection: SessionMessageProjection): () => Promise<void>`（cordis Service 目录同样是这个签名；返回的是 fiber effect 的 disposer 函数，**不是** Promise 本身）。
- **抛错**：同一 `type` 已注册时抛 `session message projection "<type>" is already registered`（`SESS:1730`）。热重载时必须 `try/catch`（参考实现就是这么做的）。
- **没有对 `type` 做白名单校验**：任意字符串都行（这正是外部插件自有事件类型的入口）。
- **投影数组是按引用借出的**：`prepare()` 把 `this.projections` **同一个数组**传给 `Session.create`（`SESS:1829`；可读版 `types/index.js:482` `new SurfaceManager(this.log, 0, projections)`），折叠时每次 `projections.find(...)` 现查（`SESS:429`）。因此**注册晚于会话构造也能生效**——但只对「还没折叠过的事件」生效（见 §1.4 的坑）。

### 1.2 projection 对象形状

```ts
interface SessionMessageProjection<T extends SessionEventType = SessionEventType> {
  type: T
  project(event: SessionEvent<T>, context: SessionMessageProjectionContext): ReadonlyMap<SessionSeq, Message>
}
interface SessionMessageProjectionContext {
  nodes: readonly SessionSeq[]      // 当前 surface 上的节点 seq，模型可见顺序
  events: readonly SessionEvent[]   // 折叠用的整段事件窗口（events[i] 的绝对 seq = baseSeq + i）
  baseSeq: SessionLogOffset         // events[0] 的绝对 seq（活会话恒为 0）
  messages: ReadonlyMap<SessionSeq, Message>  // 之前所有 project 已产生的投影消息
}
```

调用点：`planSurfaceEvent`（`SESS:425-457`），关键 6 行：

```js
const projection = projections.find((item) => item.type === event.type)
if (projection !== void 0) return {
  kind: "project",
  projection,
  messages: projection.project(event, {
    nodes: state.nodes,        // 尚未包含当前事件（append 时它还没入 log）
    events,                    // = this.log（append 时不含当前事件）
    baseSeq,
    messages: state.projectedMessages,
  }),
}
```

- 命中投影 → `kind:'project'`，**不推进 `nodes`**；`applySurfacePlan` 把返回的 `Map` 写进 `state.projectedMessages` 并 `contentGeneration += 1`（`SESS:463-472`）。
- 未命中投影 → 普通 surface 逻辑：未知类型且无 `surfaceOp`/`sourceEventSeqs` 时 `surfaceOpOf` 直接 `return undefined`，**既不报错也不进 surface**（`SESS:298` 起；可读版 `types/surface.js:201-213`）。
- `MESSAGE_PROJECTION_EVENT_TYPES` 只有 `image/offload`（`SESS:144`）；只有该集合的成员缺投影才抛（`SESS:440`）。**我们自有的未知类型缺投影是「静默不进 surface/不生效」，不会让会话打不开**。
- `deriveEventMessage(event, projectedMessages)` 先查 `projectedMessages.get(event.seq)`，命中直接返回投影消息（`SESS:217-218`）；`deriveMessages()` 遍历 `surface.nodes` 调它（`SESS:1672` 起；可读版 `types/index.js:812-834`）。模型请求取历史就是 `session.deriveMessages()`（`LOOP:1274`）。

**对「立即生效」的含意**：只要我们的 patch 事件已 commit 且投影已注册，下一次 `deriveMessages()` 就会带上改写内容，不需要重启/重新打开会话。

### 1.3 `Session.append` 精确签名与信封

```ts
append<T extends SessionEventType>(type: T, data: SessionEventMap[T],
  ...opts: T extends SurfaceEventType ? [opts: SurfaceIntent<T>] : []): SessionEvent<T>
```

实现（`SESS:1517-1538`）：

```js
append(type, data, ...opts) {
  const surfaceOpts = opts[0]
  const surfaceMetadata = {                       // 只认这两个字段
    ...surfaceOpts?.sourceEventSeqs === void 0 ? {} : { sourceEventSeqs: surfaceOpts.sourceEventSeqs },
    ...surfaceOpts?.surfaceOp      === void 0 ? {} : { surfaceOp: surfaceOpts.surfaceOp },
  }
  const dataSnapshot = snapshotJsonValue(data)    // 必须是 lossless JSON（否则抛）
  ...
  const event = deepFreeze({ type, seq: SessionSeq(this.log.length), time: Date.now(), data: dataSnapshot, ...surfaceMetadataSnapshot })
  validateSessionEventData(event, `session event "${type}" at seq ${event.seq}`)
  this.commit(event, entry)
  return event
}
```

- **没有 `ignorable` 参数**；`opts[0]` 里除 `surfaceOp`/`sourceEventSeqs` 之外的键（例如 `{ignorable:true}`）会被**静默丢弃**。
- 信封字段就 6 个：`type/seq/time/data/surfaceOp?/sourceEventSeqs`；**`ignorable` 完全不在 append 路径中出现**。
- 运行时 TypeScript 类型只是注释；**未知 type 在运行时可以 append**（见 §1.4 的闸门清单）。
- 唯一给信封加 `ignorable` 的内部路径：`#appendRecord`（`SESS:1548-1562`）——`appendPluginRecord(session,type,data)`（`SESS:1295-1297`）经 module-private `commitPluginRecord`（`SESS:1539-1541`）调它，构造 `{type,seq,time,data,ignorable:true}` 后走同一个 `commit`。这里同时校验 `type` 必须是 `plugin:` 语法（`SESS` 里 `PLUGIN_RECORD_TYPE`，可读版 `types/index.js:332-340`）。

### 1.4 append 的完整前置闸门（回答「除了持久化还有没有别的校验」）

`append` → `commit`（`SESS:1579`）→ `surfaceManager.validateNext`（`SESS:528-536`）的完整检查顺序：

1. `snapshotJsonValue(data)`：非 lossless JSON（BigInt/函数/undefined/NaN/循环/稀疏数组/Map 等）→ 抛，**未入 log**（`SESS:1523-1526`）。
2. `publicationEntry()`：正在发布另一次 append 时重入 → 抛（`SESS:1568-1572`）。
3. `deepFreeze(envelope)`：deepFreeze 后事件不可再改（`SESS:1528`）。
4. `validateSessionEventData(event, ...)`（`SESS:1535`，实现 `types/surface.js:118-...`）：只校验 **已知 surface 类型**的角色/工具块/`request/header` 空字段/tool error 一致性；**未知 type 直接通过**。
5. `commit` → `validateNext`：`_assertProjections()`（`SESS:580-591`）——若本会话此前用过、而**现已从 store 撤掉**的投影，会抛 `session message projection "..." was removed or replaced; restore the session with its owning plugin`。**注意：这是对所有后续 append 都生效的，不只是我们的事件**（热卸载插件的后果，见 §5.4）。
6. `_processDelta()`：只折叠未见过的已提交事件（`SESS:542-558`）。
7. `planSurfaceEvent`（`SESS:425`）：
   - `validateSurfaceMetadata` → `surfaceOpOf`：对**非 surface-eligible 且宿主不认识**的 type，若不带 `surfaceOp`/`sourceEventSeqs` 就 `return undefined`；**若带了会抛**（`... is not surface-eligible and cannot carry surfaceOp`）。我们 append 不带 opts，安全。
   - `assertDeveloperHeader` 只对 `developer/message` 生效。
   - **`projection.project()` 在这里被同步调用**（`SESS:429-439`）。
8. `commit` 真正入 log（`this.log.push`）并同步发 `session/event`（`SESS:1590-1592`）。

> ⚠️ 第 7 步是本实现的关键副作用：**投影异常会让 append 直接抛错、事件不落 log**。
> 因此 `project()` 必须自己 try/catch 兜底（当前 `dsh-reply-edit/lib/projection.js` 已做到）；反过来，如果投影健壮，append 不会被额外拒绝。
> 另外，`validateNext` 会在 append 时就算出投影消息（`_pendingPlan`），随后 `_processDelta` 复用该 plan（`SESS:549-554`），所以**追加一条 patch 时，投影就会看到 `context.messages` 中此前 patch 的投影结果**——多 patch 叠加在 append 时也是对的。

---

## 2. 持久化读取闸门（`ignorable` 为什么是必须的）

### 2.1 闸门源码

`PCORE:182-197`：

```js
function validateStoredEvents(meta, events, location) {
  for (const event of events) {
    if (!KNOWN_SESSION_EVENT_TYPES.has(event.type) && event.ignorable !== true)
      throw unsupported(`session "${meta.id}" contains event type "${event.type}" (seq ${event.seq}) unknown to this harness and not marked ignorable; refusing to interpret the log — it was likely written by a newer harness`, location)
    ...
  }
  for (const [index, event] of events.entries()) events[index] = adoptSessionEvent(event)
  ...
}
```

- `unsupported(...)` → `SessionFormatUnsupportedError`（`PCORE:148-151`）。
- 调用点（JSONL 后端）：
  - 普通冷读 `decodeStoredLog`：`JSONL:2868`（`readStoredLog` 入口 `JSONL:2826-2837`，`SessionHandle.read` 调它）；
  - 历史格式迁移：`JSONL:2764`；
  - 读取时若解析阶段已判格式不支持，也统一转成带 raw log 路径的 `SessionFormatUnsupportedError`（`JSONL:2855-2861`）。
- `KNOWN_SESSION_EVENT_TYPES` 是生成本（`SESS:79` 起；独立模块 `types/known-event-types.js:21-84`），其中**没有**任何外插件 type；注释明确「Downstream (out-of-repo) plugin events are outside this list by construction. The persisted `SessionEvent.ignorable` marker is the compatibility mechanism」（`types/known-event-types.js:14-19`）。
- 信封校验允许 `ignorable`，但只在它为 `true` 时接受：`assertSessionEventEnvelope`（可读版 `types/index.js:128-156`，`ignorable !== undefined && ignorable !== true` → 抛）；`adoptSessionEvent` 同（`SESS` 同逻辑）。

### 2.2 后果（「什么样会漏标记 → 会话打不开」）

| 漏标记的路径 | 结果 |
|---|---|
| JSONL 文件里出现一条 `{"type":"reply-edit/patch",...}` 而**没有** `ignorable:true` | 下次任何 `read`/`open`/`history.page`/`follow` → `validateStoredEvents` 抛 `SessionFormatUnsupportedError`；`stat`/`list` 只读 header（`JSONL:2570-2596`），所以**列表还能看到、点开就报错** |
| 事件在内存里但没走到持久化 | 无坏文件（丢事件而已）；`stat` 的 pending 也不会暴露 |
| 从磁盘读出的既有事件（已带标记）再被迁移/复制 | 标记随信封复制，安全 |

**注意 `stat`/`list` 不校验 events 这一点**：出问题时不会「会话消失」，而是「会话在列表里但永远打不开」——这类故障比丢会话更难排查，所以 fail-closed 拒绝在线写入是对的。

---

## 3. 最小打标记方案（三选一，含代码与风险）

### 3.1 方案 A（官方信封，但对外插件不合规）：`appendPluginRecord`

```js
// 仅当能拿到与宿主同一个模块实例时才可行
const mod = await import(urlToAsarDshSession)   // file:///.../app.asar/dsh/node_modules/@deepseek-ai/dsh-session/lib/index.js
if (mod.Session !== Object.getPrototypeOf(liveSession).constructor) throw new Error('module instance mismatch')
mod.appendPluginRecord(liveSession, 'plugin:reply-edit/patch', data)  // 返回 seq；信封自带 ignorable:true
```

- **优点**：宿主自己加标记（`SESS:1557`），零 monkey-patch；type 天然进 `plugin:` 命名空间。
- **可行前提**：宿主是按 ESM 从 asar 内 `node_modules` 加载这些包的（我抽查的包都是 `import ... from "@deepseek-ai/..."`，见 `JSONL:1-20`），所以理论上绝对路径 import 会命中**同一个 ESM 实例**；但**无法在未安装插件的情况下实证**（纯 Node 进程读不了 asar）。必须运行时校验 `mod.Session === 活会话的 constructor`；不一致时 `#appendRecord` 会因私有方法接收者不匹配**在 commit 前抛错**（fail-closed，不会写坏）。
- **硬约束**：README 明确写「Plugins outside this repository must not call it either」（`dsh-session/README.md:70`），并说这是给 `packages/experimental/` 的 API——**合规风险**，未来宿主可能加运行时限制。
- **type 语法**：必须 `plugin:<owner>/<record>`（`types/index.js:332-340`）。
- 结论：**不作为首选**，可作为「最小行数」备选。

### 3.2 方案 B（推荐）：在 `Session.prototype.commit` 上补标记

**为什么可行**：`append` 与 `#appendRecord` 唯一的汇合点是 `commit(event, entry)`（`SESS:1579`），它负责 `validateNext` → `log.push` → 发 `session/event`（`SESS:1580-1592`）。事件在进 log **之前**是 append 构造的冻结对象，`commit` 参数还没入 log，**可以替换成新的冻结对象**。替换后：

- log 里的事件自带 `ignorable:true` → `snapshotEvents()` / `eventAt()` / fork seed / `handle.append(seed)` / `session/event` 观测者 / 持久化 `enqueueLive` **全部自然带上标记**；
- surface 折叠对「未知 + ignorable」的处理与「未知」等价（`SESS:298-313` 的 `surfaceOpOf` 两者都返回 undefined；`types/surface.js:204-206` 对 ignorable 直接 return）；
- 不需要 `ctx.reflect.get('sessionPersistence')`，不需要 tracker/写句柄，不需要按会话核验 writer 路由。

**代码（≤15 行，已验证所有依赖行为）**：

```js
// 本插件自己的事件类型
const OWN_TYPE = 'plugin:reply-edit/patch'
const BRAND = Symbol('dsh-reply-edit.ignorable-stamp')
const patchedProtos = new WeakSet()

function installCommitStamp(session) {
  const proto = Object.getPrototypeOf(session)
  if (typeof proto?.commit !== 'function') return false      // 宿主结构变了 → fail-closed
  if (patchedProtos.has(proto)) return proto.commit[BRAND] === true
  const original = proto.commit
  const wrapper = function (event, entry) {
    if (event !== null && typeof event === 'object' && event.type === OWN_TYPE && event.ignorable !== true) {
      event = Object.freeze({ ...event, ignorable: true })   // 未入 log，替换安全
    }
    return original.call(this, event, entry)
  }
  Object.defineProperty(wrapper, BRAND, { value: true })
  proto.commit = wrapper
  patchedProtos.add(proto)
  return true
}

/** 写前核验：这个会话的 commit 是否确为本插件的包装（否则拒绝写自有事件）。 */
function stampReady(session) {
  const proto = Object.getPrototypeOf(session)
  return proto?.commit?.[BRAND] === true
}
```

安装时机（三处任选，建议全做，均为同步、无 I/O）：

1. `apply(ctx)` 里若有活会话：`for (const s of ctx.sessions.list()) installCommitStamp(s)`；
2. `ctx.on('session/created', (s) => installCommitStamp(s))`（resume 也会走 enter+announce，见 §4，所以历史会话恢复时也会被覆盖）；
3. 写路径里 `sessions.get(id)` 成功后调用一次（兜底，并承担核验职责）。

**风险 / 失败模式（逐条）**：

| 情况 | 后果 | 缓解 |
|---|---|---|
| 宿主升级把 `commit` 改名/改为私有 `#commit` | 我们的事件**不带标记**就落盘 → 会话打不开 | 写前 `stampReady(session)` 为 false 就**拒绝**写自有事件（fail-closed，绝不留坏事件）；插件整体仍可加载 |
| 用户在「补丁安装前」已经用旧版本插件写过未标记事件 | 那些**旧**事件仍在磁盘上，风险不因新补丁消失 | 需要一次性 repair（参考实现 `src/session-repair.mjs` / `修复会话.bat`），或至少检测并提示 |
| 同一进程里有第二份 dsh-session 实例 | `Object.getPrototypeOf` 拿到另一份原型，patch 不到目标 class | `stampReady` 按会话实测，false 即拒写；不会写坏 |
| 宿主在 `commit` 内做「事件对象身份」比对 | 我们换了对象身份，理论上会被发现 | 已核对本版本：`validateNext` 的 `_pendingPlan.event === event` 判定用的是**我们传入的新对象**（`SESS:549`），commit 之后没有任何「append 返回值 === log 里的对象」的断言；`append` 返回的是**未标记的旧对象**（仅返回值有此差异，语义无影响） |
| 事件已经写进 log 后才补 patch | 不影响：补丁只影响之后的 append | — |

**代价**：`append()` 的返回值仍是未标记事件（`SESS:1537` 返回的是原对象）。若调用方自己拿返回值去 `handle.append(...)`（本版本没有这种写法；唯一的 `handle.append` 调用方用的是 `session.snapshotEvents()`，见 `LOOP:1881-1885`），会漏标——但本插件不这么做。

### 3.3 方案 C（当前实现，可行但代码面更大）：包装写句柄 `persistContiguous`

**当前 `lib/persist.js` 的全部假设，本机版本均成立**（逐条证据）：

| 假设 | 证据 |
|---|---|
| 服务名是 `sessionPersistence` | `PCORE:261-265` `var SessionPersistence = class extends Service { ... super(ctx, "sessionPersistence") }`；`JSONL:2403` 子类、`JSONL:2429` `super(ctx)` |
| 后端有 `tracker.writers: Map` | `JSONL:2405` `tracker;`；`JSONL:2428-2431` `constructor(ctx, config, tracker) { this.tracker = tracker }`；`JSONL:281` `writers = new Map()`；`JSONL:409-410` install 中 `const { writers, ... } = this` |
| 写句柄有 `access`（`'read'|'write'`）、`id` | `JSONL:29-34` 字段声明（`storage/id/header/access/state/lease`）、`JSONL:44-51` 构造赋值；`JSONL:363` `if (handle.access === "write") this.writers.set(...)` |
| 两条写入路径都收敛到 `handle.persistContiguous(batch)` | 显式 append：`JSONL:117-123`（`materializeAppendBatch` → `persistContiguous`）；live 路由：`JSONL:200-221`（`drainBuffered` → `materializeAppendBatch` → `persistContiguous`，`session/event` 经 `JSONL:421-425` → `enqueueLive`） |
| 到达 `persistContiguous` 的 batch 是**深拷贝**、可安全改写 | `PCORE:218-222` `materializeAppendBatch = snapshotJsonValue(events)`；`JSONL:119/214` 两处都先 materialize；`enqueueLive` 另做 `structuredClone`（`JSONL:188`） |
| `persistContiguous` 是**原型方法**，可被实例自有意属性覆盖 | `JSONL:223` `async persistContiguous(batch) {`（class 表达式 `var JsonlSessionHandle = class {...}`，`JSONL:28`） |
| `adopt(handle)` 是句柄进入 writers 的唯一构造入口 | `JSONL:361-365`；四个构造点 `JSONL:2475/2494/2518/2532` 全部 `this.tracker.adopt(new JsonlSessionHandle(...))` |
| `writers.set` 也会被非 adopt 路径使用（兜底钩子有价值） | `JSONL:302`（created→null）、`JSONL:316`（claimWrite→null）、`JSONL:363`（adopt→handle）；注意包 `writers` 实例的 `set` 只是给 `null` 也会走到 `patchHandle(null)`（安全） |

结论：**方案 C 在本机版本可用**。相对方案 B 的额外风险：

1. 依赖 `sessionPersistence` 的**内部结构**（服务名 + `tracker` + `writers` + 方法名）比依赖 `Session.prototype.commit` 多 3 层；任一变化就要重写适配。
2. 只有「拿到写句柄」的会话才安全：`writerReady` 为 false 时必须拒写（当前实现已做），否则**新会话**会写出缺标记的事件（参考实现 `server/ignorable.mjs` 文件头复盘的就是这个 bug）。
3. 内存中的 log 事件**没有**标记；任何绕过写句柄/`persistContiguous` 的落盘路径（若未来版本新增）都会漏标。方案 B 不存在这个问题。
4. 代码量：方案 C 约 40-60 行（含注册/幂等/核验/健康状态），方案 B 约 12-20 行。

**方案 C 的可直接改进点**（不改架构）：

- `tracker.adopt` / `writers.set` 的赋值要包 `try/catch`（原型/Map 被冻结时不要抛穿 `apply`）；
- `writerReady` 里 `install(null)` 也要 `try/catch`，失败返回 false（当前若 install 抛，route 会 500 而不是 `APPEND_UNSAFE`）；
- 补上 `handle.id === sessionId` 与 `handle.storage?.persistBatch` 的结构核验（参考实现 `verifySessionWriter` 有，当前 `writerReady` 只查 brand）；
- 不要只信「句柄被包过」，还要确认 `persistContiguous` 仍是自己的包装（brand 在，已做）且在 `install` 后宿主没替换原型（brand 会消失，已覆盖）。

---

## 4. UI 打开历史会话时，`sessions.get(id)` 到底拿不拿得到活对象？

### 4.1 调用链（证据）

1. 浏览器端订阅会话时调用 `remote.session.follow(...)`（`API` 的 client half `lib/client.js:431`）。
2. 服务端 `SessionHistoryController.follow`（`API:1510-1630`）：先用 `sourceFor()` 取快照。
3. `sourceFor` → `ctx.sessionQuery.observeSession(...)`（`API:1631-1653`）。
4. `SessionObservationReader.read`（`Q:350-397`）：
   - `this.ctx.sessions.get(sessionId)` 命中 → `source:"live"`（`Q:354-355`, `Q:477-508`）；
   - 否则读持久化，然后 **`this.ctx.sessions.prepare(sessionId, {seed, meta, inheritedEventCount, eventState})`**（`Q:370-379`）——**prepare 不进 store**（`SESS:1799-1829`，`return Session.create(...)`；`enter` 才是入 store，`SESS:1853`）；
   - 返回 `source: "prepared"` 的租约（`Q:450-476`，字段 `455`）。
5. `follow` 在把快照 yield 给客户端之后：`if (address.kind === "session" && source.source === "prepared") { const promotion = source.retain(); this.promote(promotion) }`（`API:1586-1594`）。
6. `promote`（`API:2967-2969` 构造、`API:3006-3031` 实现）→ 后台任务 `agents.resolveObservedAgent(observation)`。
7. `resolveObservedAgent` → `resumeObserved` → `this.ctx.agents.resume({resumeSessionId, ...})`（`API:392-404`）。
8. `AgentLoop.resumeWith`（`LOOP:1969+`）：`persistence.open(id, "write")`（`LOOP:1986`）→ `handle.read` 冷读 → `sessions.prepare`（`LOOP:1994`）→ `setupAndPublish` → `initializeAgent` → **`enter(session)` + `announce(session)`**（`LOOP:1790-1792`，在 `publish()` 里）→ 此刻 `sessions.get(id)` 才返回活对象。

### 4.2 结论（要写进插件设计的）

- **不是「总在」**，也**不是同步**：点开历史会话后，先有一段「prepared 只在观察缓存里（LRU 容量 5，`Q:339`）、store 里没有」的窗口；promote 成功后才 live。窗口内 `sessions.get()` 返回 `undefined`。
- **`page()`（向前翻页）不 promote**：只有 `follow` 路径会 promote（`API:1586` 的条件）。只翻历史不订阅的场景不会变 live。
- **subagent 会话不 promote**：条件是 `address.kind === "session"`；subagent 地址走另一条。
- **promote 可能失败并保持「可看不可写」**：`resumeObserved` 在 `cwd === undefined` 时抛 `ApiSessionNotFound`（`API:393`）；被其它 writer 占用时抛 `SessionAlreadyOwnedError` → `session/writer-held`（`API:243`）；preset/setup 失败也会让后台任务失败并 `emit('api-session/error')`（`API:3017`、`3024-3026`）——此时会话仍能在 UI 显示（读走持久化），但 `sessions.get()` 永远返回 undefined。
- **对插件的影响**：
  - 「打开会话 → 立刻改写」会偶发/稳定地拿到 `SESSION_NOT_LIVE`；应在路由层**短暂重试**（例如 5-10 次 × 200ms，或监听 `session/created` / `api-session/added` 后再刷新 UI），而不是直接报错；
  - 反过来：`writerReady`（写句柄存在）可能**早于** `sessions.get()`（resume 先 `open("write")` 再 prepare/enter，`LOOP:1986/1994/1790`），所以两个检查都要做，且失败原因要区分「还没恢复完」与「永远不会 live」；
  - 会话是否 live 应以 `sessions.get(id) !== undefined` 为准，不要用持久化 `stat` 推断。

---

## 5. 对当前 `dsh-reply-edit` 实现的逐条核对

> 代码位置：`E:\projects\DSHWorkspace\dsh-reply-edit`。以下只列**与证据冲突/有风险**的点，其余（投影形状、块读写、messageId 定位、STALE 校验、reasoning 去签名、fail-closed 拒写）与宿主行为一致。

### 5.1 🔴 会直接导致插件加载失败：`ctx.effect(() => install(ctx), ...)`

`index.js:23`：

```js
ctx.effect(() => install(ctx), 'reply-edit ignorable shim')
```

`install()` 返回的是**普通对象** `health`（`lib/persist.js:69/76/97`，例如 `{ok:true,reason:'',writers:n}`）。Cordis 的 `effect()` 对返回值分类（`CORDIS:1135-1167`）：

```js
const effect = runner.execute.call(this)
if (typeof effect === "function") return runner.collect(effect)
else if (isNullable(effect)) {}
else if (!isObject(effect)) throw new TypeError("Invalid effect")
else if ("then" in effect) return effect.then(safeCollect)
else if (Symbol.iterator in effect) {...}
else if (Symbol.asyncIterator in effect) {...}
else throw new TypeError("Invalid effect")     // ← 普通对象命中这里
```

而且 `effect()` **同步执行**（`CORDIS:1250`），异常会重新抛出（`CORDIS:1252-1262`）→ `apply()` 抛 → 插件加载失败。

**修复**（任选）：

```js
// 方案1：直接调用（install 自己维护 ctx 引用，不需要 effect）
export function apply(ctx) {
  install(ctx)
  ctx.effect(() => ctx.sessions.registerMessageProjection(projection), 'reply-edit projection')  // 返回 disposer，合法
  ctx.effect(() => ctx.webServer.register(createRoute({ sessions: ctx.sessions })), 'reply-edit routes') // 返回 disposer，合法
}

// 方案2：保持 effect 但不要返回值
ctx.effect(() => { install(ctx) }, 'reply-edit ignorable shim')
```

（`registerMessageProjection` 返回的是 `ctx.effect(...)` 的 disposer **函数**（`SESS:1731-1736` + `CORDIS:1278`），`webServer.register` 返回 disposer 函数（`dsh-host-webserver/lib/index.js:326-333`），所以那两行没问题。）

### 5.2 🟠 事件类型命名：建议直接叫 `plugin:reply-edit/patch`

当前 `lib/core.js:9` 是 `reply-edit/patch`（无 `plugin:` 前缀）。风险：

- V3→V4 格式迁移会把「不在已知集合、但 `ignorable === true`」的事件**改名到 `plugin:` 命名空间**：`namespaceV3OpaqueEvent`（`dsh-session-format-v3-to-v4/lib/index.js:1301-1307`）`type: 'plugin:' + event.type`，README 也写明（`dsh-session/README.md:76`）。
- 本机当前 `SESSION_FORMAT_VERSION = 4`（`SESS:56`），所以**现在不会发生**；但将来 v4→v5 大概率沿用同一策略 → 磁盘上的事件变成 `plugin:reply-edit/patch`，而投影注册的是 `reply-edit/patch` → **改名后所有历史改写静默失效（不报错）**。
- 用 `plugin:reply-edit/patch` 从一开始就与命名空间一致，也是 `pluginRecordOf()`/`appendPluginRecord()` 认可的语法（`types/index.js:332-340`），并且不影响 message projection（投影只按字符串匹配）。

> 若采纳方案 A（appendPluginRecord），这个前缀是**强制**的；若采纳方案 B/C，这只是前瞻性建议。

### 5.3 🟡 `eventAt()` 是宿主明示弃用的读法

`lib/session.js:42` 用 `session.eventAt(seq)`。`eventAt`/`snapshotEvents`/`ownEvents` 在 `dsh-session/README.md:62` 被标为 deprecated（「new production calls are prohibited」；只因仓库内 lint 才保留）。运行时可用、行为稳定，但若想长期跟进，可换成 `session.snapshotEvents(seq, seq+1)[0]`（同为弃用 API…）或等宿主给替代读法。**不阻塞上线，记录即可。**

### 5.4 🟡 插件热卸载会让「用过投影的会话」暂时不可再 append/derive

`registerMessageProjection` 的 disposer 从 `store.projections` 移除定义（`SESS:1733-1735`）；此后任何曾用过该投影的会话，`_assertProjections` 在 **validateNext/任何读**时抛
`session message projection "..." was removed or replaced; restore the session with its owning plugin`（`SESS:580-591`）。
即：**热禁用插件后，打开着的会话会报错，直到重新启用或重启 DSH**。这不是数据损坏（磁盘事件仍带 ignorable，重开即可），但要在 UI/文档里说清。
另：`install()` 重试时若把 `tracker.adopt` 叠层包装，旧 wrapper 闭包仍在本进程存活（引用旧模块的 `stamp`，EVENT_TYPE 字符串相同）→ 不会漏标；但建议在 `install` 里用 `Symbol` brand 检测已包装的 adopt，避免无限叠层。

### 5.5 🟢 其余核对结果（与宿主证据一致）

- `projection.js` 的 `context.events[data.seq - context.baseSeq]`、`context.messages.get(seq) ?? source.data.message`、`nodes.includes(seq)` 与 §1.2 完全吻合；把投影写成「永不抛」是对的（append 时会同步调用，抛错会让 append 失败）。
- `writeEdit` 顺序（找活会话 → 找消息 → 原始块可编辑 → 投影后 STALE → writerReady → append）与宿主语义一致；`writerReady` 在 append 前**同步**检查，中间无 await，不存在竞态窗口。
- `patchHandle` 只包 `access === 'write'` 的句柄、`stamp` 只改自有 type、WeakSet 幂等：与 `JsonlSessionHandle` 结构一致（§3.3）。
- `applyEdit` 对 reasoning 去 `signature/thinkingSignature`：本版本 `ReasoningBlock` 类型只有 `{type,text}`（cordis Service 目录 `ReasoningBlock`），删多余字段无害；对未来带签名块是必要的。

---

## 6. 最终建议（给 dsh-reply-edit 的取舍）

1. **先修 `index.js:23` 的 Invalid effect**（否则插件根本加载不了）——这是唯一「一定错误」的点。
2. 打标记 seam：在「继续用 `persistContiguous` 包装」与「改用 `Session.prototype.commit` 补丁」之间，
   **建议改用 `commit` 补丁**（§3.2）：代码更少、不依赖 `sessionPersistence` 内部结构、天然覆盖 `handle.append(seed)`/fork/未来迁移等落盘路径；`persist.js` 可整体删掉，`session.js` 里的 `writerReady` 换成 `stampReady(session)`（同样是 fail-closed）。
3. 事件类型改成 `plugin:reply-edit/patch`（§5.2）。
4. 路由层对 `SESSION_NOT_LIVE` 加「等 resume 完成」的短重试（§4.2），并把「还没恢复完」和「resume 失败/被占用」区分成不同提示。
5. （可选）若要 UI 里也显示改写后的文本：模型可见靠本插件的 message projection；**浏览器端渲染是另一套**（`ctx.sessionProjections` registry：`dsh-session-projection/lib/index.js:44-52` 服务名 `sessionProjections`，`register(definition)` 在 `:68`，客户端可见性由 `clientVisible` 决定）。最小做法仍是插件自带 route + 客户端覆盖渲染（参考实现的做法），而不是接这套 registry。

---

## 附录：本次证据文件（解包位置，可复现）

| 文件 | 关键行 |
|---|---|
| `.tmp/hostapi-src/dsh-session/lib/index.js` | 56, 79, 144, 217, 298, 425-457, 463-472, 528-536, 542-558, 580-591, 1295-1297, 1324, 1517-1538, 1539-1562, 1568-1599, 1672, 1714, 1729-1737, 1799-1829, 1853, 1901, 1980-1989 |
| `.tmp/hostapi-src/dsh-session/lib/types/*.js` | `surface.js:118-213, 201-213, 376-471`; `known-event-types.js:21-88`; `index.js:128-156, 332-340, 481-482, 812-834` |
| `.tmp/hostapi-src/dsh-session-persistence/lib/index.js` | 148-151, 182-197, 218-222, 261-265 |
| `.tmp/hostapi-src/dsh-session-persistence-jsonl/lib/index.js` | 28-51, 117-123, 187-238, 281, 361-365, 409-442, 2403-2431, 2475/2494/2518/2532, 2570-2596, 2826-2877, 2764 |
| `.tmp/hostapi-src/dsh-session-query/lib/index.js` | 339, 350-397, 450-476, 477-508 |
| `.tmp/hostapi-src/dsh-api-session-controller/lib/index.js` | 392-404, 1510-1653, 1586-1594, 2967-2969, 3006-3031, 3257-3274; `lib/client.js:431` |
| `.tmp/hostapi-src/dsh-agent-loop/lib/index.js` | 1274, 1790-1792, 1881-1885, 1969-2009 |
| `.tmp/hostapi-src/dsh-session-format-v3-to-v4/lib/index.js` | 1236, 1301-1307 |
| `.tmp/hostapi-src/cordis/lib/index.js` | 1135-1167, 1169-1278 |
| `.tmp/hostapi-src/dsh-host-webserver/lib/index.js` | 326-333 |
| `.tmp/hostapi-src/dsh-session-projection/lib/index.js` | 44-52, 68 |
