import { REACT_MSG_HELPERS } from './REACT_MSG_HELPERS.js';

export const DEEPSEEK_DOMAIN = 'chat.deepseek.com';
export const DEEPSEEK_URL = 'https://chat.deepseek.com/';
export const TEXTAREA_SELECTOR = 'textarea[placeholder*="DeepSeek"]';
export const MESSAGE_SELECTOR = '.ds-message';

export async function isOnDeepSeek(page) {
    const url = await page.evaluate('window.location.href').catch(() => '');
    if (typeof url !== 'string' || !url) return false;
    try {
        const h = new URL(url).hostname;
        return h === 'deepseek.com' || h.endsWith('.deepseek.com');
    } catch {
        return false;
    }
}

export async function ensureOnDeepSeek(page) {
    if (await isOnDeepSeek(page)) return false;
    await page.goto(DEEPSEEK_URL);
    await page.wait(3);
    return true;
}

export async function getPageState(page) {
    return page.evaluate(`(() => {
        const url = window.location.href;
        const title = document.title;
        const textarea = document.querySelector('${TEXTAREA_SELECTOR}');
        const avatar = document.querySelector('img[src*="user-avatar"]');
        return {
            url,
            title,
            hasTextarea: !!textarea,
            isLoggedIn: !!avatar,
        };
    })()`);
}

export async function selectModel(page, modelName) {
    return page.evaluate(`(() => {
        var radios = document.querySelectorAll('div[role="radio"]');
        if (radios.length === 0) return { ok: false };
        var isFirst = '${modelName}'.toLowerCase() === 'instant';
        if (!isFirst && radios.length < 2) return { ok: false };
        var target = isFirst ? radios[0] : radios[radios.length - 1];
        var alreadySelected = target.getAttribute('aria-checked') === 'true';
        if (!alreadySelected) target.click();
        return { ok: true, toggled: !alreadySelected };
    })()`);
}

export async function setFeature(page, featureName, enabled) {
    // Match by position: DeepThink is the first toggle, Search is the second
    var index = featureName === 'DeepThink' ? 0 : 1;
    return page.evaluate(`(() => {
        var toggles = Array.from(document.querySelectorAll('.ds-toggle-button'));
        var btn = toggles[${index}];
        if (!btn) return { ok: false };
        var isActive = btn.classList.contains('ds-toggle-button--selected');
        if (${enabled} !== isActive) btn.click();
        return { ok: true, toggled: ${enabled} !== isActive };
    })()`);
}

export async function sendMessage(page, prompt) {
    const promptJson = JSON.stringify(prompt);
    return page.evaluate(`(async () => {
        const box = document.querySelector('${TEXTAREA_SELECTOR}');
        if (!box) return { ok: false, reason: 'textarea not found' };

        box.focus();
        box.value = '';
        document.execCommand('selectAll');
        document.execCommand('insertText', false, ${promptJson});
        await new Promise(r => setTimeout(r, 800));

        const btns = document.querySelectorAll('div[role="button"]');
        for (const btn of btns) {
            if (btn.getAttribute('aria-disabled') === 'false') {
                const svgs = btn.querySelectorAll('svg');
                if (svgs.length > 0 && btn.parentElement?.previousSibling?.tagName === 'INPUT') {
                    btn.click();
                    return { ok: true };
                }
            }
        }

        box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
        return { ok: true, method: 'enter' };
    })()`);
}

export async function getBubbleCount(page) {
    const count = await page.evaluate(`(() => {
        return document.querySelectorAll('${MESSAGE_SELECTOR}').length;
    })()`);
    return count || 0;
}

// Parse thinking response using text as a fallback when DOM-level extraction
// is not available.  Does NOT split on \n\n — that heuristic silently corrupts
// multi-paragraph thinking or multi-paragraph answers.  Instead, everything
// after the header is treated as thinking content, and `response` stays empty
// until the caller provides a DOM-separated answer.
export function parseThinkingResponse(rawText) {
    if (!rawText) return null;

    // Match thinking header patterns: "Thought for X seconds" or "已思考（用时 X 秒）"
    const thinkHeaderMatch = rawText.match(/^(Thought for ([\d.]+) seconds?|已思考（用时 ([\d.]+) 秒）)\s*/);

    if (!thinkHeaderMatch) {
        // No thinking section found, return plain response
        return { response: rawText, thinking: null, thinking_time: null };
    }

    const thinkingTime = thinkHeaderMatch[2] || thinkHeaderMatch[3];
    const afterHeader = rawText.slice(thinkHeaderMatch[0].length);

    // Treat everything after the header as thinking.  The response will be
    // populated by the DOM-level extraction in waitForResponse().
    return {
        response: '',
        thinking: afterHeader.trim(),
        thinking_time: thinkingTime,
    };
}

