/**
 * Host half of `dsh-plugin-typo-check`.
 *
 * What it solves: a long draft is easy to send with a typo nobody notices. This
 * half holds the credentials and does the network call, so the page never has to
 * carry an API key around.
 *
 * Shape of the bundle:
 *  1. settings are a list of sources — name, URL, key, model, enabled — kept in
 *     a JSON file under the DSH home, never in the workspace;
 *  2. every source speaks the same OpenAI-compatible dialect, so any endpoint
 *     that looks like `…/v1/chat/completions` (or `…/v1/responses`) works;
 *  3. `POST /check` tries the enabled sources in order and stops at the first
 *     one that answers, so a dead key costs one failed request, not the feature;
 *  4. the model is only asked for the offending words; every returned typo is
 *     located in the draft by this half, which never trusts model offsets.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Stable Loader plugin name, matching `cordis.patch.yml`. */
export const name = 'dsh-typo-check'

/**
 * Every route is served by the web server, so wait for it. Without this the
 * loader can apply the plugin before `webServer` exists, `ctx.get` comes back
 * empty and the routes are silently never registered.
 */
export const inject = ['webServer']

/** Private same-origin routes; prefixed to stay clear of shipped routes. */
const SETTINGS_ROUTE = '/plugins-local/dsh-typo-check-settings'
const CHECK_ROUTE = '/plugins-local/dsh-typo-check-check'
const TEST_ROUTE = '/plugins-local/dsh-typo-check-test'

/** Where the settings page keeps its sources: under the DSH home, per profile. */
const SETTINGS_FILE = join(
  process.env.DSH_HOME ?? join(homedir(), '.dsh'),
  'plugin-data',
  'dsh-typo-check',
  'settings.json',
)

/** Longest draft the model is asked about; longer text is cut, and the answer says so. */
const MAX_TEXT_CHARS = 6000

/** Hard caps that keep one answer to a scrollable list. */
const MAX_ISSUES = 20
const MAX_ORIGINAL_CHARS = 12
const MAX_SUGGESTION_CHARS = 24

/** A source that has not answered by then is treated as unreachable. */
const REQUEST_TIMEOUT_MS = 45_000

/** A settings page with more rows than this is a mistake, not a setup. */
const MAX_SOURCES = 20
/** Upper bound for a custom per-source system prompt; plenty for one page of rules. */
const MAX_PROMPT_CHARS = 4000
/** How long one answer may get when a source does not say otherwise. */
const DEFAULT_MAX_TOKENS = 2000
/** Bounds accepted from the page, so a typo in a number cannot break a request. */
const MIN_MAX_TOKENS = 64
const MAX_MAX_TOKENS = 32000
/** What the plugin uses before anyone opens the settings page. */
const DEFAULT_SETTINGS = Object.freeze({ sources: [] })

/**
 * The whole instruction to the model.
 *
 * Two rules shape it. Recall: a small model that is told "only report what you
 * are sure about" answers with an empty list, which is indistinguishable from a
 * clean draft — so the wording pushes the other way and allows a few doubtful
 * entries. Format: the answer is a JSON object, because the caller locates the
 * typos itself by matching `context` and `original` against the draft.
 */
const SYSTEM_PROMPT = [
  '你是中文校对助手。你的唯一任务是找出文本中的错别字，不做任何润色。',
  '',
  '什么算错别字：错字、别字、同音误用（如「按耐」应为「按捺」、「迫不急待」应为「迫不及待」）、',
  '形近误用（如「己」「已」「巳」写错）、多字（如「吃饭饭」）、漏字。',
  '',
  '什么不算，一律不要报：同义词替换、语序调整、口语化或书面化、标点风格、繁简混用、词语搭配偏好、',
  '断句、语气、格式；不要改代码、命令、路径、URL、英文、数字、单位、人名地名等专有名词。',
  '',
  '做法：先通读一遍读懂意思，再从头逐字核对一遍。凡是有字放进去读不通、不像正常的中文说法、',
  '或者换个同音字/形近字才通顺的地方，都要报出来——拿不准也报，最多 20 条，宁可多报一条可疑的，也不要漏。',
  '',
  '每条问题的字段：',
  '- context：从原文逐字复制的一段话，10 到 30 个字，包含错误处，前后各带一点上下文。',
  '  必须与原文完全一致，不能改写、不能补字、不能换标点。',
  '- original：错误片段本身，1 到 6 个字，必须是 context 中连续出现的一段。',
  '- suggestion：改正后的写法。多字或漏字时长度可以和 original 不同。',
  '- reason：不超过 20 个字的说明。',
  '',
  '同一处只报一次，最多 20 条。确实没有错别字时返回空数组：{"issues":[]}',
  '',
  '只输出一个 JSON 对象，不要解释，不要 Markdown 代码块：',
  '{"issues":[{"context":"…","original":"…","suggestion":"…","reason":"…"}]}',
].join('\n')

