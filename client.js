/**
 * Client half of `dsh-plugin-typo-check`.
 *
 * Four small pieces:
 *
 *  1. a Check button in the composer toolbar (`conversation.input.right`) that
 *     hands the current draft to the Host half — with a short status word to its
 *     left when every configured source failed;
 *  2. a highlight layer (`conversation.input.overlay`) that paints every found
 *     typo in the composer through the CSS Custom Highlight API — no DOM inside
 *     the editable, so the Lexical editor never sees a foreign node;
 *  3. a result card inside the same overlay area (`conversation.input.overlay`),
 *     floating just above the composer card so it never reflows the page, where
 *     each typo can be replaced with one click, through `inputActions.insertText`
 *     so the edit goes through the editor's own transaction;
 *  4. the settings page in the plugin detail page: a table of OpenAI-compatible
 *     sources that can be added, edited, enabled and dragged into order.
 *
 * All of it shares one tiny store keyed by session id, because a list slot
 * renders one component per entry and there is no composer-wide service to hang
 * state on.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-typo-check',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /**
     * DSH's own tooltip primitive, when the page's module table provides it.
     *
     * The lookup is guarded: a plain bundle runs in the page itself, so a build
     * that does not register this module must still load. Without it the
     * controls fall back to the native `title` bubble.
     */
    const Tooltip = (() => {
      try {
        return require('@deepseek-ai/dsh-client-ui-primitives').Tooltip ?? null
      } catch {
        return null
      }
    })()

    /** Class name of the composer-toolbar check button. */
    const CHECK_CLASS = 'dsh-typo-check-check'
    /** Class name of a small bordered button (settings rows, issue rows). */
    const ACTION_CLASS = 'dsh-typo-check-action'
    /** Extra class that keeps the 删除 button red in every state. */
    const ACTION_DANGER_CLASS = 'dsh-typo-check-action-danger'
    /** Extra class for the one black, solid button of a group (替换). */
    const ACTION_SOLID_CLASS = 'dsh-typo-check-action-solid'

    /** What the little ⓘ next to 思考模式 explains, in one breath. */
    const THINKING_HINT = '先想再答：通常更准、也更慢；来源不支持这个参数时会自动退回普通模式。'
    /** What the ⓘ next to max_tokens explains: which way the number can hurt. */
    const MAX_TOKENS_HINT = '模型一次最多能输出多少 token。给小了回答会被截断、JSON 读不出来；64～32000，留空用 2000。'
    /** The cap assumed when a source does not carry one (mirrors the host). */
    const DEFAULT_MAX_TOKENS = 2000

    /**
     * The controls need colours that an inline style cannot express,
     * because `:hover` lives in a stylesheet: the element keeps its geometry
     * inline and takes its paint from these class rules. Each component renders
     * the sheet as a `<style>` child, so unmounting takes it away again.
     *
     * The check button copies the composer's send button
     * (`--dsw-alias-button-info-fill`, white label, hover `…-hover`).
     */
    const CONTROL_CSS = [
      `.${CHECK_CLASS}:not(:disabled) {`,
      '  background: var(--dsw-alias-button-info-fill);',
      '  border-color: var(--dsw-alias-button-info-fill);',
      '  color: #fff;',
      '}',
      `.${CHECK_CLASS}:not(:disabled):hover {`,
      '  background: var(--dsw-alias-button-info-hover);',
      '  border-color: var(--dsw-alias-button-info-hover);',
      '}',
      `.${ACTION_CLASS} {`,
      '  border: 1px solid var(--dsw-alias-border-l1);',
      '  background: transparent;',
      '  color: var(--dsw-alias-label-secondary);',
      '}',
      `.${ACTION_CLASS}:hover:not(:disabled) {`,
      '  border-color: var(--dsw-alias-border-l2);',
      '  background: var(--dsw-alias-interactive-bg-hover);',
      '  color: var(--dsw-alias-label-primary);',
      '}',
      `.${ACTION_CLASS}.${ACTION_DANGER_CLASS} {`,
      '  color: var(--dsw-alias-state-error-primary);',
      '}',
      `.${ACTION_CLASS}.${ACTION_DANGER_CLASS}:hover:not(:disabled) {`,
      '  color: var(--dsw-alias-state-error-primary);',
      '}',
      // Two classes beat the plain hover rule above, so the solid button stays
      // black on hover and only dims a little.
      `.${ACTION_CLASS}.${ACTION_SOLID_CLASS} {`,
      '  border-color: var(--dsw-alias-label-primary);',
      '  background: var(--dsw-alias-label-primary);',
      '  color: var(--dsw-alias-bg-base);',
      '}',
      `.${ACTION_CLASS}.${ACTION_SOLID_CLASS}:hover:not(:disabled) {`,
      '  border-color: var(--dsw-alias-label-primary);',
      '  background: var(--dsw-alias-label-primary);',
      '  color: var(--dsw-alias-bg-base);',
      '  opacity: 0.86;',
      '}',
    ].join('\n')

    /** Must match `CHECK_ROUTE` in index.js. */
    const CHECK_ROUTE = '/plugins-local/dsh-typo-check-check'
    /** Must match `SETTINGS_ROUTE` in index.js. */
    const SETTINGS_ROUTE = '/plugins-local/dsh-typo-check-settings'
    /** Must match `TEST_ROUTE` in index.js. */
    const TEST_ROUTE = '/plugins-local/dsh-typo-check-test'

    /** `<package>#<row id>`, the key the plugin detail page expects. */
    const ROW_KEY = 'dsh-plugin-typo-check#dsh-typo-check'

    /**
     * Name of one session's highlight range set.
     *
     * `CSS.highlights` is global to the page, so two mounted composers would
     * overwrite each other's set under a shared name. The name has to be a CSS
     * identifier, so anything outside `[A-Za-z0-9_-]` becomes `_`.
     *
     * @param sessionId - the composer's session id.
     * @returns the range set name for that session.
     */
    const highlightName = (sessionId) => `dsh-typo-check-${String(sessionId ?? 'x').replace(/[^A-Za-z0-9_-]/g, '_')}`

    /**
     * Paint for the highlight ranges. `::highlight()` is the only way to colour
     * text inside the contenteditable without touching its DOM, and it scrolls
     * with the text for free.
     *
     * @param name - this session's range set name.
     * @returns the stylesheet text.
     */
    const highlightCss = (name) => [
      `::highlight(${name}) {`,
      '  background-color: rgba(255, 196, 0, 0.34);',
      '  text-decoration: underline wavy #E0A106;',
      '  text-decoration-skip-ink: none;',
      '}',
    ].join('\n')

    /** A free-form object usable while the Host has not answered yet. */
    const emptyEntry = () => ({
      status: 'idle',
      issues: [],
      error: '',
      failures: [],
      banner: '',
      source: '',
      truncated: false,
      checkedAt: 0,
    })

    /** Per-session check results; keys are stringified session ids. */
    const entries = new Map()

    /** Components that render from the store. */
    const listeners = new Set()

    /**
     * The store entry for one session, created on first use.
     *
     * @param sessionId - the composer's session id.
     * @returns the mutable entry.
     */
    function entryOf(sessionId) {
      const key = String(sessionId ?? '')
      let entry = entries.get(key)
      if (entry === undefined) {
        entry = emptyEntry()
        entries.set(key, entry)
      }
      return entry
    }

    /**
     * Forget one session's result, so every consumer goes back to idle.
     *
     * @param sessionId - the composer's session id.
     */
    function clearEntry(sessionId) {
      const entry = entryOf(sessionId)
      if (entry.status === 'idle' && entry.issues.length === 0) return
      entry.issues = []
      entry.truncated = false
      entry.source = ''
      entry.checkedAt = 0
      entry.status = 'idle'
      entry.error = ''
      entry.failures = []
      entry.banner = ''
      emit()
    }

    /** Tell every store consumer that something changed. */
    function emit() {
      for (const listener of [...listeners]) {
        try {
          listener()
        } catch {
          // One broken consumer must not stop the others.
        }
      }
    }

    /**
     * Subscribe one component to the store.
     *
     * @param sessionId - the composer's session id.
     * @returns the current entry, re-rendered on change.
     */
    function useSessionEntry(sessionId) {
      const [, bump] = React.useState(0)
      React.useEffect(() => {
        const listener = () => bump((value) => value + 1)
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      }, [])
      return entryOf(sessionId)
    }

    /**
     * Call one Host route and parse its JSON body.
     *
     * The parsed body is attached to the thrown error, because the failure kinds
     * (`nosource`, `allfailed`) are what the page turns into a status word.
     *
     * @param path - route path, including the plugin prefix.
     * @param init - optional fetch options.
     * @returns the parsed body.
     */
    async function call(path, init) {
      const response = await fetch(path, { credentials: 'same-origin', ...init })
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (!response.ok) {
        // A 404/405 means the page is newer than the running Host half: the route
        // does not exist yet. Say so instead of showing a bare status code.
        const missing = response.status === 404 || response.status === 405
        const message = (payload && (payload.error || payload.message))
          || (missing
            ? `这个功能的后端还没加载（HTTP ${response.status}）：重启一次 DSH 再试。`
            : `HTTP ${response.status}`)
        const error = new Error(message)
        error.payload = payload
        throw error
      }
      return payload
    }

    /** Prefix used by every JSON write below. */
    const JSON_POST = { method: 'POST', headers: { 'content-type': 'application/json' } }

    /**
     * Ask the Host to check one draft.
     *
     * @param sessionId - the composer's session id.
     * @param draft - the text in the composer.
     */
    async function runCheck(sessionId, draft) {
      const entry = entryOf(sessionId)
      if (entry.status === 'checking') return
      if (draft.trim() === '') {
        entry.status = 'error'
        entry.error = '输入框是空的，没有可检查的文字。'
        entry.failures = []
        entry.banner = ''
        emit()
        return
      }
      entry.status = 'checking'
      entry.error = ''
      entry.failures = []
      entry.banner = ''
      emit()
      try {
        const payload = await call(CHECK_ROUTE, {
          ...JSON_POST,
          body: JSON.stringify({ text: draft }),
        })
        // Sending (or collapsing) wipes the entry while the request is in flight;
        // its answer describes text that is gone, so it must not resurrect it.
        if (entry.status !== 'checking') return
        entry.issues = Array.isArray(payload?.issues) ? payload.issues : []
        entry.truncated = Boolean(payload?.truncated)
        entry.source = [payload?.source?.name, payload?.source?.model].filter(Boolean).join(' · ')
        entry.checkedAt = Date.now()
        entry.status = 'done'
      } catch (error) {
        if (entry.status !== 'checking') return
        const body = error instanceof Error ? error.payload : null
        const kind = body?.kind
        entry.status = 'error'
        entry.error = error instanceof Error ? error.message : String(error)
        entry.failures = Array.isArray(body?.failures) ? body.failures : []
        entry.banner = kind === 'nosource' ? '未配置来源' : kind === 'empty' ? '' : 'api 无效'
      }
      emit()
    }

    /**
     * Find where one issue sits in a draft right now.
     *
     * Positions captured at check time are used only while the text still
     * matches there; otherwise the issue is re-located by its context, so an edit
     * somewhere else in the draft does not break every remaining fix.
     *
     * @param draft - the current composer text.
     * @param issue - one issue from the store.
     * @returns `{start, end}` in clipboard coordinates, or `null`.
     */
    function spotOf(draft, issue) {
      const original = typeof issue.original === 'string' ? issue.original : ''
      if (original === '') return null
      if (typeof issue.start === 'number' && draft.slice(issue.start, issue.start + original.length) === original) {
        return { start: issue.start, end: issue.start + original.length }
      }
      const context = typeof issue.context === 'string' ? issue.context : ''
      if (context !== '') {
        const at = draft.indexOf(context)
        if (at >= 0) {
          const relative = context.indexOf(original)
          if (relative >= 0) return { start: at + relative, end: at + relative + original.length }
        }
      }
      const at = draft.indexOf(original)
      return at >= 0 ? { start: at, end: at + original.length } : null
    }

    /**
     * Convert a clipboard-coordinate span into a detect-coordinate span.
     *
     * `InputState.draft` counts a chip's whole text, while the editor's detect
     * projection collapses each chip to a single placeholder character. A span
     * that overlaps a chip is refused: replacing it would delete the reference.
     *
     * @param start - clipboard start offset.
     * @param end - clipboard end offset.
     * @param occurrences - reference occurrences, in clipboard coordinates.
     * @returns `{start, end}` in detect coordinates, or `null`.
     */
    function toDetectSpan(start, end, occurrences) {
      for (const occurrence of occurrences) {
        const occurrenceStart = Number(occurrence?.offset)
        const occurrenceEnd = occurrenceStart + Number(occurrence?.length)
        if (!Number.isFinite(occurrenceStart) || !Number.isFinite(occurrenceEnd)) continue
        if (occurrenceStart < end && occurrenceEnd > start) return null
      }
      const shift = (offset) => {
        let collapsed = 0
        for (const occurrence of occurrences) {
          const occurrenceStart = Number(occurrence?.offset)
          const occurrenceLength = Number(occurrence?.length)
          if (!Number.isFinite(occurrenceStart) || !Number.isFinite(occurrenceLength)) continue
          if (occurrenceStart + occurrenceLength <= offset) collapsed += occurrenceLength - 1
        }
        return offset - collapsed
      }
      return { start: shift(start), end: shift(end) }
    }

    /**
     * Replace one issue through the composer's own edit actions.
     *
     * @param input - the live `InputState`.
     * @param inputActions - the composer's action face.
     * @param sessionId - the composer's session id.
     * @param issue - the issue to fix.
     */
    function applyFix(input, inputActions, sessionId, issue) {
      const entry = entryOf(sessionId)
      const draft = typeof input?.draft === 'string' ? input.draft : ''
      const occurrences = Array.isArray(input?.occurrences) ? input.occurrences : []
      const spot = spotOf(draft, issue)
      if (spot === null) {
        entry.error = '这段文字已经变了，请重新检查。'
        emit()
        return
      }
      const span = toDetectSpan(spot.start, spot.end, occurrences)
      if (span === null) {
        entry.error = '这处错别字里含有 @ 引用，不能自动替换。'
        emit()
        return
      }
      const applied = inputActions?.insertText?.(String(issue.suggestion ?? ''), {
        start: span.start,
        end: span.end,
        draftRev: input.draftRev,
      })
      if (applied !== true) {
        entry.error = '替换没有生效：输入框内容在检查之后变过，请重新检查。'
        emit()
        return
      }
      entry.error = ''
      entry.issues = entry.issues.filter(
        (other) => other !== issue && !(other.start < issue.end && other.end > issue.start),
      )
      emit()
    }

    /**
     * Drop one issue from the list without touching the text.
     *
     * @param sessionId - the composer's session id.
     * @param issue - the issue to drop.
     */
    function ignoreIssue(sessionId, issue) {
      const entry = entryOf(sessionId)
      entry.issues = entry.issues.filter((other) => other !== issue)
      emit()
    }

    /**
     * Recursively linearise the composer's DOM into one string plus the text
     * pieces that string was built from.
     *
     * Lexical splits a paragraph into several spans, so the plain text of one
     * paragraph is spread over many nodes; a block boundary and a `<br>` both
     * count as one "\n", which is exactly how the draft string joins lines.
     *
     * @param root - the contenteditable element.
     * @returns `{text, nodes}` where each node is `{node, start, end}`.
     */
    function buildTextIndex(root) {
      const nodes = []
      let text = ''
      const blocks = new Set(['DIV', 'P', 'LI', 'BLOCKQUOTE', 'PRE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6'])
      const pushBreak = () => {
        if (text.endsWith('\n')) return
        text += '\n'
      }
      const visit = (element) => {
        for (const child of element.childNodes) {
          if (child.nodeType === 3) {
            const value = child.nodeValue ?? ''
            if (value === '') continue
            nodes.push({ node: child, start: text.length, end: text.length + value.length })
            text += value
            continue
          }
          if (child.nodeType !== 1) continue
          // Decorator chips (an @ reference) are not text the user typed.
          if (child.hasAttribute?.('data-lexical-decorator')) continue
          const tag = child.tagName
          if (tag === 'BR') {
            pushBreak()
            continue
          }
          if (blocks.has(tag)) {
            visit(child)
            pushBreak()
            continue
          }
          visit(child)
        }
      }
      visit(root)
      return { text, nodes }
    }

    /**
     * Find one issue's characters in a linearised index.
     *
     * @param text - the linearised text.
     * @param issue - the issue to place.
     * @returns `{start, end}` in index coordinates, or `null`.
     */
    function placeInIndex(text, issue) {
      const original = typeof issue.original === 'string' ? issue.original : ''
      if (original === '') return null
      const context = typeof issue.context === 'string' ? issue.context : ''
      if (context !== '') {
        const at = text.indexOf(context)
        if (at >= 0) {
          const relative = context.indexOf(original)
          if (relative >= 0) return { start: at + relative, end: at + relative + original.length }
        }
      }
      const at = text.indexOf(original)
      return at >= 0 ? { start: at, end: at + original.length } : null
    }

    /**
     * The text piece that owns one offset.
     *
     * @param nodes - the index pieces.
     * @param offset - character offset.
     * @param asEnd - true for a range end (the offset may equal the piece end).
     * @returns the piece, or `null` when the offset falls on a generated "\n".
     */
    function pieceAt(nodes, offset, asEnd) {
      for (const piece of nodes) {
        if (asEnd ? offset > piece.start && offset <= piece.end : offset >= piece.start && offset < piece.end) {
          return piece
        }
      }
      return null
    }

    /**
     * Remove one session's highlight set, if the platform has the API at all.
     *
     * @param name - the range set name to drop.
     */
    function clearHighlights(name) {
      try {
        globalThis.CSS?.highlights?.delete(name)
      } catch {
        // An environment without the Custom Highlight API has nothing to clear.
      }
    }

    /**
     * Paint every issue the store holds onto the composer text.
     *
     * @param anchor - any element inside the composer card.
     * @param issues - the issues to paint.
     * @param name - this session's range set name.
     */
    function paintHighlights(anchor, issues, name) {
      const container = anchor?.closest?.('[data-composer-card]') ?? null
      const editor = container?.querySelector?.('[data-composer-input]') ?? null
      if (editor === null) {
        clearHighlights(name)
        return
      }
      const HighlightCtor = globalThis.Highlight
      if (typeof HighlightCtor !== 'function' || !globalThis.CSS?.highlights) return
      const index = buildTextIndex(editor)
      const ranges = []
      for (const issue of issues ?? []) {
        const spot = placeInIndex(index.text, issue)
        if (spot === null) continue
        const startPiece = pieceAt(index.nodes, spot.start, false)
        const endPiece = pieceAt(index.nodes, spot.end, true)
        if (startPiece === null || endPiece === null) continue
        try {
          const range = document.createRange()
          range.setStart(startPiece.node, spot.start - startPiece.start)
          range.setEnd(endPiece.node, spot.end - endPiece.start)
          ranges.push(range)
        } catch {
          // A range that cannot be built is simply not painted.
        }
      }
      if (ranges.length === 0) {
        clearHighlights(name)
        return
      }
      try {
        globalThis.CSS.highlights.set(name, new HighlightCtor(...ranges))
      } catch {
        clearHighlights(name)
      }
    }

    /** Shared control styling, drawn from the theme aliases. */
    const S = {
      button: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: 24,
        padding: '0 10px',
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: 12,
        lineHeight: '22px',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      buttonDisabled: {
        color: 'var(--dsw-alias-state-idle-primary)',
        cursor: 'default',
      },
      primary: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: 30,
        padding: '0 16px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-brand-primary)',
        background: 'var(--dsw-alias-brand-primary)',
        color: 'var(--dsw-alias-bg-base)',
        fontSize: 13,
        cursor: 'pointer',
      },
      /**
       * The solid high-contrast button: black in the light theme, and its exact
       * inverse in the dark theme, so it never turns invisible.
       */
      solid: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: 30,
        padding: '0 16px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-label-primary)',
        color: 'var(--dsw-alias-bg-base)',
        fontSize: 13,
        cursor: 'pointer',
      },
      /**
       * The same pill at the composer toolbar's compact size. Its colours come
       * from `CONTROL_CSS` (a class selector), because the hover state cannot
       * be written inline.
       */
      solidSmall: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: 24,
        padding: '0 10px',
        borderRadius: 6,
        border: '1px solid transparent',
        fontSize: 12,
        lineHeight: '22px',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      /** A solid button that is working: keep the colour, drop its voice. */
      solidBusy: {
        cursor: 'default',
        opacity: 0.6,
      },
      ghost: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: 30,
        padding: '0 14px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: 13,
        cursor: 'pointer',
      },
      /** The whole toolbar group: status word, then the button. */
      toolbar: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
      },
      banner: {
        fontSize: 12,
        lineHeight: '20px',
        color: 'var(--dsw-alias-state-error-primary)',
        whiteSpace: 'nowrap',
      },
      /**
       * The issue card. It is absolutely positioned inside the composer's
       * zero-height overlay anchor, so it floats above the input box and never
       * pushes the conversation or the composer tools around.
       */
      panel: {
        position: 'absolute',
        left: 0,
        // 70px of clear space on the right: the "back to latest" round button
        // floats over the composer card's right end, and a full-width card would
        // sit underneath it.
        right: 70,
        bottom: 0,
        marginBottom: 8,
        zIndex: 20,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        maxHeight: 220,
        overflowY: 'auto',
        padding: '10px 12px',
        borderRadius: 10,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-overlay)',
        boxShadow: '0 12px 32px rgba(0, 0, 0, 0.24)',
        fontSize: 12,
      },
      /** A card header: title on the left, its buttons on the right. */
      panelHead: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
      },
      panelTitle: {
        fontSize: 12,
        color: 'var(--dsw-alias-label-primary)',
      },
      list: {
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        maxHeight: 168,
        overflowY: 'auto',
      },
      row: {
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        lineHeight: '22px',
      },
      snippet: {
        color: 'var(--dsw-alias-label-primary)',
        background: 'rgba(255, 196, 0, 0.26)',
        borderRadius: 3,
        padding: '0 3px',
      },
      reason: {
        color: 'var(--dsw-alias-label-secondary)',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      hint: {
        color: 'var(--dsw-alias-label-secondary)',
      },
      error: {
        color: 'var(--dsw-alias-state-error-primary)',
        whiteSpace: 'pre-wrap',
        lineHeight: '18px',
      },
      grow: {
        flex: '1 1 auto',
        minWidth: 0,
      },
      /**
       * A small bordered button, used by the settings table (修改/删除) and by
       * the issue card (重新检查/收起/替换/忽略). Border, text colour and the
       * hover tint come from `CONTROL_CSS`.
       */
      rowAction: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: 22,
        padding: '0 8px',
        borderRadius: 6,
        fontSize: 12,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      /** The confirm button of a destructive dialog. */
      dangerSolid: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: 30,
        padding: '0 16px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-state-error-primary)',
        background: 'var(--dsw-alias-state-error-primary)',
        color: 'var(--dsw-alias-bg-base)',
        fontSize: 13,
        cursor: 'pointer',
      },
      /** The row of small links inside the 操作 column. */
      ops: {
        display: 'flex',
        alignItems: 'center',
        gap: 2,
      },
      page: {
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        // The table has ten columns; a fixed narrow page squeezes every one of
        // them, so the page takes whatever width the plugin view gives it.
        width: '100%',
        minWidth: 0,
        padding: '4px 0 8px',
      },
      pageHead: {
        display: 'flex',
        alignItems: 'center',
        gap: 10,
      },
      table: {
        width: '100%',
        borderCollapse: 'collapse',
        tableLayout: 'fixed',
      },
      /**
       * The header stays put while the page scrolls: the table is often longer
       * than the plugin page, and a header that scrolls away makes five narrow
       * columns unreadable.
       */
      th: {
        position: 'sticky',
        top: 0,
        zIndex: 1,
        textAlign: 'left',
        fontSize: 12,
        fontWeight: 500,
        // A wrapped header would make two headers different heights; the column
        // widths below are chosen so every title fits on one line.
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        color: 'var(--dsw-alias-label-secondary)',
        padding: '6px 6px',
        borderBottom: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-base)',
      },
      td: {
        padding: '7px 6px',
        fontSize: 13,
        color: 'var(--dsw-alias-label-primary)',
        borderBottom: '1px solid var(--dsw-alias-border-l1)',
        verticalAlign: 'middle',
      },
      mono: {
        fontFamily: 'var(--dsw-font-mono, ui-monospace, SFMono-Regular, Consolas, monospace)',
        fontSize: 12,
      },
      ellipsis: {
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      overlay: {
        position: 'fixed',
        inset: 0,
        zIndex: 40,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0, 0, 0, 0.34)',
      },
      dialog: {
        width: 'min(520px, calc(100vw - 48px))',
        // The prompt field makes the box tall; keep it inside the window.
        maxHeight: 'calc(100vh - 48px)',
        overflowY: 'auto',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        padding: '18px 20px 16px',
        borderRadius: 12,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-overlay)',
        boxShadow: '0 18px 48px rgba(0, 0, 0, 0.28)',
      },
      dialogTitle: {
        fontSize: 15,
        fontWeight: 500,
        color: 'var(--dsw-alias-label-primary)',
      },
      /** The confirm box: `dialog` shrunk to 60% of its width. */
      dialogNarrow: {
        width: 'min(312px, calc(100vw - 48px))',
      },
      /** One dialog row: the title in a fixed left column, the control beside it. */
      field: {
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        minHeight: 32,
      },
      label: {
        fontSize: 12,
        color: 'var(--dsw-alias-label-secondary)',
      },
      /** The title column: one width for every row, so all controls line up. */
      fieldLabel: {
        display: 'flex',
        alignItems: 'center',
        gap: 5,
        flex: '0 0 88px',
        width: 88,
        fontSize: 12,
        lineHeight: '16px',
        whiteSpace: 'nowrap',
        color: 'var(--dsw-alias-label-secondary)',
      },
      /** The same title, for a stacked field: no fixed width, so it keeps its line height. */
      fieldLabelStack: {
        display: 'flex',
        alignItems: 'center',
        gap: 5,
        fontSize: 12,
        lineHeight: '16px',
        whiteSpace: 'nowrap',
        color: 'var(--dsw-alias-label-secondary)',
      },
      /** The control column: takes the rest of the row and never overflows it. */
      fieldBody: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flex: '1 1 auto',
        minWidth: 0,
      },
      /** The stacked variant: title on its own line, control across the full width. */
      fieldStack: {
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      },
      /** The small print under a control that needs one. */
      fieldNote: {
        fontSize: 11,
        lineHeight: '16px',
        color: 'var(--dsw-alias-label-secondary)',
      },
      /** The circled i that carries an explanation in its tooltip. */
      infoDot: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 14,
        height: 14,
        borderRadius: '50%',
        border: '1px solid var(--dsw-alias-border-l2)',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: 10,
        fontFamily: 'Georgia, "Times New Roman", serif',
        fontStyle: 'italic',
        lineHeight: 1,
        cursor: 'default',
        userSelect: 'none',
      },
      input: {
        height: 32,
        padding: '0 10px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: 13,
        outline: 'none',
        width: '100%',
        boxSizing: 'border-box',
      },
      /** Multi-line field: the per-source system prompt. */
      textarea: {
        minHeight: 84,
        maxHeight: 220,
        padding: '8px 10px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: 12,
        lineHeight: '18px',
        fontFamily: 'inherit',
        resize: 'vertical',
        outline: 'none',
        width: '100%',
        boxSizing: 'border-box',
      },
      dialogFoot: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-end',
        gap: 8,
        marginTop: 4,
      },
      toggle: {
        position: 'relative',
        width: 34,
        height: 18,
        borderRadius: 9,
        border: 'none',
        padding: 0,
        flex: '0 0 auto',
        cursor: 'pointer',
        transition: 'background 120ms ease',
      },
      knob: {
        position: 'absolute',
        top: 2,
        width: 14,
        height: 14,
        borderRadius: 7,
        background: '#fff',
        boxShadow: '0 1px 2px rgba(0, 0, 0, 0.3)',
        transition: 'left 120ms ease',
      },
      handle: {
        cursor: 'grab',
        userSelect: 'none',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: 13,
        lineHeight: '18px',
        padding: '0 2px',
      },
      empty: {
        padding: '18px 8px',
        fontSize: 13,
        color: 'var(--dsw-alias-label-secondary)',
      },
    }

    /**
     * A small on/off switch: a pill and a knob, no text.
     *
     * @param props - `checked`, `disabled`, `onChange`.
     * @returns the switch.
     */
    function Toggle(props) {
      const checked = props.checked === true
      const label = checked ? '已启用，点一下关掉' : '已停用，点一下打开'
      return withTip(label, h(
        'button',
        {
          type: 'button',
          role: 'switch',
          'aria-checked': checked,
          'aria-label': label,
          disabled: props.disabled === true,
          onClick: () => props.onChange?.(!checked),
          style: {
            ...S.toggle,
            background: checked ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-state-idle-primary)',
            cursor: props.disabled === true ? 'default' : 'pointer',
            opacity: props.disabled === true ? 0.6 : 1,
          },
        },
        h('span', { style: { ...S.knob, left: checked ? 18 : 2 } }),
      ))
    }

    /**
     * One dialog field.
     *
     * Inline by default: the title sits in a fixed-width column and the control
     * fills the rest of the row, so every control starts and ends on the same two
     * edges. `stacked` puts the title on its own line for a control that needs
     * the whole width (the system prompt box).
     *
     * @param props - `title`, optional `hint` and `stacked`, the control as `children`.
     * @returns the field row.
     */
    function Field(props) {
      const hint = typeof props.hint === 'string' ? props.hint : ''
      const label = h(
        'div',
        { style: props.stacked === true ? S.fieldLabelStack : S.fieldLabel },
        h('span', null, props.title),
        hint === ''
          ? null
          : withTip(
            hint,
            h(
              'span',
              { style: S.infoDot, 'aria-label': hint, title: Tooltip === null ? hint : undefined },
              'i',
            ),
          ),
      )
      if (props.stacked === true) {
        return h('div', { style: S.fieldStack }, label, props.children)
      }
      return h('div', { style: S.field }, label, h('div', { style: S.fieldBody }, props.children))
    }

    /**
     * Keeps the toolbar usable if the platform tooltip primitive is missing a
     * piece of context (or changes shape): the composer must never lose the
     * check button because a decoration failed to render.
     */
    class TooltipBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { failed: false }
      }

      static getDerivedStateFromError() {
        return { failed: true }
      }

      render() {
        return this.state.failed ? this.props.fallback : this.props.children
      }
    }

    /**
     * Wrap a control in DSH's own tooltip.
     *
     * A bare `title` attribute renders the operating system's grey bubble, which
     * looks foreign inside the app; the primitive draws the same bubble the send
     * button uses. When the page does not provide the primitive (or it throws),
     * the element is returned untouched so nothing disappears from the UI.
     *
     * @param label - the bubble text; empty or missing means no bubble.
     * @param node - the element to hover.
     * @returns the element, wrapped when a tooltip is available.
     */
    function withTip(label, node) {
      if (Tooltip === null || typeof label !== 'string' || label === '') return node
      return h(TooltipBoundary, { fallback: node }, h(Tooltip, { label, side: 'top', delayMs: 500 }, node))
    }

    /**
     * The composer-toolbar button, with the status word to its left.
     *
     * @param props - slot props: `useInput`, `sessionId`.
     * @returns the toolbar group.
     */
    function CheckButton(props) {
      const draft = props.useInput?.((state) => state.draft)
      const entry = useSessionEntry(props.sessionId)
      const busy = entry.status === 'checking'
      const empty = typeof draft !== 'string' || draft.trim() === ''
      const disabled = busy || empty
      const label = empty ? '先写点什么，再点查错' : '检查错别字（只找错别字，不做润色）'
      const button = h(
        'button',
        {
          type: 'button',
          className: CHECK_CLASS,
          'aria-label': '检查错别字',
          disabled,
          onClick: () => {
            void runCheck(props.sessionId, typeof draft === 'string' ? draft : '')
          },
          style: busy ? { ...S.solidSmall, ...S.solidBusy } : disabled ? { ...S.button, ...S.buttonDisabled } : S.solidSmall,
          title: Tooltip === null ? label : undefined,
        },
        busy ? '检查中…' : '查错',
      )
      return h(
        'div',
        { style: S.toolbar },
        h('style', null, CONTROL_CSS),
        entry.banner === ''
          ? null
          : withTip(entry.error === '' ? entry.banner : entry.error, h('span', { style: S.banner }, entry.banner)),
        // Same primitive, side and delay as the composer's send button, so the
        // bubble looks identical without copying its stylesheet.
        Tooltip === null
          ? button
          : h(TooltipBoundary, { fallback: button }, h(Tooltip, { label, side: 'top', delayMs: 500 }, button)),
      )
    }

    /**
     * The highlight layer: mounts inside the composer card and paints ranges.
     *
     * It returns no visible box; the `<style>` element carries the
     * `::highlight()` rule and disappears with the component.
     *
     * @param props - slot props: `useInput`, `sessionId`.
     * @returns an inert anchor plus the highlight stylesheet.
     */
    function HighlightLayer(props) {
      const draft = props.useInput?.((state) => state.draft)
      const entry = useSessionEntry(props.sessionId)
      const holder = React.useRef(null)
      const name = highlightName(props.sessionId)

      React.useEffect(() => {
        // Lexical commits its DOM in the same frame; painting on the next frame
        // reads the final text nodes instead of the ones being replaced.
        const frame = globalThis.requestAnimationFrame(() => {
          paintHighlights(holder.current, entry.issues, name)
        })
        return () => globalThis.cancelAnimationFrame(frame)
      }, [draft, entry.issues, name])

      React.useEffect(() => () => clearHighlights(name), [name])

      return h(
        'div',
        {
          ref: holder,
          'aria-hidden': true,
          style: { position: 'absolute', top: 0, left: 0, width: 0, height: 0, pointerEvents: 'none' },
        },
        h('style', { dangerouslySetInnerHTML: { __html: highlightCss(name) } }),
      )
    }

    /**
     * The issue list under the composer card.
     *
     * @param props - slot props: `useInput`, `inputActions`, `sessionId`.
     * @returns the panel, or nothing when there is nothing to say.
     */
    function IssuePanel(props) {
      const input = props.useInput?.((state) => state)
      const entry = useSessionEntry(props.sessionId)
      const phase = input?.phase
      const draft = typeof input?.draft === 'string' ? input.draft : ''
      // Sending consumes the draft, and the results go with it. An ordinary
      // send keeps `phase` at `plain` (only slash commands pass through
      // `adjudicating` / `submitting`), so the honest signal is the composer
      // running empty; the phase check stays for the command paths.
      React.useEffect(() => {
        if (phase === 'submitting' || phase === 'adjudicating') {
          clearEntry(props.sessionId)
          return
        }
        if (draft === '') clearEntry(props.sessionId)
      }, [phase, draft, props.sessionId])
      if (entry.status === 'idle') return null
      if (entry.status === 'checking') return null

      const issues = Array.isArray(entry.issues) ? entry.issues : []
      const head = h(
        'div',
        { style: S.panelHead },
        h(
          'span',
          { style: S.panelTitle },
          entry.status === 'error'
            ? '查错没跑成'
            : issues.length === 0
              ? '没发现错别字'
              : `发现 ${issues.length} 处错别字`,
        ),
        entry.status === 'done' && issues.length > 0 ? h('span', { style: S.hint }, entry.source) : null,
        entry.truncated ? h('span', { style: S.hint }, '（太长，只查了前 6000 字）') : null,
        h('span', { style: S.grow }),
        withTip('用当前内容重新检查', h(
          'button',
          {
            type: 'button',
            className: ACTION_CLASS,
            style: S.rowAction,
            onClick: () => {
              void runCheck(props.sessionId, typeof input?.draft === 'string' ? input.draft : '')
            },
          },
          '重新检查',
        )),
        withTip('收起结果', h(
          'button',
          {
            type: 'button',
            className: ACTION_CLASS,
            style: S.rowAction,
            onClick: () => {
              clearEntry(props.sessionId)
            },
          },
          '收起',
        )),
      )

      const body = entry.status === 'error'
        ? h(
          'div',
          { style: S.error },
          entry.failures.length === 0 ? entry.error : entry.failures.join('\n'),
        )
        : issues.length === 0
          ? h('div', { style: S.hint }, '这次没有查出错别字。')
          : h(
            'div',
            { style: S.list },
            ...issues.map((issue, index) => h(
              'div',
              { key: `${issue.start}-${index}`, style: S.row },
              h('span', { style: S.snippet }, issue.original),
              h('span', { style: S.hint }, '→'),
              h('span', { style: S.snippet }, issue.suggestion),
              h('span', { style: { ...S.reason, ...S.grow } }, issue.reason),
              withTip('替换这处', h(
                'button',
                {
                  type: 'button',
                  className: `${ACTION_CLASS} ${ACTION_SOLID_CLASS}`,
                  style: S.rowAction,
                  onClick: () => applyFix(input, props.inputActions, props.sessionId, issue),
                },
                '替换',
              )),
              withTip('保留原文，从列表里去掉', h(
                'button',
                {
                  type: 'button',
                  className: ACTION_CLASS,
                  style: S.rowAction,
                  onClick: () => ignoreIssue(props.sessionId, issue),
                },
                '忽略',
              )),
            )),
          )

      // A fix can fail on its own (the text moved, the span holds a reference),
      // and that message has nowhere else to go: show it above the list.
      const note = entry.status === 'error' || entry.error === ''
        ? null
        : h('div', { style: { ...S.error, fontSize: 12 } }, entry.error)

      return h('div', { style: S.panel }, head, note, body)
    }

    /** The wire shape of one source: never carries the key unless it changed. */
    const wireOf = (source, apiKey) => ({
      id: source.id,
      name: source.name,
      url: source.url,
      model: source.model,
      enabled: source.enabled,
      thinking: source.thinking === true,
      maxTokens: maxTokensOf(source),
      prompt: typeof source.prompt === 'string' ? source.prompt : '',
      ...(typeof apiKey === 'string' && apiKey !== '' ? { apiKey } : {}),
    })

    /** The answer-token cap shown for one source; the host clamps what it gets. */
    const maxTokensOf = (source) => {
      const value = Number(source?.maxTokens)
      return Number.isFinite(value) && value > 0 ? Math.round(value) : DEFAULT_MAX_TOKENS
    }

    /** The custom prompt of one source, trimmed; empty means the built-in one. */
    const promptText = (source) => (typeof source.prompt === 'string' ? source.prompt.trim() : '')

    /** Table tooltip for the prompt column: a preview, not the whole page. */
    const promptTip = (source) => {
      const text = promptText(source)
      if (text === '') return '没填，用内置的查错提示词'
      return text.length > 160 ? `${text.slice(0, 160)}…` : text
    }

    /**
     * The add/edit dialog, drawn in the DSH surface colours.
     *
     * @param props - `initial`, `busy`, `onCancel`, `onConfirm`.
     * @returns the modal.
     */
    function SourceDialog(props) {
      const initial = props.initial ?? { name: '', url: '', model: '', enabled: true }
      // The built-in instructions, shown in the box so the user edits the real
      // text. Saving it unchanged stores an empty prompt, which keeps the row on
      // the built-in version instead of freezing today's copy of it.
      const defaultPrompt = typeof props.defaultPrompt === 'string' ? props.defaultPrompt : ''
      const ownPrompt = typeof initial.prompt === 'string' ? initial.prompt.trim() : ''
      const [form, setForm] = React.useState({
        name: initial.name ?? '',
        url: initial.url ?? '',
        model: initial.model ?? '',
        apiKey: '',
        thinking: initial.thinking === true,
        maxTokens: String(maxTokensOf(initial)),
        prompt: ownPrompt === '' ? defaultPrompt : initial.prompt,
      })
      const [testing, setTesting] = React.useState(false)
      const [probe, setProbe] = React.useState(null)
      const patch = (key, value) => setForm((current) => ({ ...current, [key]: value }))
      const ready = form.url.trim() !== '' && form.model.trim() !== ''
      /** The token cap as typed: an empty box means "the default". */
      const tokenCap = () => (form.maxTokens.trim() === '' ? DEFAULT_MAX_TOKENS : Number(form.maxTokens))

      const submit = () => {
        if (!ready || props.busy === true) return
        props.onConfirm?.({
          name: form.name.trim() === '' ? hostOf(form.url) : form.name.trim(),
          url: form.url.trim(),
          model: form.model.trim(),
          enabled: initial.enabled !== false,
          thinking: form.thinking === true,
          maxTokens: tokenCap(),
          prompt: form.prompt.trim() === '' || form.prompt.trim() === defaultPrompt.trim()
            ? ''
            : form.prompt,
          apiKey: form.apiKey.trim(),
        })
      }

      /**
       * Ask the Host to run the sample sentence through exactly this row.
       *
       * The Host fills in the stored key when the field is left empty, so an
       * existing row can be re-tested without retyping the secret.
       */
      const test = async () => {
        if (!ready || testing || props.busy === true) return
        setTesting(true)
        setProbe(null)
        try {
          const payload = await call(TEST_ROUTE, {
            ...JSON_POST,
            body: JSON.stringify({
              id: initial.id,
              url: form.url.trim(),
              model: form.model.trim(),
              apiKey: form.apiKey.trim(),
              thinking: form.thinking === true,
              maxTokens: tokenCap(),
              prompt: form.prompt,
            }),
          })
          const issues = Array.isArray(payload?.issues) ? payload.issues : []
          const note = typeof payload?.note === 'string' && payload.note !== ''
            ? payload.note
            : issues.length === 0
              ? '示例句没有查出问题'
              : issues.map((issue) => `${issue.original} → ${issue.suggestion}`).join('，')
          setProbe({ ok: true, text: `连接正常 · 用时 ${payload?.latencyMs ?? '?'} ms · ${note}` })
        } catch (error) {
          setProbe({ ok: false, text: error instanceof Error ? error.message : String(error) })
        }
        setTesting(false)
      }

      const input = (key, placeholder, extra) => h('input', {
        style: { ...S.input, ...(extra?.mono === true ? S.mono : {}) },
        type: extra?.secret === true ? 'password' : 'text',
        inputMode: extra?.numeric === true ? 'numeric' : undefined,
        autoComplete: 'off',
        spellCheck: false,
        placeholder,
        value: form[key],
        onChange: (event) => {
          // A token cap is digits only, so a stray "-" or "1.5e3" cannot reach the host.
          const digitsOnly = extra?.numeric === true ? event.target.value.replace(/\D/g, '').slice(0, 5) : null
          patch(key, digitsOnly === null ? event.target.value : digitsOnly)
        },
        onKeyDown: (event) => {
          if (event.key === 'Enter') submit()
          if (event.key === 'Escape') props.onCancel?.()
        },
        autoFocus: extra?.focus === true,
      })

      return h(
        'div',
        {
          style: S.overlay,
          onMouseDown: (event) => {
            if (event.target === event.currentTarget) props.onCancel?.()
          },
        },
        h(
          'div',
          { style: S.dialog, role: 'dialog', 'aria-modal': true },
          h('div', { style: S.dialogTitle }, initial.id === undefined ? '添加来源' : '编辑来源'),
          h(Field, { title: '名称' }, input('name', '例如 中转站 A', { focus: true })),
          h(Field, { title: 'URL' }, input('url', 'https://api.openai.com/v1 或完整的 /chat/completions 地址', { mono: true })),
          h(Field, { title: 'Key' }, input(
            'apiKey',
            initial.hasKey === true ? `已保存 ${initial.keyHint}（留空表示不改）` : '粘贴服务商的 Key',
            { secret: true, mono: true },
          )),
          h(Field, { title: '模型' }, input('model', '例如 gpt-4o-mini / deepseek-chat', { mono: true })),
          h(
            Field,
            { title: '思考模式', hint: THINKING_HINT },
            h(Toggle, {
              checked: form.thinking === true,
              disabled: props.busy === true,
              onChange: (next) => patch('thinking', next),
            }),
          ),
          h(
            Field,
            { title: 'max_tokens', hint: MAX_TOKENS_HINT },
            input('maxTokens', '留空用 2000', { mono: true, numeric: true }),
          ),
          h(
            Field,
            { title: '系统提示词', stacked: true },
            h('textarea', {
              style: S.textarea,
              spellCheck: false,
              rows: 4,
              placeholder: '清空就用内置的查错提示词。',
              value: form.prompt,
              onChange: (event) => patch('prompt', event.target.value),
            }),
            h(
              'div',
              { style: S.fieldNote },
              '上面是内置的查错提示词，可以按需改；保持原样（或清空）就继续跟随内置版本。',
            ),
          ),
          h(
            'div',
            { style: { ...S.hint, fontSize: 12, lineHeight: '18px' } },
            '任何遵循 OpenAI 接口的来源都行：URL 填到 /v1 为止会自动补 /chat/completions，填完整地址则原样使用。',
          ),
          probe === null
            ? null
            : h(
              'div',
              {
                style: probe.ok
                  ? { ...S.hint, fontSize: 12, lineHeight: '18px' }
                  : { ...S.error, fontSize: 12 },
              },
              probe.text,
            ),
          h(
            'div',
            { style: S.dialogFoot },
            h(
              'button',
              {
                type: 'button',
                style: S.ghost,
                disabled: testing || !ready || props.busy === true,
                onClick: () => {
                  void test()
                },
              },
              testing ? '测试中…' : '测试连接',
            ),
            h('span', { style: S.grow }),
            h(
              'button',
              { type: 'button', style: S.ghost, disabled: props.busy === true, onClick: () => props.onCancel?.() },
              '取消',
            ),
            h(
              'button',
              { type: 'button', style: { ...S.primary, opacity: ready ? 1 : 0.5 }, disabled: !ready || props.busy === true, onClick: submit },
              '确定',
            ),
          ),
        ),
      )
    }

    /**
     * A yes/no box for actions that cannot be undone.
     *
     * @param props - `title`, `message`, `confirmLabel`, `busy`, `onCancel`, `onConfirm`.
     * @returns the modal.
     */
    function ConfirmDialog(props) {
      return h(
        'div',
        {
          style: S.overlay,
          onMouseDown: (event) => {
            if (event.target === event.currentTarget) props.onCancel?.()
          },
        },
        h(
          'div',
          { style: { ...S.dialog, ...S.dialogNarrow }, role: 'dialog', 'aria-modal': true },
          h('div', { style: S.dialogTitle }, props.title),
          h(
            'div',
            { style: { ...S.hint, fontSize: 13, lineHeight: '20px' } },
            props.message,
          ),
          h(
            'div',
            { style: S.dialogFoot },
            h('span', { style: S.grow }),
            h(
              'button',
              { type: 'button', style: S.ghost, disabled: props.busy === true, onClick: () => props.onCancel?.() },
              '取消',
            ),
            h(
              'button',
              { type: 'button', style: S.dangerSolid, disabled: props.busy === true, onClick: () => props.onConfirm?.() },
              props.confirmLabel ?? '确定',
            ),
          ),
        ),
      )
    }

    /**
     * The host of a URL, used as the default row name.
     *
     * @param url - a URL typed by the user.
     * @returns the host, or the raw text when it does not parse.
     */
    function hostOf(url) {
      try {
        return new URL(url.trim()).host
      } catch {
        return url.trim()
      }
    }

    /**
     * The settings page shown in the plugin detail page.
     *
     * @param props - slot props: `view` is `'summary'` for the row itself.
     * @returns the row summary or the full table.
     */
    function SettingsPanel(props) {
      const [settings, setSettings] = React.useState(null)
      const [problem, setProblem] = React.useState('')
      const [busy, setBusy] = React.useState('')
      const [dialog, setDialog] = React.useState(null)
      const [removing, setRemoving] = React.useState(null)
      const [dragging, setDragging] = React.useState(-1)
      const [over, setOver] = React.useState(-1)
      const summaryOnly = props?.view === 'summary'

      React.useEffect(() => {
        let alive = true
        void call(SETTINGS_ROUTE)
          .then((payload) => {
            if (alive) setSettings(payload?.settings ?? { sources: [] })
          })
          .catch((error) => {
            if (alive) setProblem(error instanceof Error ? error.message : String(error))
          })
        return () => {
          alive = false
        }
      }, [])

      const sources = Array.isArray(settings?.sources) ? settings.sources : []
      const enabledCount = sources.filter((source) => source.enabled).length

      if (summaryOnly) {
        const label = settings === null
          ? '正在读取设置…'
          : sources.length === 0
            ? '还没有来源'
            : `${sources.length} 个来源 · ${enabledCount} 个启用`
        return h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
          h('div', { style: { fontSize: 13, color: 'var(--dsw-alias-label-primary)' } }, '输入框查错'),
          h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, label),
        )
      }

      /** Send the whole list; the Host keeps stored keys for rows that omit one. */
      const save = async (next) => {
        setBusy('save')
        setProblem('')
        try {
          const payload = await call(SETTINGS_ROUTE, {
            ...JSON_POST,
            body: JSON.stringify({ sources: next }),
          })
          setSettings(payload?.settings ?? { sources: [] })
        } catch (error) {
          setProblem(error instanceof Error ? error.message : String(error))
        }
        setBusy('')
      }

      const confirmDialog = (form) => {
        const target = dialog
        if (target === null) return
        const next = target.mode === 'add'
          ? [...sources.map((source) => wireOf(source)), wireOf({ ...form, enabled: true }, form.apiKey)]
          : sources.map((source) => (source.id === target.source.id ? wireOf({ ...source, ...form }, form.apiKey) : wireOf(source)))
        setDialog(null)
        void save(next)
      }

      /** Delete one row, once the confirm box says yes. */
      const removeSource = () => {
        const target = removing
        if (target === null) return
        setRemoving(null)
        void save(sources.filter((source) => source.id !== target.id).map((source) => wireOf(source)))
      }

      const moveTo = (from, to) => {
        if (from < 0 || to < 0 || from === to) return
        const next = [...sources]
        const [item] = next.splice(from, 1)
        next.splice(to, 0, item)
        void save(next.map((source) => wireOf(source)))
      }

      const head = h(
        'div',
        { style: S.pageHead },
        h(
          'button',
          {
            type: 'button',
            style: S.solid,
            disabled: busy !== '' || sources.length >= 20,
            onClick: () => setDialog({ mode: 'add' }),
          },
          '添加',
        ),
      )

      const table = sources.length === 0
        ? h('div', { style: S.empty }, '还没有来源。点「添加」填一个 OpenAI 兼容的地址。')
        : h(
          'table',
          { style: S.table },
          h(
            'thead',
            null,
            h(
              'tr',
              null,
              h('th', { style: { ...S.th, width: '7%' } }, '名称'),
              h('th', { style: { ...S.th, width: '24%' } }, 'URL'),
              h('th', { style: { ...S.th, width: '6%' } }, 'Key'),
              h('th', { style: { ...S.th, width: '13%' } }, '模型'),
              h('th', { style: { ...S.th, width: '11%' } }, '系统提示词'),
              h('th', { style: { ...S.th, width: '9%' } }, 'max_tokens'),
              h('th', { style: { ...S.th, width: '7%' } }, '思考模式'),
              h('th', { style: { ...S.th, width: '13%' } }, '操作'),
              h('th', { style: { ...S.th, width: '5%' } }, '启用'),
              h('th', { style: { ...S.th, width: '5%' } }, '排序'),
            ),
          ),
          h(
            'tbody',
            null,
            ...sources.map((source, index) => h(
              'tr',
              {
                key: source.id,
                onDragOver: (event) => {
                  event.preventDefault()
                  if (over !== index) setOver(index)
                },
                onDrop: (event) => {
                  event.preventDefault()
                  moveTo(dragging, index)
                  setDragging(-1)
                  setOver(-1)
                },
                style: {
                  opacity: dragging === index ? 0.45 : 1,
                  background: over === index && dragging !== -1 && dragging !== index
                    ? 'var(--dsw-alias-bg-layer-2)'
                    : 'transparent',
                },
              },
              h(
                'td',
                { style: S.td },
                withTip(
                  source.name === '' ? source.url : source.name,
                  h('div', { style: S.ellipsis }, source.name === '' ? hostOf(source.url) : source.name),
                ),
              ),
              h('td', { style: S.td }, withTip(
                source.url,
                h('div', { style: { ...S.mono, ...S.ellipsis } }, source.url),
              )),
              h(
                'td',
                { style: S.td },
                withTip(
                  source.hasKey ? source.keyHint : '未填',
                  h('div', { style: { ...S.mono, ...S.ellipsis } }, source.hasKey ? source.keyHint : '未填'),
                ),
              ),
              h(
                'td',
                { style: S.td },
                withTip(
                  source.model === '' ? '未填模型' : source.model,
                  h('div', { style: { ...S.mono, ...S.ellipsis } }, source.model === '' ? '未填' : source.model),
                ),
              ),
              h(
                'td',
                { style: S.td },
                withTip(
                  promptTip(source),
                  h(
                    'div',
                    {
                      style: promptText(source) === ''
                        ? { ...S.ellipsis, color: 'var(--dsw-alias-label-secondary)' }
                        : S.ellipsis,
                    },
                    promptText(source) === '' ? '默认' : promptText(source),
                  ),
                ),
              ),
              h(
                'td',
                { style: S.td },
                withTip(
                  `一次回答最多 ${maxTokensOf(source)} 个 token`,
                  h('div', { style: { ...S.mono, ...S.ellipsis } }, String(maxTokensOf(source))),
                ),
              ),
              h(
                'td',
                { style: S.td },
                h(Toggle, {
                  checked: source.thinking === true,
                  disabled: busy !== '',
                  onChange: (next) => {
                    void save(sources.map((item) => wireOf(item.id === source.id ? { ...item, thinking: next } : item)))
                  },
                }),
              ),
              h(
                'td',
                { style: S.td },
                h(
                  'div',
                  { style: S.ops },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: ACTION_CLASS,
                      style: S.rowAction,
                      disabled: busy !== '',
                      onClick: () => setDialog({ mode: 'edit', source }),
                    },
                    '修改',
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: `${ACTION_CLASS} ${ACTION_DANGER_CLASS}`,
                      style: S.rowAction,
                      disabled: busy !== '',
                      onClick: () => setRemoving(source),
                    },
                    '删除',
                  ),
                ),
              ),
              h(
                'td',
                { style: S.td },
                h(Toggle, {
                  checked: source.enabled,
                  disabled: busy !== '',
                  onChange: (next) => {
                    void save(sources.map((item) => wireOf(item.id === source.id ? { ...item, enabled: next } : item)))
                  },
                }),
              ),
              h(
                'td',
                { style: S.td },
                withTip('拖动调整顺序', h(
                  'span',
                  {
                    draggable: true,
                    onDragStart: (event) => {
                      setDragging(index)
                      try {
                        event.dataTransfer.effectAllowed = 'move'
                        event.dataTransfer.setData('text/plain', String(index))
                      } catch {
                        // Some engines refuse a data payload; the index state is enough.
                      }
                    },
                    onDragEnd: () => {
                      setDragging(-1)
                      setOver(-1)
                    },
                    style: dragging === index ? { ...S.handle, cursor: 'grabbing' } : S.handle,
                  },
                  '⠿',
                )),
              ),
            )),
          ),
        )

      return h(
        'div',
        { style: S.page },
        h('style', null, CONTROL_CSS),
        head,
        table,
        problem === '' ? null : h('div', { style: { ...S.error, fontSize: 12 } }, problem),
        dialog === null
          ? null
          : h(SourceDialog, {
            initial: dialog.mode === 'edit' ? dialog.source : { enabled: true },
            defaultPrompt: typeof settings?.defaultPrompt === 'string' ? settings.defaultPrompt : '',
            busy: busy === 'save',
            onCancel: () => setDialog(null),
            onConfirm: confirmDialog,
          }),
        removing === null
          ? null
          : h(ConfirmDialog, {
            title: '删除来源',
            message: `确定删除「${removing.name === '' ? hostOf(removing.url) : removing.name}」吗？`,
            confirmLabel: '删除',
            busy: busy === 'save',
            onCancel: () => setRemoving(null),
            onConfirm: removeSource,
          }),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // The toolbar button sits left of the send action.
        ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
          name: 'conversation.input.right',
          id: 'dsh-typo-check-button',
          order: 20,
        }, CheckButton))

        // The painter lives inside the composer card but renders no box.
        ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
          name: 'conversation.input.overlay',
          id: 'dsh-typo-check-highlight',
          order: 30,
        }, HighlightLayer))

        // The result card floats above the composer card, in the same overlay
        // area, so it never reflows the conversation or the toolbar.
        ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
          name: 'conversation.input.overlay',
          id: 'dsh-typo-check-panel',
          order: 40,
        }, IssuePanel))

        // The settings table is a row in the plugin detail page.
        ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
          name: 'plugins.row.config',
          key: ROW_KEY,
          order: 60,
        }, SettingsPanel))
      },
    }
  },
})