export async function waitForResponse(page, baselineCount, prompt, timeoutMs, parseThinking = false) {
    const startTime = Date.now();
    let lastText = '';
    let stableCount = 0;

    while (Date.now() - startTime < timeoutMs) {
        await page.wait(3);
        console.log('Checking for new response...'); // Debug log
        let result;
        try {
            result = await page.evaluate(`
                (() => {
                ;;${REACT_MSG_HELPERS};;
                const bubbles = document.querySelectorAll('${MESSAGE_SELECTOR}');
                const texts = Array.from(bubbles).map(b => (b.innerText || '').trim()).filter(Boolean);
                var last = texts[texts.length - 1] || '';
                var lastBubble = bubbles.length > 0 ? bubbles[bubbles.length - 1] : null;

                // Try to get raw markdown from React tree for the last bubble
                var reactMarkdown = lastBubble ? __findMessageInDomTree(lastBubble) : null;

                // DOM-level thinking/response separation.
                // DeepSeek renders thinking in a collapsible container with a
                // distinct class (e.g. .ds-markdown--think or similar) and the
                // final answer in the main .ds-markdown region.  By querying
                // these separately we avoid any text-heuristic split.
                var thinkEl = null, answerEl = null, thinkTime = null;
                var reactAnswerMarkdown = null;
                if (${parseThinking} && lastBubble) {
                    // Thinking container — DeepSeek uses various class names;
                    // try common selectors.
                    thinkEl = lastBubble.querySelector('.ds-markdown--think')
                           || lastBubble.querySelector('[class*="think"]');
                    // Final answer container — the main markdown block that is
                    // NOT the thinking section.
                    var markdownEls = lastBubble.querySelectorAll('.ds-markdown');
                    for (var i = 0; i < markdownEls.length; i++) {
                        if (markdownEls[i] !== thinkEl
                            && !(thinkEl && thinkEl.contains(markdownEls[i]))
                            && !markdownEls[i].classList.contains('ds-markdown--think')) {
                            answerEl = markdownEls[i];
                        }
                    }
                    // Try to get raw markdown for the answer element from React tree
                    if (answerEl) {
                        reactAnswerMarkdown = __findMessageInDomTree(answerEl);
                    }
                    // Thinking time from the toggle/header element
                    var timeEl = lastBubble.querySelector('[class*="think"] ~ *')
                              || lastBubble.querySelector('.ds-thinking-header');
                    if (!timeEl) {
                        // Fallback: parse from raw text header
                        var m = last.match(/^(?:Thought for ([\\d.]+) seconds?|已思考（用时 ([\\d.]+) 秒）)/);
                        if (m) thinkTime = m[1] || m[2];
                    } else {
                        var tm = (timeEl.textContent || '').match(/([\\d.]+)/);
                        if (tm) thinkTime = tm[1];
                    }
                }

                return {
                    count: texts.length,
                    last: last,
                    loading: reactMarkdown ? reactMarkdown.loading : false,
                    // Raw markdown from React tree (preferred over innerText)
                    reactMarkdown: reactMarkdown ? reactMarkdown.content : null,
                    // DOM-separated fields (null when not available)
                    thinkText: thinkEl ? (thinkEl.innerText || '').trim() : null,
                    answerText: answerEl ? (answerEl.innerText || '').trim() : null,
                    // Raw markdown for answer from React tree
                    reactAnswerMarkdown: reactAnswerMarkdown ? reactAnswerMarkdown.content : null,
                    thinkTime: thinkTime,
                    log: __log,
                };
            })()`);
            console.log('Evaluation result:', result); // Debug log
            if (result?.log?.length) console.log('[REACT_LOG]', result.log);
        } catch (e) {
            console.error('Error evaluating page for response:', e);
            continue;
        }

        if (!result) continue;

        if (result.loading) {
            stableCount = 0;
            continue;
        }

        const candidate = result.last;
        if (candidate && result.count > baselineCount && candidate !== prompt.trim()) {
            if (candidate === lastText) {
                stableCount++;
                if (stableCount >= 3) {
                    if (parseThinking) {
                        // Prefer DOM-level separation
                        if (result.thinkText != null || result.answerText != null) {
                            return {
                                thinking: result.thinkText || '',
                                // Prefer raw markdown from React tree over innerText
                                response: result.reactAnswerMarkdown || result.answerText || '',
                                thinking_time: result.thinkTime || null,
                            };
                        }
                        // Fallback to text-header parsing (no \n\n split)
                        return parseThinkingResponse(candidate);
                    }
                    // Prefer raw markdown from React tree over innerText
                    return result.reactMarkdown || candidate;
                }
            } else {
                stableCount = 0;
            }
            lastText = candidate;
        }
    }

    if (parseThinking && lastText) {
        return parseThinkingResponse(lastText);
    }
    return lastText || null;
}