/** The turn after the system prompt: just the draft, fenced so it reads as data. */
const buildUserPrompt = (text) => `请检查下面这段文本里的错别字：\n\n${text}`

/**
 * The retry that runs when a source came back with an empty list.
 *
 * An empty answer is the common failure, not a clean draft: the model skimmed
 * the text and moved on. The retry asks for a different decomposition — scan by
 *词 instead of by thought — and plants the expectation that something is there.
 * Reciting the same question louder would not change the answer.
 *
 * @param text - the draft.
 * @returns the user turn for the second attempt.
 */
const buildSecondPrompt = (text) => [
  '刚才你一条错别字都没报。这段文本里很可能有，请换一种方式再看一遍：',
  '1. 从左到右每 2 到 4 个字切一段，逐段确认是不是一个正常的中文词；',
  '2. 对每个读起来正常的词，想一下有没有同音字或形近字会把它写错（比如「加框」应为「加宽」）；',
  '3. 单独核对「的/得/地」「在/再」「做/作」「即/既」「以/已」这类容易互串的字。',
  '逐字核对完再回答；确实没有才返回 {"issues":[]}。',
  '',
  text,
].join('\n')

/**
 * The sentence the 测试连接 button sends. It plants one of the most common
 * Chinese homophone typos (慢步 for 漫步), so a silent model is distinguishable
 * from a model that simply made no edit.
 */
const SAMPLE_TEXT = '今天天气不错，我们去公园慢步吧。'

/** Endpoint paths that already name a complete OpenAI-style operation. */
const ENDPOINT_RE = /\/(chat\/completions|responses|completions)$/i

/** Versioned roots that only need the operation appended. */
const VERSIONED_RE = /\/v\d+$/i

/**
 * A key that shows enough of itself to be recognised, never more.
 *
 * @param key - the stored secret.
 * @returns four leading and four trailing characters, or a placeholder.
 */
const maskKey = (key) => (key === '' ? '' : key.length <= 8 ? '••••' : `${key.slice(0, 4)}…${key.slice(-4)}`)

/**
 * Answer one request with a JSON body.
 *
 * @param res - the response to write.
 * @param status - HTTP status code.
 * @param body - JSON-serializable payload.
 */
function reply(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

/**
 * Is this a same-origin (or non-browser) request?
 *
 * The routes are plain local HTTP endpoints, so without this check any page the
 * user visits could POST a new source list and point a stored key at its own
 * server. Browsers always send `Sec-Fetch-Site` and usually `Origin`; a request
 * that carries neither is a command-line client, which is fine.
 *
 * @param req - the incoming request.
 * @returns true when the caller may read or write the settings.
 */
function trustedRequest(req) {
  const site = req.headers?.['sec-fetch-site']
  if (typeof site === 'string' && site !== '' && site !== 'same-origin' && site !== 'none') return false
  const origin = req.headers?.origin
  if (typeof origin === 'string' && origin !== '') {
    try {
      if (new URL(origin).host !== req.headers?.host) return false
    } catch {
      return false
    }
  }
  return true
}

/**
 * Collect one request body as text.
 *
 * @param req - the incoming request.
 * @param limit - how many characters to keep before ignoring the rest.
 * @returns the body, or an empty string when the stream failed.
 */
function readBody(req, limit) {
  return new Promise((resolve) => {
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      if (raw.length <= limit) raw += chunk
    })
    req.on('end', () => resolve(raw))
    req.on('error', () => resolve(''))
  })
}