export async function getVisibleMessages(page) {
    const result = await page.evaluate(`(() => {
        const msgs = document.querySelectorAll('${MESSAGE_SELECTOR}');
        return Array.from(msgs).map(m => {
            // User messages carry an extra hash-class alongside ds-message
            const isUser = m.className.split(/\\s+/).length > 2;
            return {
                Role: isUser ? 'user' : 'assistant',
                Text: (m.innerText || '').trim(),
            };
        }).filter(m => m.Text);
    })()`);
    return Array.isArray(result) ? result : [];
}

export async function getConversationList(page) {
    await ensureOnDeepSeek(page);
    // Expand sidebar if collapsed
    await page.evaluate(`(() => {
        if (document.querySelectorAll('a[href*="/a/chat/s/"]').length === 0) {
            const btn = document.querySelector('div[tabindex="0"][role="button"]');
            if (btn) btn.click();
        }
    })()`);
    for (let attempt = 0; attempt < 5; attempt++) {
        await page.wait(2);
        const items = await page.evaluate(`(() => {
            const items = [];
            const links = document.querySelectorAll('a[href*="/a/chat/s/"]');
            links.forEach((link, i) => {
                const title = (link.innerText || '').trim().split('\\n')[0].trim();
                const href = link.getAttribute('href') || '';
                const idMatch = href.match(/\\/s\\/([a-f0-9-]+)/);
                items.push({
                    Index: i + 1,
                    Id: idMatch ? idMatch[1] : href,
                    Title: title || '(untitled)',
                    Url: 'https://chat.deepseek.com' + href,
                });
            });
            return items;
        })()`);
        if (Array.isArray(items) && items.length > 0) return items;
    }
    return [];
}

async function waitForFilePreview(page, fileName) {
    for (let attempt = 0; attempt < 8; attempt++) {
        await page.wait(2);
        const ready = await page.evaluate(`(() => {
            const name = ${JSON.stringify(fileName)};
            return Array.from(document.querySelectorAll('div'))
                .some((el) => el.children.length === 0 && (el.textContent || '').trim() === name);
        })()`);
        if (ready) return true;
    }
    return false;
}

export async function sendWithFile(page, filePath, prompt) {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const absPath = path.default.resolve(filePath);

    if (!fs.default.existsSync(absPath)) {
        return { ok: false, reason: `File not found: ${absPath}` };
    }

    const stats = fs.default.statSync(absPath);
    if (stats.size > 100 * 1024 * 1024) {
        return { ok: false, reason: `File too large (${(stats.size / 1024 / 1024).toFixed(1)} MB). Max: 100 MB` };
    }

    const fileName = path.default.basename(absPath);

    // Collapse sidebar to keep DOM simple for send button matching
    await page.evaluate(`(() => {
        if (document.querySelectorAll('a[href*="/a/chat/s/"]').length > 0) {
            const btn = document.querySelector('div[tabindex="0"][role="button"]');
            if (btn) btn.click();
        }
    })()`);
    await page.wait(0.5);

    let uploaded = false;
    if (page.setFileInput) {
        try {
            await page.setFileInput([absPath], 'input[type="file"]');
            uploaded = true;
        } catch (err) {
            const msg = String(err?.message || err);
            if (!msg.includes('Unknown action') && !msg.includes('not supported')) {
                throw err;
            }
        }
    }

    if (!uploaded) {
        const content = fs.default.readFileSync(absPath);
        const base64 = content.toString('base64');
        const fallbackResult = await page.evaluate(`(async () => {
            var binary = atob('${base64}');
            var bytes = new Uint8Array(binary.length);
            for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

            var file = new File([bytes], ${JSON.stringify(fileName)});
            var dt = new DataTransfer();
            dt.items.add(file);

            var inp = document.querySelector('input[type="file"]');
            if (!inp) return { ok: false, reason: 'file input not found' };

            var propsKey = Object.keys(inp).find(function(k) { return k.startsWith('__reactProps$'); });
            if (!propsKey || typeof inp[propsKey].onChange !== 'function') {
                return { ok: false, reason: 'React onChange not found' };
            }

            inp.files = dt.files;
            inp[propsKey].onChange({ target: { files: dt.files } });
            return { ok: true };
        })()`);
        if (fallbackResult && !fallbackResult.ok) return fallbackResult;
    }

    const ready = await waitForFilePreview(page, fileName);
    if (!ready) return { ok: false, reason: 'file preview did not appear' };

    return sendMessage(page, prompt);
}

// Retries on CDP "Promise was collected" errors caused by DeepSeek's SPA router transitions.
export async function withRetry(fn, retries = 2) {
    for (let i = 0; i <= retries; i++) {
        try {
            return await fn();
        } catch (err) {
            const msg = String(err?.message || err);
            if (i < retries && msg.includes('Promise was collected')) {
                await new Promise(r => setTimeout(r, 2000));
                continue;
            }
            throw err;
        }
    }
}

export function parseBoolFlag(value) {
    if (typeof value === 'boolean') return value;
    return String(value ?? '').trim().toLowerCase() === 'true';
}

/**
 * Inject an SSE-aware fetch interceptor that captures the raw stream body
 * of the DeepSeek completion API and stores it in window.__opencli_xhr so
 * page.getInterceptedRequests() can retrieve it afterwards.
 * Must be called before sending the message.
 */
export async function setupResponseCapture(page) {
    console.log('[capture] installing SSE interceptor');
    await page.evaluate(`(() => {
        // Reset capture state each time a new message is sent
        if (!window.__opencli_xhr) window.__opencli_xhr = [];
        else window.__opencli_xhr.length = 0;
        window.__opencli_xhr_done = false;
        window.__opencli_xhr_pending = 0;

        // Guard: only patch fetch/XHR once per page lifetime
        if (window.__opencli_xhr_sse_patched) {
            console.log('[capture] fetch already patched, reset state only');
            return;
        }
        window.__opencli_xhr_sse_patched = true;
        console.log('[capture] fetch + XHR patched');

        const TARGET = '/api/v0/chat/completion';

        function __captureFinished() {
            window.__opencli_xhr_pending = Math.max(0, (window.__opencli_xhr_pending || 1) - 1);
            if (window.__opencli_xhr_pending === 0) {
                window.__opencli_xhr_done = true;
                console.log('[capture] all pending requests done, total captured:', window.__opencli_xhr.length);
            }
        }

        // ── Patch fetch ──
        const _origFetch = window.fetch;
        window.fetch = async function(...args) {
            const response = await _origFetch.apply(this, args);
            const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
            if (url.includes(TARGET)) {
                console.log('[capture] fetch intercepted completion request:', url);
                window.__opencli_xhr_pending = (window.__opencli_xhr_pending || 0) + 1;
                window.__opencli_xhr_done = false;
                const cloned = response.clone();
                (async () => {
                    try {
                        const reader = cloned.body.getReader();
                        const decoder = new TextDecoder();
                        let raw = '';
                        let chunks = 0;
                        for (;;) {
                            const { done, value } = await reader.read();
                            if (done) break;
                            raw += decoder.decode(value, { stream: true });
                            chunks++;
                        }
                        // Flush any bytes remaining in the decoder buffer
                        raw += decoder.decode();
                        console.log('[capture] fetch stream finished, chunks:', chunks, 'bytes:', raw.length);
                        window.__opencli_xhr.push(raw);
                    } catch (e) {
                        console.log('[capture] fetch stream error:', String(e));
                    } finally {
                        __captureFinished();
                    }
                })();
            }
            return response;
        };

        // ── Patch XMLHttpRequest ──
        const _origOpen = XMLHttpRequest.prototype.open;
        const _origSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function(method, url) {
            this.__captureUrl = String(url || '');
            return _origOpen.apply(this, arguments);
        };
        XMLHttpRequest.prototype.send = function() {
            if (this.__captureUrl && this.__captureUrl.includes(TARGET)) {
                console.log('[capture] XHR intercepted completion request:', this.__captureUrl);
                window.__opencli_xhr_pending = (window.__opencli_xhr_pending || 0) + 1;
                window.__opencli_xhr_done = false;
                this.addEventListener('load', function() {
                    try {
                        const raw = this.responseText || '';
                        console.log('[capture] XHR response received, bytes:', raw.length);
                        window.__opencli_xhr.push(raw);
                    } finally {
                        __captureFinished();
                    }
                });
                this.addEventListener('error', function() {
                    console.log('[capture] XHR request error');
                    __captureFinished();
                });
            }
            return _origSend.apply(this, arguments);
        };
    })()`);
}