/**
 * Parse one JSON request body.
 *
 * @param req - the incoming request.
 * @returns the parsed object, or `null` when the body is not a JSON object.
 */
async function readJson(req) {
  const raw = await readBody(req, 256 * 1024)
  try {
    const parsed = raw.length === 0 ? {} : JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed
  } catch {
    return null
  }
}

/**
 * Run one request body through a handler without ever leaving a rejection loose.
 *
 * In a modern Node, an unhandled rejection takes the whole Host process down, so
 * every chain from `readJson` to the answer ends here, in a 500 that is still a
 * response rather than a dead Host.
 *
 * @param req - the incoming request.
 * @param res - the response to answer.
 * @param ctx - the plugin context, for the log line.
 * @param handle - the body handler; receives the parsed body.
 */
function withBody(req, res, ctx, handle) {
  void readJson(req)
    .then(handle)
    .catch((error) => {
      report(ctx, error)
      try {
        reply(res, 500, { ok: false, error: '处理请求时出错，详细原因见 DSH 日志。' })
      } catch {
        // The socket is already gone; there is nothing left to answer.
      }
    })
}

/**
 * Report a failure without ever disturbing the session that triggered it.
 *
 * @param ctx - the plugin context.
 * @param error - whatever was thrown.
 */
function report(ctx, error) {
  try {
    ctx.get('logger')?.warn?.(`[dsh-typo-check] ${error instanceof Error ? error.message : String(error)}`)
  } catch {
    // Logging is best-effort; a missing logger must not fail a request.
  }
}

/**
 * Read one optional Host service.
 *
 * @param ctx - the plugin context.
 * @param service - exact service key.
 * @returns the service, or `undefined` when the profile does not provide it.
 */
function serviceOf(ctx, service) {
  try {
    return ctx.get(service)
  } catch {
    return undefined
  }
}

/**
 * Work out what one source's URL means.
 *
 * The settings page lets the user paste whatever their provider documents, so
 * three shapes are accepted: a full endpoint, a versioned root, or a bare host.
 *
 * @param url - the URL typed in the settings page.
 * @returns `{url, style}` with `style` `'chat'` or `'responses'`, or `null`.
 */
function resolveTarget(url) {
  const trimmed = String(url ?? '').trim().replace(/\/+$/, '')
  if (trimmed === '') return null
  if (ENDPOINT_RE.test(trimmed)) {
    return { url: trimmed, style: /\/responses$/i.test(trimmed) ? 'responses' : 'chat' }
  }
  const base = VERSIONED_RE.test(trimmed) ? trimmed : `${trimmed}/v1`
  return { url: `${base}/chat/completions`, style: 'chat' }
}

/**
 * Read the answer-token cap, keeping what is stored when the page sends nothing
 * usable. Rows and pages that predate the field simply keep the default.
 *
 * @param raw - the value from a request body or from disk.
 * @param stored - the value already stored for that source, when there is one.
 * @returns a whole number within {@link MIN_MAX_TOKENS}..{@link MAX_MAX_TOKENS}.
 */
function readMaxTokens(raw, stored) {
  const value = Number(raw)
  if (Number.isFinite(value) && value > 0) {
    return Math.min(MAX_MAX_TOKENS, Math.max(MIN_MAX_TOKENS, Math.round(value)))
  }
  return typeof stored === 'number' ? stored : DEFAULT_MAX_TOKENS
}

/**
 * Coerce one source record into the shape the routes use.
 *
 * A missing `apiKey` means "keep the stored key": the page never receives the
 * secret, so it cannot send it back.
 *
 * @param raw - one entry from a request body or from disk.
 * @param existing - the stored entry with the same id, when there is one.
 * @returns the normalized source, or `null` when it is beyond repair.
 */
function normalizeSource(raw, existing) {
  if (raw === null || typeof raw !== 'object') return null
  const url = typeof raw.url === 'string' ? raw.url.trim() : ''
  const incomingKey = typeof raw.apiKey === 'string' ? raw.apiKey.trim() : ''
  const source = {
    id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : existing?.id ?? randomUUID(),
    name: typeof raw.name === 'string' ? raw.name.trim().slice(0, 60) : '',
    url: url.slice(0, 400),
    model: typeof raw.model === 'string' ? raw.model.trim().slice(0, 120) : '',
    enabled: raw.enabled !== false,
    // Opt-in per source: a reasoning request is slower and not every endpoint
    // knows the field, so "off" must be the default for existing rows.
    thinking: raw.thinking === true,
    // How long one answer may get. Too small truncates the JSON, so the value
    // is clamped instead of trusted.
    maxTokens: readMaxTokens(raw.maxTokens, existing?.maxTokens),
    // Empty means "use the built-in instructions"; the page always sends the
    // field, so an omitted one falls back to what is already stored.
    prompt: typeof raw.prompt === 'string'
      ? raw.prompt.slice(0, MAX_PROMPT_CHARS)
      : existing?.prompt ?? '',
    apiKey: incomingKey !== '' ? incomingKey : existing?.apiKey ?? '',
  }
  if (source.url === '' && source.name === '' && source.model === '') return null
  return source
}

/**
 * Coerce a raw settings record into the shape the routes use.
 *
 * @param raw - whatever was on disk or in a request body.
 * @param known - sources already on disk, by id, so an omitted key is kept.
 * @returns a complete settings record; unknown fields are dropped.
 */
function normalizeSettings(raw, known) {
  const container = raw !== null && typeof raw === 'object' ? raw : {}
  const stored = Array.isArray(container.sources) ? container.sources : []
  const byId = new Map()
  const sources = []
  for (const item of stored) {
    const id = typeof item?.id === 'string' ? item.id : ''
    const source = normalizeSource(item, known?.get(id) ?? byId.get(id))
    if (source === null) continue
    byId.set(source.id, source)
    sources.push(source)
    if (sources.length >= MAX_SOURCES) break
  }
  return { sources }
}

/**
 * What the page may see. Keys never travel back: only whether one is stored and
 * enough characters to tell two of them apart.
 *
 * @param settings - the live settings record.
 * @returns the public projection.
 */
function publicSettings(settings) {
  return {
    // The dialog pre-fills its prompt box with this, so the user edits the real
    // instructions instead of a blank field.
    defaultPrompt: SYSTEM_PROMPT,
    sources: settings.sources.map((source) => ({
      id: source.id,
      name: source.name,
      url: source.url,
      model: source.model,
      enabled: source.enabled,
      thinking: source.thinking === true,
      maxTokens: source.maxTokens ?? DEFAULT_MAX_TOKENS,
      prompt: source.prompt ?? '',
      hasKey: source.apiKey !== '',
      keyHint: maskKey(source.apiKey),
    })),
  }
}

/**
 * Read the persisted settings.
 *
 * @returns the stored settings, or `null` when none were saved yet.
 */
async function loadSettings() {
  try {
    const raw = await readFile(SETTINGS_FILE, 'utf8')
    return normalizeSettings(JSON.parse(raw))
  } catch {
    return null
  }
}

/**
 * Persist the settings next to the profile.
 *
 * @param settings - the record to write.
 */
async function saveSettings(settings) {
  await mkdir(dirname(SETTINGS_FILE), { recursive: true })
  await writeFile(SETTINGS_FILE, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
}

/**
 * Pull the assistant text out of an OpenAI-compatible answer.
 *
 * Both dialects are read: chat completions put the text in
 * `choices[0].message.content`, the newer responses style in `output_text` or in
 * one `output[]` message part. Only one of them will be present.
 *
 * @param payload - the parsed response body.
 * @returns the message text, or an empty string when the shape is unknown.
 */
function readContent(payload) {
  const choice = Array.isArray(payload?.choices) ? payload.choices[0] : null
  const content = choice?.message?.content ?? choice?.text
  if (typeof content === 'string') return content
  // Some providers answer with content parts instead of a single string.
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : ''))
      .join('')
  }
  if (typeof payload?.output_text === 'string' && payload.output_text !== '') return payload.output_text
  const output = Array.isArray(payload?.output) ? payload.output : []
  const parts = []
  for (const item of output) {
    const itemContent = Array.isArray(item?.content) ? item.content : []
    for (const part of itemContent) {
      if (typeof part?.text === 'string') parts.push(part.text)
    }
  }
  return parts.join('')
}