/**
 * Poll until the intercepted SSE stream is finished or the timeout elapses,
 * then drain and return the raw SSE text via page.getInterceptedRequests().
 */
export async function waitForCapturedResponse(page, timeoutMs) {
    const startTime = Date.now();
    console.log('[capture] waiting for SSE stream to finish (timeout:', timeoutMs, 'ms)');
    while (Date.now() - startTime < timeoutMs) {
        await page.wait(2);
        const elapsed = Date.now() - startTime;
        const state = await page.evaluate(
            '({ active: window.__opencli_xhr_sse_patched || false, done: window.__opencli_xhr_done || false, pending: window.__opencli_xhr_pending || 0 })'
        );
        console.log(`[capture] poll at ${elapsed}ms — active:${state?.active} done:${state?.done} pending:${state?.pending}`);
        if (state?.done) {
            const items = await page.getInterceptedRequests();
            console.log('[capture] stream done, captured items:', items.length);
            if (items.length === 0) return null;
            // Merge all captured SSE chunks (handles auto_continue multi-request)
            return items.length === 1 ? items[0] : items.join('\n');
        }
        // Fetch hook never fired after 15 s — give up
        if (!state?.active && elapsed > 15000) {
            console.log('[capture] fetch hook never fired, giving up');
            return null;
        }
    }
    console.log('[capture] timed out waiting for stream');
    return null;
}

/**
 * Parse a DeepSeek SSE body and return the accumulated RESPONSE fragment content.
 * Only collects text from fragments of type RESPONSE (skips SEARCH, THINKING, etc.).
 */
export function parseSSEContent(sseText) {
    if (!sseText) return null;
    console.log('[parse] parsing SSE body, length:', sseText.length);
    let content = '';
    let tracking = false;

    for (const line of sseText.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const jsonStr = line.slice(6).trim();
        if (!jsonStr) continue;
        let data;
        try { data = JSON.parse(jsonStr); } catch { continue; }

        // ── Initial full response frame: {"v":{"response":{"fragments":[...]}}}
        // This is the first substantive frame; extract initial content from RESPONSE fragments.
        if (data.p === undefined && data.o === undefined && data.v?.response?.fragments) {
            for (const frag of data.v.response.fragments) {
                if (frag.type === 'RESPONSE' && frag.content) {
                    content += frag.content;
                    tracking = true;
                }
            }
        // ── BATCH op: appending new fragments (e.g. after SEARCH finishes)
        } else if (data.p === 'response' && data.o === 'BATCH' && Array.isArray(data.v)) {
            for (const op of data.v) {
                if (op.p === 'fragments' && op.o === 'APPEND' && Array.isArray(op.v)) {
                    for (const frag of op.v) {
                        if (frag.type === 'RESPONSE') {
                            content += frag.content || '';
                            tracking = true;
                        }
                    }
                }
            }
        // ── Path-based APPEND to the last fragment's content field
        } else if (data.p === 'response/fragments/-1/content' && data.o === 'APPEND') {
            content += data.v || '';
            tracking = true;
        // ── Short-form token delta {"v":"..."} emitted while tracking a RESPONSE fragment
        } else if (tracking && typeof data.v === 'string' && data.p === undefined && data.o === undefined) {
            content += data.v;
        }
    }

    const result = content.trim() || null;
    console.log('[parse] extracted content length:', result?.length ?? 0);
    return result;
}