/**
 * Find the JSON object inside a model answer.
 *
 * Models answer with a bare object most of the time, with a fenced block or a
 * sentence around it the rest of the time; both are worth salvaging.
 *
 * @param text - the raw answer.
 * @returns the parsed object, or `null` when no object parses.
 */
function parseAnswer(text) {
  if (typeof text !== 'string' || text.trim() === '') return null
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const source = fenced ? fenced[1] : text
  const start = source.indexOf('{')
  const end = source.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const parsed = JSON.parse(source.slice(start, end + 1))
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/**
 * Read the issue list out of a parsed answer.
 *
 * @param answer - the parsed JSON answer.
 * @returns the raw issue records; anything malformed is dropped.
 */
function readRawIssues(answer) {
  const list = Array.isArray(answer) ? answer : Array.isArray(answer?.issues) ? answer.issues : []
  const issues = []
  for (const item of list) {
    if (item === null || typeof item !== 'object') continue
    const original = typeof item.original === 'string' ? item.original.trim() : ''
    const suggestion = typeof item.suggestion === 'string' ? item.suggestion.trim() : ''
    if (original === '' || suggestion === '' || original === suggestion) continue
    if (original.length > MAX_ORIGINAL_CHARS || suggestion.length > MAX_SUGGESTION_CHARS) continue
    issues.push({
      context: typeof item.context === 'string' ? item.context.trim() : '',
      original,
      suggestion,
      reason: typeof item.reason === 'string' ? item.reason.trim().slice(0, 40) : '',
    })
  }
  return issues
}

/**
 * Put one issue at an exact offset in the draft.
 *
 * The model is asked for the surrounding `context` precisely so the position
 * can be recovered by matching: `context` first, then `original` alone.
 *
 * @param text - the draft that was checked.
 * @param issue - one raw issue record.
 * @returns `{start, end}` in draft coordinates, or `null` when it cannot be placed.
 */
function placeIssue(text, issue) {
  if (issue.context !== '') {
    const at = text.indexOf(issue.context)
    if (at >= 0) {
      const relative = issue.context.indexOf(issue.original)
      if (relative >= 0) {
        return { start: at + relative, end: at + relative + issue.original.length }
      }
    }
  }
  const at = text.indexOf(issue.original)
  if (at >= 0) return { start: at, end: at + issue.original.length }
  return null
}

/**
 * Turn the model's answer into a placed, de-duplicated issue list.
 *
 * @param answer - the parsed JSON answer.
 * @param text - the draft that was checked.
 * @returns the issues, ordered by position, each with `start`/`end`.
 */
function locateIssues(answer, text) {
  const placed = []
  for (const issue of readRawIssues(answer)) {
    if (placed.length >= MAX_ISSUES) break
    const spot = placeIssue(text, issue)
    if (spot === null) continue
    // One highlight per character range: an overlap would only confuse the list.
    if (placed.some((other) => spot.start < other.end && spot.end > other.start)) continue
    placed.push({ ...issue, start: spot.start, end: spot.end })
  }
  placed.sort((left, right) => left.start - right.start)
  return placed
}

/**
 * The "think longer" nudge, in the dialect this endpoint speaks.
 *
 * The Responses API and OpenRouter take a nested `reasoning.effort`; the chat
 * completions family that adopted the idea uses the flat `reasoning_effort`.
 *
 * @param target - `{url, style}` from {@link resolveTarget}.
 * @returns the extra body fields.
 */
function reasoningPayload(target) {
  if (target.style === 'responses' || /openrouter\.ai/i.test(target.url)) {
    return { reasoning: { effort: 'medium' } }
  }
  return { reasoning_effort: 'medium' }
}

/**
 * Build the request body for one source's dialect.
 *
 * @param target - `{url, style}` from {@link resolveTarget}.
 * @param source - the source being called.
 * @param messages - system and user turns.
 * @param useReasoning - whether to ask the model to think before answering.
 * @returns the JSON-serializable request body.
 */
function requestBody(target, source, messages, useReasoning) {
  const extra = useReasoning === true ? reasoningPayload(target) : {}
  if (target.style === 'responses') {
    return {
      model: source.model,
      instructions: messages[0]?.content ?? '',
      input: messages.slice(1).map((message) => message.content).join('\n\n'),
      ...extra,
    }
  }
  return {
    model: source.model,
    messages,
    temperature: 0,
    max_tokens: source.maxTokens ?? DEFAULT_MAX_TOKENS,
    stream: false,
    ...extra,
  }
}

/**
 * Call one source once and return the assistant text.
 *
 * @param source - the source to call.
 * @param messages - system and user turns.
 * @param useReasoning - whether to ask the model to think before answering.
 * @returns the assistant text.
 */
async function callOnce(source, messages, useReasoning) {
  const label = source.name === '' ? source.url : source.name
  const target = resolveTarget(source.url)
  if (target === null) throw new Error('URL 是空的。')
  if (source.model === '') throw new Error('还没填模型名。')
  if (source.apiKey === '') throw new Error('还没填 API Key。')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    let response
    try {
      response = await fetch(target.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${source.apiKey}`,
        },
        body: JSON.stringify(requestBody(target, source, messages, useReasoning)),
        signal: controller.signal,
      })
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new Error(`${label} 在 ${Math.round(REQUEST_TIMEOUT_MS / 1000)} 秒内没有响应。`)
      }
      throw new Error(`连不上 ${label}：${error?.message ?? String(error)}`)
    }
    const raw = await response.text()
    let payload = null
    try {
      payload = JSON.parse(raw)
    } catch {
      payload = null
    }
    if (!response.ok) {
      const detail = payload?.error?.message ?? payload?.error ?? payload?.message ?? raw.slice(0, 300)
      throw new Error(`${label} 返回 ${response.status}：${String(detail).slice(0, 300)}`)
    }
    const content = readContent(payload)
    if (content.trim() === '') throw new Error(`${label} 返回了空内容。`)
    return content
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Call one source, honouring its 思考模式 switch.
 *
 * An endpoint that does not know the reasoning field rejects the whole body with
 * a 400. The switch must never turn a working source into a broken one, so that
 * specific refusal falls back to a plain request instead of reaching the user
 * as an error.
 *
 * @param source - the source to call.
 * @param messages - system and user turns.
 * @returns the assistant text.
 */
async function chat(source, messages) {
  if (source.thinking !== true) return callOnce(source, messages, false)
  try {
    return await callOnce(source, messages, true)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!/\b(400|422)\b/.test(message)) throw error
    return callOnce(source, messages, false)
  }
}

/**
 * Does this failure look like a bad key rather than a bad network day?
 *
 * @param message - one source's error text.
 * @returns true when the user most likely has to fix a credential.
 */
function isAuthFailure(message) {
  return /\b(401|403)\b|unauthoriz|forbidden|invalid[^\n]{0,40}(key|token|credential)|incorrect api key|no auth|认证|密钥|令牌/i
    .test(message)
}

/**
 * The instructions one source runs with: its own text, or the built-in one.
 *
 * @param source - a normalized source.
 * @returns the system message content.
 */
function promptOf(source) {
  const custom = typeof source?.prompt === 'string' ? source.prompt.trim() : ''
  return custom === '' ? SYSTEM_PROMPT : custom
}

/**
 * Check one draft against the enabled sources, in their order.
 *
 * The first source that answers wins; every failure is collected so the page can
 * show why nothing worked instead of a single vague error.
 *
 * @param settings - the live settings record.
 * @param text - the draft.
 * @returns `{issues, truncated, chars, source}`.
 */
async function checkText(settings, text) {
  const enabled = settings.sources.filter((source) => source.enabled)
  if (enabled.length === 0) {
    const error = new Error('还没有启用任何来源：到「插件 → 输入框查错」的表格里添加一行，并打开启用开关。')
    error.kind = 'nosource'
    throw error
  }
  const truncated = text.length > MAX_TEXT_CHARS
  const body = truncated ? text.slice(0, MAX_TEXT_CHARS) : text
  const failures = []
  let authFailed = false
  for (const source of enabled) {
    // Each row may carry its own instructions; the built-in prompt is the fallback.
    const instructions = promptOf(source)
    const messages = [
      { role: 'system', content: instructions },
      { role: 'user', content: buildUserPrompt(body) },
    ]
    const secondMessages = [
      { role: 'system', content: instructions },
      { role: 'user', content: buildSecondPrompt(body) },
    ]
    try {
      const answer = await chat(source, messages)
      let parsed = parseAnswer(answer)
      if (parsed === null) throw new Error(`回答不是能读懂的 JSON：${answer.slice(0, 120)}`)
      if (readRawIssues(parsed).length === 0) {
        // An empty list is the usual failure, not a clean draft: ask once more
        // with a different scan order. Only an answer that actually found
        // something replaces the first one, and a hiccup on the follow-up keeps
        // the valid (empty) first answer instead of turning it into an error.
        try {
          const retry = parseAnswer(await chat(source, secondMessages))
          if (retry !== null && readRawIssues(retry).length > 0) parsed = retry
        } catch {
          // Keep the empty first answer.
        }
      }
      return {
        issues: locateIssues(parsed, body),
        truncated,
        chars: body.length,
        source: { name: source.name === '' ? source.url : source.name, model: source.model },
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (isAuthFailure(message)) authFailed = true
      failures.push(`${source.name === '' ? source.url : source.name}：${message}`)
    }
  }
  const error = new Error(failures.join('\n'))
  error.kind = 'allfailed'
  error.authFailed = authFailed
  error.failures = failures
  throw error
}

/**
 * Mount the Host half.
 *
 * @param ctx - the plugin context.
 * @param config - the row config (unused; the settings page owns the choices).
 */
export function apply(ctx, config) {
  void config
  /** Live settings: seeded from disk, replaced by the settings page. */
  const settings = { sources: [] }
  /** Settings are read once; a page opened before the read lands waits on it. */
  const ready = loadSettings()
    .then((stored) => {
      if (stored !== null) settings.sources = stored.sources
    })
    .catch((error) => report(ctx, error))

  const webServer = serviceOf(ctx, 'webServer')

  const registerRoutes = (server) => {
    // The settings page reads and writes the whole list through this route; one
    // call covers add, edit, enable, reorder and remove.
    ctx.effect(() => server.register({
      kind: 'exact',
      path: SETTINGS_ROUTE,
      handler: (req, res) => {
        if (!trustedRequest(req)) {
          reply(res, 403, { ok: false, error: '跨站请求被拒绝。' })
          return
        }
        if (req.method === 'GET') {
          void ready.then(() => reply(res, 200, { ok: true, settings: publicSettings(settings) }))
          return
        }
        if (req.method !== 'POST') {
          reply(res, 405, { ok: false, error: 'Use POST or GET.' })
          return
        }
        withBody(req, res, ctx, async (body) => {
          if (body === null) {
            reply(res, 400, { ok: false, error: '请求体必须是 JSON 对象。' })
            return
          }
          if (!Array.isArray(body.sources)) {
            reply(res, 400, { ok: false, error: '请求体需要一个 sources 数组。' })
            return
          }
          if (body.sources.length > MAX_SOURCES) {
            reply(res, 400, { ok: false, error: `最多 ${MAX_SOURCES} 个来源。` })
            return
          }
          await ready
          // Keys never travel to the page, so a re-sent row without one keeps
          // whatever is already stored under the same id.
          const known = new Map(settings.sources.map((source) => [source.id, source]))
          const next = normalizeSettings({ sources: body.sources }, known)
          settings.sources = next.sources
          try {
            await saveSettings(settings)
            reply(res, 200, { ok: true, settings: publicSettings(settings) })
          } catch (error) {
            report(ctx, error)
            reply(res, 500, { ok: false, error: '设置文件写不进去。' })
          }
        })
      },
    }), 'dsh-typo-check: settings route')

    // The one call the composer button makes.
    ctx.effect(() => server.register({
      kind: 'exact',
      path: CHECK_ROUTE,
      handler: (req, res) => {
        if (!trustedRequest(req)) {
          reply(res, 403, { ok: false, error: '跨站请求被拒绝。' })
          return
        }
        if (req.method !== 'POST') {
          reply(res, 405, { ok: false, error: 'Use POST.' })
          return
        }
        withBody(req, res, ctx, async (body) => {
          if (body === null) {
            reply(res, 400, { ok: false, error: '请求体必须是 JSON 对象。' })
            return
          }
          const text = typeof body.text === 'string' ? body.text : ''
          if (text.trim() === '') {
            reply(res, 400, { ok: false, kind: 'empty', error: '输入框是空的，没有可检查的文字。' })
            return
          }
          await ready
          try {
            const result = await checkText(settings, text)
            reply(res, 200, { ok: true, ...result })
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            const kind = error?.kind ?? 'failed'
            if (kind === 'nosource') {
              reply(res, 400, { ok: false, kind, error: message })
              return
            }
            report(ctx, error)
            reply(res, 502, {
              ok: false,
              kind,
              authFailed: error?.authFailed === true,
              failures: Array.isArray(error?.failures) ? error.failures : [message],
              error: message,
            })
          }
        })
      },
    }), 'dsh-typo-check: check route')

    // The 测试连接 button in the add/edit dialog: run the sample sentence through
    // exactly the row being typed, without saving it first.
    ctx.effect(() => server.register({
      kind: 'exact',
      path: TEST_ROUTE,
      handler: (req, res) => {
        if (!trustedRequest(req)) {
          reply(res, 403, { ok: false, error: '跨站请求被拒绝。' })
          return
        }
        if (req.method !== 'POST') {
          reply(res, 405, { ok: false, error: 'Use POST.' })
          return
        }
        withBody(req, res, ctx, async (body) => {
          if (body === null) {
            reply(res, 400, { ok: false, error: '请求体必须是 JSON 对象。' })
            return
          }
          await ready
          // An empty key field means "use the one already stored for this row".
          const stored = typeof body.id === 'string'
            ? settings.sources.find((source) => source.id === body.id)
            : undefined
          const source = normalizeSource({
            name: '',
            url: body.url,
            model: body.model,
            apiKey: body.apiKey,
            prompt: typeof body.prompt === 'string' ? body.prompt : undefined,
            enabled: true,
            thinking: body.thinking === true,
            maxTokens: body.maxTokens,
          }, stored)
          if (source === null || source.url === '') {
            reply(res, 400, { ok: false, error: '先填 URL 和模型。' })
            return
          }
          if (source.apiKey === '') {
            reply(res, 400, { ok: false, error: '先填 API Key。' })
            return
          }
          const started = Date.now()
          try {
            const answer = await chat(source, [
              { role: 'system', content: promptOf(source) },
              { role: 'user', content: buildUserPrompt(SAMPLE_TEXT) },
            ])
            const parsed = parseAnswer(answer)
            reply(res, 200, {
              ok: true,
              latencyMs: Date.now() - started,
              sample: SAMPLE_TEXT,
              issues: parsed === null ? [] : locateIssues(parsed, SAMPLE_TEXT),
              source: {
                name: source.name === '' ? source.url : source.name,
                model: source.model,
              },
              ...(parsed === null
                ? { note: '接口能连上，但回答不是约定的 JSON：模型可以用，检查效果可能不稳。' }
                : {}),
            })
          } catch (error) {
            reply(res, 502, {
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            })
          }
        })
      },
    }), 'dsh-typo-check: test route')
  }

  if (webServer !== undefined) registerRoutes(webServer)
  else report(ctx, new Error('webServer service is missing; the routes were not registered.'))
}
