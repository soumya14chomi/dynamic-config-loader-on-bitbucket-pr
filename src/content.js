// =====================================
// Config Key Finder - Bitbucket PR page
// =====================================
    console.log("[Config Key Finder] Content script loaded.");
// --------------------
// Regex & Selectors
// --------------------
const CODE_LINE_SELECTORS = [
    'td.diff-line',
    'td[data-line-type]', // Bitbucket uses data-line-type="ADDED"/"REMOVED"/"CONTEXT"
    '.udiff-line',
    '.diff-line'
].join(', ');

/**
 * Matches @Value("${key}") and @Value("${key:default}") with single or double quotes.
 * Captures "key" in group 1.
 */
const VALUE_LITERAL_REGEX =
    /@Value\s*\(\s*["']\$\{([^}:]+)(?::[^\}]*)?\}\s*["']\s*\)/;

/** Detect constants in Java diffs, e.g.:
 * private static final String TERMINAL_PROPERTIES_MAP_NAME = "hazelcast.terminal.properties.map.name";
 */
const CONST_ASSIGN_REGEX =
    /\b(?:(?:public|protected|private)\s+)?(?:static\s+)?(?:final\s+)?(?:String|char|int|long|double|float|var)\s+([A-Z0-9_]+)\s*=\s*["'][^"']+["']/;

// --------------------
// Utility helpers
// --------------------
function waitForSelector(selector, { timeout = 15000, root = document } = {}) {
    return new Promise((resolve, reject) => {
        const existing = root.querySelector(selector);
        if (existing) return resolve(existing);
        const mo = new MutationObserver(() => {
            const el = root.querySelector(selector);
            if (el) {
                mo.disconnect();
                resolve(el);
            }
        });
        mo.observe(root, { childList: true, subtree: true });
        setTimeout(() => {
            mo.disconnect();
            reject(new Error(`[Config Key Finder] Timeout waiting for selector: ${selector}`));
        }, timeout);
    });
}

const SCAN_COOLDOWN_MS = 2000;
let isScanning = false;
let lastScanTs = 0;
let globalObserver = null;
let lastSignature = '';

function debounce(fn, ms = 500) {
    let t;
    return (...args) => {
        clearTimeout(t);
        t = setTimeout(() => fn(...args), ms);
    };
}

function computeSignature() {
    const fileHrefs = [...document.querySelectorAll('ol.files li.file a, ul.files li.file a')]
        .map(a => a.getAttribute('href') || '')
        .join('\n');
    const lineCount = document.querySelectorAll('td.diff-line, td[data-line-type], .udiff-line, .diff-line').length;
    return `${fileHrefs}:${lineCount}`;
}

function isOurNode(node) {
    return node && node.nodeType === 1 && (node.hasAttribute('data-ckf') || node.closest('[data-ckf]'));
}

function isExtensionAlive() {
    return !!(window.chrome && chrome.runtime && chrome.runtime.id);
}

async function getSettingsSafe(
    defaults = { maskSecrets: true, missingBehavior: 'show', enableExtension: true, highlightMode: 'source-token' }
) {
    try {
        if (!isExtensionAlive()) {
            console.warn('[Config Key Finder] Extension context invalid - using default settings.');
            return { ...defaults };
        }
        return await new Promise((resolve) => {
            chrome.storage?.sync?.get(defaults, (result) => {
                const err = chrome.runtime?.lastError;
                if (err) {
                    console.warn('[Config Key Finder] storage.get failed:', err.message);
                    resolve({ ...defaults });
                } else {
                    resolve(result || { ...defaults });
                }
            });
        });
    } catch (e) {
        console.warn('[Config Key Finder] storage.get threw; using defaults:', e);
        return { ...defaults };
    }
}

// --------------------
// Line type detection (robust)
// --------------------
function getLineTypeForNode(node) {
    const holder = node.closest('td[data-line-type], tr[data-line-type]');
    let t = holder?.getAttribute('data-line-type');
    if (t) return t.toUpperCase();

    // Fallback heuristics if data-line-type is absent
    const cell = node.closest('td, tr, li, div') || node;
    const txt = (cell.textContent || '').trim();
    if (/^-\s/.test(txt)) return 'REMOVED';
    if (/^\+\s/.test(txt)) return 'ADDED';

    const cls = (cell.className || '');
    if (/removed|delete/i.test(cls)) return 'REMOVED';
    if (/added|insert/i.test(cls)) return 'ADDED';

    return 'CONTEXT';
}

// --------------------
// Key normalization & parsing helpers
// --------------------
function sanitizeKey(k) {
    if (typeof k !== 'string') return k;
    let s = k.replace(/^\uFEFF/, '') // BOM
        .replace(/[\u200B\u200C\u200D]/g, '') // zero-width
        .replace(/\u00A0/g, ' ')
        .trim();
    s = s.replace(/^['"]/, '').replace(/['"]$/, '');
    s = s.replace(/\.{2,}/g, '.');
    s = s.replace(/\s*\.\s*/g, '.');
    return s;
}

function collapseJavaStringConcat(s) {
    let out = s.replace(/"([^"\\]*(?:\\.[^"\\]*)*)"/g, (m, inner) => `__STR(${inner})__`)
        .replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, (m, inner) => `__STR(${inner})__`);
    let prev;
    do {
        prev = out;
        out = out.replace(/__STR\(([^)]*)\)__\s*\+\s*__STR\(([^)]*)\)__/g, (m, a, b) => `__STR(${a}${b})__`);
    } while (out !== prev);
    out = out.replace(/__STR\(([^)]*)\)__/g, (m, inner) => `"${inner}"`);
    return out;
}

// Normalize @"${" + ... + "}" -> @"${...}"
function normalizeValueConcat(s) {
    return s.replace(/"\$\{\s*"\s*\+\s*([^\}]+?)\s*\+\s*"\s*\}"/g, (m, inner) => {
        let cleaned = inner.replace(/"\s*\+\s*|\s*\+\s*"/g, '')
            .replace(/\s*\+\s*/g, '')
            .replace(/"/g, '')
            .trim();
        return `"${'${' + cleaned + '}'}"`;
    });
}

function normalizeKey(name) {
    const kebab = name.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
    const snake = kebab.replace(/-/g, '_');
    return [kebab, name, snake];
}

function parseProperties(text) {
    text = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
    const lines = [];
    let buf = '';
    for (const raw of text.split('\n')) {
        const line = raw.replace(/\s+$/, '');
        const endsWithEscapedBackslash = /\\$/.test(line) && !/\\\\$/.test(line);
        buf += (buf ? '\n' : '') + line.replace(/\\$/, '');
        if (!endsWithEscapedBackslash) {
            lines.push(buf);
            buf = '';
        }
    }
    if (buf) lines.push(buf);
    const map = {};
    for (let line of lines) {
        line = line.trim();
        if (!line || line.startsWith('#') || line.startsWith('!')) continue;
        const sepMatch = line.match(/[:=]/);
        if (!sepMatch) continue;
        const idx = sepMatch.index;
        let key = line.slice(0, idx).trim();
        let value = line.slice(idx + 1).trim();
        value = value.replace(/\s+#.*/, '');
        key = key.replace(/\\:/g, ':').replace(/\\=/g, '=').replace(/\\ /g, ' ');
        value = value.replace(/\\:/g, ':').replace(/\\=/g, '=').replace(/\\ /g, ' ');
        key = sanitizeKey(key);
        map[key] = value;
    }
    return map;
}

function buildSymbolTableFromDiff() {
    const symbolTable = {};
    const codeCells = document.querySelectorAll('td[data-line-type], td.diff-line, .udiff-line, .diff-line');
    codeCells.forEach(cell => {
        if (isOurNode(cell)) return;
        const tokens = [...cell.querySelectorAll('.hl-variable, .hl-operator, .hl-string, .hl-type, .hl-keyword')];
        if (tokens.length === 0) {
            let raw = (cell.textContent || '').trim().replace(/^([+\-])\s?/, '');
            let m = raw.match(CONST_ASSIGN_REGEX);
            if (!m) {
                const collapsed = collapseJavaStringConcat(raw);
                m = collapsed.match(CONST_ASSIGN_REGEX);
            }
            if (m) {
                const [, name, value] = m;
                const constName = sanitizeKey(name);
                const constValue = sanitizeKey(value);
                symbolTable[constName] = constValue;
                console.log(`[Config Key Finder] Constant detected (fallback): ${constName} = ${constValue}`);
            }
            return;
        }
        let lastVariable = null;
        for (let i = 0; i < tokens.length; i++) {
            const t = tokens[i];
            const cls = t.classList;
            if (cls.contains('hl-variable')) {
                lastVariable = (t.textContent || '').trim();
                continue;
            }
            if (cls.contains('hl-operator') && (t.textContent || '').trim() === '=') {
                if (!lastVariable) continue;
                let valueToken = null;
                for (let j = i + 1; j < tokens.length; j++) {
                    const tj = tokens[j];
                    if (tj.classList.contains('hl-string')) { valueToken = tj; break; }
                    if (tj.classList.contains('hl-operator') && (tj.textContent || '').includes(';')) break;
                }
                if (valueToken) {
                    let rawVal = (valueToken.textContent || '').trim();
                    rawVal = rawVal.replace(/^['"]/, '').replace(/['"]$/, '');
                    const constName = sanitizeKey(lastVariable);
                    const constValue = sanitizeKey(rawVal);
                    if (/^[A-Z0-9_]+$/.test(constName)) {
                        symbolTable[constName] = constValue;
                        console.log(`[Config Key Finder] Constant detected (tokens): ${constName} = ${constValue}`);
                    }
                }
                lastVariable = null;
            }
        }
    });
    const genericCells = document.querySelectorAll('pre, code');
    genericCells.forEach(cell => {
        let raw = (cell.textContent || '').trim().replace(/^([+\-])\s?/, '');
        let m = raw.match(CONST_ASSIGN_REGEX);
        if (!m) {
            const collapsed = collapseJavaStringConcat(raw);
            m = collapsed.match(CONST_ASSIGN_REGEX);
        }
        if (m) {
            const [, name, value] = m;
            const constName = sanitizeKey(name);
            const constValue = sanitizeKey(value);
            if (!symbolTable[constName]) {
                symbolTable[constName] = constValue;
                console.log(`[Config Key Finder] Constant detected (final sweep): ${constName} = ${constValue}`);
            }
        }
    });
    console.log(`[CKF] Constants collected: ${Object.keys(symbolTable).length}`);
    return symbolTable;
}

// --------------------
// Detection (captures line side)
// --------------------
// A) @Value(...) detection — capture sourceToken (constant) if present
//    and SKIP REMOVED lines before creating items or logging them
function detectValueAnnotationsOnly(symbolTable = {}) {
    const nodes = document.querySelectorAll(CODE_LINE_SELECTORS);
    const results = [];
    nodes.forEach(node => {
        let raw = (node.textContent || '').trim();
        if (!raw || !raw.includes('@Value')) return;

        const lineType = getLineTypeForNode(node);
        if (lineType === 'REMOVED') return; // do not detect/log removed lines

        // Strip unified diff markers
        raw = raw.replace(/^([+\-])\s?/, '');

        // Try to detect a likely source constant token present in the raw line (ALL_CAPS)
        let sourceToken = null;
        {
            const candidates = Array.from(raw.matchAll(/\b[A-Z0-9_]+\b/g)).map(m => m[0]);
            const preferred = candidates.find(name => symbolTable[name] !== undefined);
            sourceToken = preferred || (candidates.length ? candidates[0] : null);
        }

        // Substitute constants
        let normalized = raw.replace(/\b([A-Z0-9_]+)\b/g, (name) =>
            symbolTable[name] !== undefined ? symbolTable[name] : name
        );
        normalized = collapseJavaStringConcat(normalized);
        normalized = normalizeValueConcat(normalized);

        const m = normalized.match(VALUE_LITERAL_REGEX);
        if (!m) return;

        const key = sanitizeKey(m[1]); // resolved key
        const lineContainer = node.closest('tr') || node;

        results.push({ type: 'value', key, sourceToken, element: lineContainer, lineType });
        console.log(`[Config Key Finder] @Value found (${lineType}): ${key} [sourceToken=${sourceToken || 'n/a'}]`);
    });
    console.log(`[Config Key Finder] @Value detection -> ${results.length} items.`);
    return results;
}

// B) Constant assignment detection: extract RHS string literal as a property key
//    and SKIP REMOVED lines
function detectConstantPropertyKeys(symbolTable = {}) {
    const nodes = document.querySelectorAll(CODE_LINE_SELECTORS);
    const results = [];
    nodes.forEach(node => {
        const lineType = getLineTypeForNode(node);
        if (lineType === 'REMOVED') return; // do not detect removed lines

        let raw = (node.textContent || '').trim();
        if (!raw) return;
        raw = raw.replace(/^([+\-])\s?/, '');
        let m = raw.match(CONST_ASSIGN_REGEX);
        if (!m) {
            const collapsed = collapseJavaStringConcat(raw);
            m = collapsed.match(CONST_ASSIGN_REGEX);
        }
        if (!m) return;
        const literal = sanitizeKey(m[2]); // RHS string literal
        if (!( /\./.test(literal) && /[a-z]/i.test(literal) )) return;
        const lineContainer = node.closest('tr') || node;
        results.push({ type: 'const_value', key: literal, element: lineContainer, lineType });
        console.log(`[Config Key Finder] Constant RHS key (${lineType}): ${literal}`);
    });
    console.log(`[Config Key Finder] Constant key detection -> ${results.length} items.`);
    return results;
}

function detectAnnotations(symbolTable = {}) {
    const a = detectValueAnnotationsOnly(symbolTable);
    const b = detectConstantPropertyKeys(symbolTable);
    const combined = [...a, ...b];
    const seen = new WeakMap();
    const unique = [];
    for (const item of combined) {
        const key = sanitizeKey(item.key);
        const bucket = seen.get(item.element) || new Set();
        if (!bucket.has(key)) {
            bucket.add(key);
            seen.set(item.element, bucket);
            unique.push({ ...item, key });
        }
    }
    console.log(`[Config Key Finder] detectAnnotations -> ${unique.length} items.`);
    return unique;
}

// --------------------
// PR header & dual raw URLs from anchors
// --------------------
function getPRSidesFromHeader() {
    const container = document.querySelector('.pull-request-metadata .branch-from-to')
        || document.querySelector('.branch-from-to');
    if (!container) {
        console.warn('[CKF] PR header (.branch-from-to) not found.');
        return null;
    }
    const lozenges = [...container.querySelectorAll('.ref-lozenge')];
    if (lozenges.length < 2) {
        console.warn('[CKF] Expected 2 ref-lozenge elements, found:', lozenges.length);
        return null;
    }
    function readSide(lozenge) {
        const projectKey = lozenge.getAttribute('data-project-key') || null;
        const repoSlug = lozenge.getAttribute('data-repo-slug') || null;
        const branchText =
            lozenge.querySelector('.ref-lozenge-content > span')?.textContent?.trim()
            || lozenge.querySelector('.ref-lozenge-content')?.textContent?.trim()
            || null;
        const ref = branchText ? `refs/heads/${branchText}` : null;
        return { projectKey, repoSlug, branch: branchText, ref };
    }
    const from = readSide(lozenges[0]); // first lozenge = FROM (source)
    const to = readSide(lozenges[1]);   // second lozenge = TO (destination)
    console.debug('[CKF] PR sides:', { from, to });
    return { from, to };
}

function buildRawUrl(origin, projectKey, repoSlug, filePath, ref /* may be null */) {
    let url = `${origin}/projects/${projectKey}/repos/${repoSlug}/raw/${filePath}`;
    if (ref) url += `?at=${encodeURIComponent(ref)}`;
    return url;
}

function findConfigFilesInPRDualUsingAnchors() {
    const origin = location.origin;
    const parts = location.pathname.split('/').filter(Boolean);
    const projIdx = parts.indexOf('projects');
    const reposIdx = parts.indexOf('repos');
    if (projIdx === -1 || reposIdx === -1) {
        console.warn('[CKF] Cannot parse project/repo from pathname:', location.pathname);
    }
    const pageProjectKey = projIdx !== -1 ? parts[projIdx + 1] : null;
    const pageRepoSlug = reposIdx !== -1 ? parts[reposIdx + 1] : null;
    const sides = getPRSidesFromHeader();
    const files = [];
    const anchors = document.querySelectorAll('ol.files li.file a, ul.files li.file a');
    console.log(`[CKF] File anchors: ${anchors.length}`);
    anchors.forEach(a => {
        const rawHref = a.getAttribute('href') || '';
        if (!rawHref.startsWith('#')) return;
        const encodedPath = rawHref.slice(1);
        const filePath = decodeURIComponent(encodedPath);
        const fileName =
            (a.getAttribute('aria-label') || a.getAttribute('title') || '')
                .split(/\s+has\s+been\s+modified/i)[0]
                .trim()
            || filePath.split('/').pop();
        if (!/^application.*\.(properties|yml|yaml)$/i.test(fileName)) return;
        const fromProj = sides?.from?.projectKey || pageProjectKey;
        const fromRepo = sides?.from?.repoSlug || pageRepoSlug;
        const toProj = sides?.to?.projectKey || pageProjectKey;
        const toRepo = sides?.to?.repoSlug || pageRepoSlug;
        const fromUrl = (fromProj && fromRepo) ? buildRawUrl(origin, fromProj, fromRepo, filePath, sides?.from?.ref) : null;
        const toUrl = (toProj && toRepo) ? buildRawUrl(origin, toProj, toRepo, filePath, sides?.to?.ref) : null;
        const defaultUrl = (pageProjectKey && pageRepoSlug) ? buildRawUrl(origin, pageProjectKey, pageRepoSlug, filePath, null) : null;
        files.push({ name: fileName, filePath, fromUrl, toUrl, defaultUrl });
        console.log('[CKF] Config file (dual):', { name: fileName, fromUrl, toUrl, defaultUrl });
    });
    return files;
}

// --------------------
// Dual fetch: ORIGINAL mapping preserved
// FROM side -> currentConfigs
// TO/default side -> removedConfigs
// --------------------

async function fetchConfigsDual(files) {
    const removedConfigs = {};
    const currentConfigs = {};
    async function fetchText(url) {
        if (!url) return null;
        try {
            const res = await fetch(url, { credentials: 'include' });
            if (!res.ok) return null;
            const txt = await res.text();
            return txt && txt.length ? txt : null;
        } catch (e) {
            return null;
        }
    }
    for (const file of files) {
        // FROM side -> currentConfigs
        const fromText = await fetchText(file.fromUrl);
        if (fromText && file.name.endsWith('.properties')) {
            Object.assign(currentConfigs, parseProperties(fromText));
        }

        // TO/default side -> removedConfigs
        let toText = await fetchText(file.toUrl);
        if (!toText) toText = await fetchText(file.defaultUrl);
        if (toText && file.name.endsWith('.properties')) {
            Object.assign(removedConfigs, parseProperties(toText));
        }
    }
    console.log('[CKF] removedConfigs size:', Object.keys(removedConfigs).length);
    console.log('[CKF] currentConfigs size:', Object.keys(currentConfigs).length);
    return { removedConfigs, currentConfigs };
}


// --------------------
// Inject badges per side
// --------------------
(function ensureCKFStyles() {
    if (document.getElementById('ckf-style')) return;
    const style = document.createElement('style');
    style.id = 'ckf-style';
    style.textContent = `
 .ckf-highlight{background:rgba(255,235,59,.35);border-radius:3px;padding:0 3px;cursor:help}
 .ckf-tooltip{position:absolute;z-index:9999;max-width:520px;background:#1f2937;color:#fff;border-radius:6px;padding:8px 10px;font-size:12px;line-height:1.4;box-shadow:0 8px 24px rgba(0,0,0,.3);pointer-events:none;opacity:0;transform:translateY(4px);transition:opacity 120ms ease,transform 120ms ease}
 .ckf-tooltip.show{opacity:1;transform:translateY(0)}
 .ckf-tooltip .ckf-title{font-weight:600;margin-bottom:4px}
 .ckf-tooltip .ckf-row{display:flex;gap:8px;align-items:baseline}
 .ckf-tooltip .ckf-label{color:#93c5fd;min-width:56px}
 `;
    document.head.appendChild(style);
})();

function injectHighlightsWithHover(configs, removedConfigs_toBranch, currentConfigs_fromBranch, settings) {
    const normRemoved = {};
    for (const [k, v] of Object.entries(removedConfigs_toBranch)) normRemoved[sanitizeKey(k)] = v;
    const normCurrent = {};
    for (const [k, v] of Object.entries(currentConfigs_fromBranch)) normCurrent[sanitizeKey(k)] = v;

    let tooltip = document.getElementById('ckf-tooltip');
    if (!tooltip) {
        tooltip = document.createElement('div');
        tooltip.id = 'ckf-tooltip';
        tooltip.className = 'ckf-tooltip';
        tooltip.setAttribute('data-ckf', 'tooltip');
        document.body.appendChild(tooltip);
    }
    const showTooltip = (el, content) => {
        tooltip.innerHTML = content;
        tooltip.classList.add('show');
        const rect = el.getBoundingClientRect();
        const top = window.scrollY + rect.top - tooltip.offsetHeight - 6;
        const left = window.scrollX + rect.left;
        tooltip.style.top = `${Math.max(8, top)}px`;
        tooltip.style.left = `${left}px`;
    };
    const hideTooltip = () => tooltip.classList.remove('show');

    configs.forEach(cfg => {
        // Guard: never highlight removed lines (should already be filtered)
        if (cfg.lineType === 'REMOVED') return;

        const container = cfg.element || document.body;
        const key = sanitizeKey(cfg.key);

        // Choose visual text: source-token (constant) when available and requested, else resolved key
        const preferSource = settings.highlightMode === 'source-token';
        const displayText = preferSource && cfg.sourceToken ? sanitizeKey(cfg.sourceToken) : key;

        const safeDisplay = (window.CSS && CSS.escape) ? CSS.escape(displayText) : displayText.replace(/"/g, '\\"');
        if (container.querySelector(`.ckf-highlight[data-key="${safeDisplay}"]`)) return;

        // Find the deepest text node containing the chosen display text
        let targetTextNode = null;
        const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
            acceptNode: (node) => {
                if (!node.nodeValue) return NodeFilter.FILTER_SKIP;
                const txt = node.nodeValue;
                return txt.includes(displayText) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
            }
        });
        targetTextNode = walker.nextNode();

        // Fallback: look for ${...} token
        if (!targetTextNode) {
            const walker2 = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
                acceptNode: (node) => {
                    const txt = node.nodeValue || '';
                    return (txt.includes('${') && txt.includes('}')) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
                }
            });
            targetTextNode = walker2.nextNode();
        }

        if (!targetTextNode) {
            // As an extra safety, do not append row-level highlights if line type might be removed
            const ltFallback = getLineTypeForNode(container);
            if (ltFallback === 'REMOVED') return;

            const hi = document.createElement('span');
            hi.className = 'ckf-highlight';
            hi.setAttribute('data-ckf', 'value-highlight');
            hi.setAttribute('data-key', displayText);
            hi.textContent = displayText;
            container.appendChild(hi);
            attachHover(hi, cfg, key, normRemoved, normCurrent, settings, showTooltip, hideTooltip);
            return;
        }

        const full = targetTextNode.nodeValue;
        const idx = full.indexOf(displayText);
        const before = document.createTextNode(full.slice(0, idx));
        const after = document.createTextNode(full.slice(idx + displayText.length));
        const hi = document.createElement('span');
        hi.className = 'ckf-highlight';
        hi.setAttribute('data-ckf', 'value-highlight');
        hi.setAttribute('data-key', displayText);
        hi.textContent = displayText;
        const parent = targetTextNode.parentNode;
        parent.replaceChild(after, targetTextNode);
        parent.insertBefore(hi, after);
        parent.insertBefore(before, hi);

        attachHover(hi, cfg, key, normRemoved, normCurrent, settings, showTooltip, hideTooltip);
    });

    function attachHover(hi, cfg, key, normRemoved, normCurrent, settings, showTooltip, hideTooltip) {
        const map = (cfg.lineType === 'REMOVED') ? normRemoved : normCurrent;
        let value = map[key];
        const otherMap = (cfg.lineType === 'REMOVED') ? normCurrent : normRemoved;
        const otherValue = otherMap[key];

        if (settings.maskSecrets && /password|secret|token|apikey|api_key/i.test(key)) {
            value = (value !== undefined) ? '••••••' : value;
        }

        hi.addEventListener('mouseenter', () => {
            const title = (cfg.sourceToken && sanitizeKey(cfg.sourceToken) !== key)
                ? `@Value: ${sanitizeKey(cfg.sourceToken)} → ${key}`
                : `@Value key: ${key}`;

            const primarySide = (cfg.lineType === 'REMOVED') ? 'toBranch (removed)' : 'fromBranch (added)';
            const primaryVal = (value !== undefined) ? String(value) : 'Not set';

            let html = `
        <div class="ckf-title">${escapeHtml(title)}</div>
        <div class="ckf-row"><span class="ckf-label">${primarySide}:</span><span>${escapeHtml(primaryVal)}</span></div>
      `;
            if (otherValue !== undefined && String(otherValue) !== String(value)) {
                html += `<div class="ckf-row"><span class="ckf-label">other side:</span><span>${escapeHtml(String(otherValue))}</span></div>`;
            }
            showTooltip(hi, html);
        });
        hi.addEventListener('mouseleave', hideTooltip);
        hi.addEventListener('click', hideTooltip);
    }

    function escapeHtml(s) {
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }
}

// --------------------
// Observer (debounced)
// --------------------
const debouncedRunScan = debounce(() => runScan('mutation'), 800);
function installObservers() {
    if (globalObserver) {
        globalObserver.disconnect();
    }
    globalObserver = new MutationObserver((mutations) => {
        let relevant = false;
        for (const m of mutations) {
            if (isOurNode(m.target)) continue;
            if ([...m.addedNodes].some(n => isOurNode(n))) continue;
            const addedRelevant = [...m.addedNodes].some(n => {
                if (n.nodeType !== 1) return false;
                return (
                    n.matches?.('ol.files, ul.files, li.file, .diff-view, .js-diff-progressive') ||
                    n.querySelector?.('ol.files, ul.files, li.file, .diff-view, .js-diff-progressive, ' + CODE_LINE_SELECTORS)
                );
            });
            if (addedRelevant) { relevant = true; break; }
            if (m.type === 'attributes' && m.attributeName === 'aria-selected') { relevant = true; break; }
        }
        if (relevant) {
            console.debug('[Config Key Finder] mutation -> schedule scan');
            debouncedRunScan();
        }
    });
    try {
        globalObserver.observe(document.body, { childList: true, subtree: true });
        console.log("[Config Key Finder] MutationObserver installed.");
    } catch (e) {
        console.warn('[Config Key Finder] Failed to install observer, will retry:', e);
        setTimeout(() => {
            try {
                globalObserver.observe(document.body, { childList: true, subtree: true });
                console.log("[Config Key Finder] MutationObserver installed (retry).");
            } catch (e2) {
                console.error('[Config Key Finder] Observer install failed (retry):', e2);
            }
        }, 1000);
    }
}


// ==============================
// New: @ConfigurationProperties detection
// ==============================
const CONFIG_PROPS_PREFIX_REGEXES = [
    // @ConfigurationProperties(prefix = "my.prefix")
    /@ConfigurationProperties\s*\(\s*[^)]*?\bprefix\s*=\s*["']\s*([^"']+?)\s*["'][^)]*\)/,
    // @ConfigurationProperties("my.prefix") – direct value form
    /@ConfigurationProperties\s*\(\s*["']\s*([^"']+?)\s*["']\s*\)/,
];

const CONFIG_PROPS_PREFIX_CONST_REGEXES = [
    // @ConfigurationProperties(prefix = SOME_CONSTANT)
    /@ConfigurationProperties\s*\(\s*[^)]*?\bprefix\s*=\s*([A-Z0-9_]+)[^)]*\)/,
    // @ConfigurationProperties(SOME_CONSTANT)
    /@ConfigurationProperties\s*\(\s*([A-Z0-9_]+)\s*\)/,
];

/**
 * Detects @ConfigurationProperties(...) prefix (string, constant, or concat),
 * skips REMOVED lines, and returns items with {type:'configprops', key:prefix, sourceToken?, element, lineType}
 */
function detectConfigurationPropertiesAnnotations(symbolTable = {}) {
    const nodes = document.querySelectorAll(CODE_LINE_SELECTORS);
    const results = [];

    nodes.forEach(node => {
        let raw = (node.textContent || '').trim();
        if (!raw || !raw.includes('@ConfigurationProperties')) return;

        const lineType = getLineTypeForNode(node);
        if (lineType === 'REMOVED') return; // never render removed

        // Strip +/- diff markers
        raw = raw.replace(/^([+\-])\s?/, '');

        // First pass: substitute constants and collapse string concatenations
        let normalized = raw.replace(/\b([A-Z0-9_]+)\b/g, (name) =>
            symbolTable[name] !== undefined ? symbolTable[name] : name
        );
        normalized = collapseJavaStringConcat(normalized);

        // Try string prefix forms
        let prefix = null;
        for (const rx of CONFIG_PROPS_PREFIX_REGEXES) {
            const m = normalized.match(rx);
            if (m && m[1]) {
                prefix = sanitizeKey(m[1]);
                break;
            }
        }

        // If still not found, try constant-only forms (before substitution)
        let sourceToken = null;
        if (!prefix) {
            for (const rx of CONFIG_PROPS_PREFIX_CONST_REGEXES) {
                const m2 = raw.match(rx);
                if (m2 && m2[1]) {
                    sourceToken = sanitizeKey(m2[1]);
                    // Best-effort resolve via symbol table
                    const resolved = symbolTable[sourceToken];
                    if (typeof resolved === 'string' && resolved) {
                        prefix = sanitizeKey(resolved);
                    }
                    break;
                }
            }
        }

        // As a last attempt, handle concatenated string inside the parentheses: prefix = "a" + "." + "b"
        if (!prefix) {
            const concatMatch = raw.match(/@ConfigurationProperties\s*\(\s*[^)]*?\bprefix\s*=\s*(.+?)\)/);
            if (concatMatch) {
                const collapsed = collapseJavaStringConcat(concatMatch[1]);
                const strMatch = collapsed.match(/"'["']/);
                if (strMatch && strMatch[1]) {
                    prefix = sanitizeKey(strMatch[1]);
                }
            }
        }

        if (!prefix) return;

        const lineContainer = node.closest('tr') || node;

        results.push({
            type: 'configprops',
            key: prefix,
            sourceToken,
            element: lineContainer,
            lineType,
        });
        console.log(`[Config Key Finder] @ConfigurationProperties found (${lineType}): prefix=${prefix} [sourceToken=${sourceToken || 'n/a'}]`);
    });

    console.log(`[Config Key Finder] @ConfigurationProperties detection -> ${results.length} items.`);
    return results;
}


// ==============================
// New: Injector for @ConfigurationProperties prefixes
// ==============================
function injectConfigPropsHighlights(configPropsItems, removedConfigs_toBranch, currentConfigs_fromBranch, settings) {
    const normRemoved = {};
    for (const [k, v] of Object.entries(removedConfigs_toBranch)) normRemoved[sanitizeKey(k)] = v;
    const normCurrent = {};
    for (const [k, v] of Object.entries(currentConfigs_fromBranch)) normCurrent[sanitizeKey(k)] = v;

    // Reuse single tooltip element if present; else create
    let tooltip = document.getElementById('ckf-tooltip');
    if (!tooltip) {
        tooltip = document.createElement('div');
        tooltip.id = 'ckf-tooltip';
        tooltip.className = 'ckf-tooltip';
        tooltip.setAttribute('data-ckf', 'tooltip');
        document.body.appendChild(tooltip);
    }

    const showTooltip = (el, content) => {
        tooltip.innerHTML = content;
        tooltip.classList.add('show');
        const rect = el.getBoundingClientRect();
        const top = window.scrollY + rect.top - tooltip.offsetHeight - 6;
        const left = window.scrollX + rect.left;
        tooltip.style.top = `${Math.max(8, top)}px`;
        tooltip.style.left = `${left}px`;
    };
    const hideTooltip = () => tooltip.classList.remove('show');

    const maskIfSecret = (key, val) => {
        if (settings.maskSecrets && /\b(pass(word)?|secret|token|api[_-]?key|key|credential|auth|jwt)\b/i.test(key)) {
            return (val !== undefined) ? '••••••' : val;
        }
        return val;
    };

    function escapeHtmlProps(s) {
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    configPropsItems.forEach(cfg => {
        // Guard: render only non-removed lines (should already be filtered)
        if (cfg.lineType === 'REMOVED') return;

        const container = cfg.element || document.body;
        const prefix = sanitizeKey(cfg.key);

        // Badge display text: prefer constant token if available and highlightMode = 'source-token'
        const preferSource = settings.highlightMode === 'source-token';
        const displayText = preferSource && cfg.sourceToken ? sanitizeKey(cfg.sourceToken) : prefix;

        const safeDisplay = (window.CSS && CSS.escape) ? CSS.escape(displayText) : displayText.replace(/"/g, '\\"');
        if (container.querySelector(`.ckf-highlight[data-key="${safeDisplay}"]`)) return;

        // Try to insert near the text occurrence of prefix or annotation
        let targetTextNode = null;
        const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
            acceptNode: (node) => {
                const txt = node.nodeValue || '';
                // Try to place the badge next to the "prefix" attribute or the literal prefix
                return (txt.includes('prefix') && txt.includes(displayText)) || txt.includes(displayText)
                    ? NodeFilter.FILTER_ACCEPT
                    : NodeFilter.FILTER_SKIP;
            }
        });
        targetTextNode = walker.nextNode();

        // Fallback: append badge at the end of the container row
        let hi;
        if (!targetTextNode) {
            hi = document.createElement('span');
            hi.className = 'ckf-highlight';
            hi.setAttribute('data-ckf', 'configprops-highlight');
            hi.setAttribute('data-key', displayText);
            hi.textContent = displayText;
            container.appendChild(hi);
        } else {
            const full = targetTextNode.nodeValue;
            const idx = full.indexOf(displayText);
            const before = document.createTextNode(full.slice(0, Math.max(0, idx)));
            const after = document.createTextNode(full.slice(Math.max(0, idx) + displayText.length));
            hi = document.createElement('span');
            hi.className = 'ckf-highlight';
            hi.setAttribute('data-ckf', 'configprops-highlight');
            hi.setAttribute('data-key', displayText);
            hi.textContent = displayText;
            const parent = targetTextNode.parentNode;
            parent.replaceChild(after, targetTextNode);
            parent.insertBefore(hi, after);
            parent.insertBefore(before, hi);
        }

        // Build tooltip: list of keys under prefix from both sides

        hi.addEventListener('mouseenter', () => {
            // Collect matching keys
            const currentKeys = Object.keys(normCurrent).filter(k => k === prefix || k.startsWith(prefix + '.'));
            const removedKeys = Object.keys(normRemoved).filter(k => k === prefix || k.startsWith(prefix + '.'));
            const unionKeys = Array.from(new Set([...currentKeys, ...removedKeys])).sort();

            const title = (cfg.sourceToken && sanitizeKey(cfg.sourceToken) !== prefix)
                ? `@ConfigurationProperties: ${sanitizeKey(cfg.sourceToken)} → ${prefix}`
                : `@ConfigurationProperties prefix: ${prefix}`;

            // Construct rows (limit to avoid overly long tooltips)
            const MAX_ROWS = 20;
            let rowsHtml = '';

            const primaryLabel = 'fromBranch';
            const otherLabel = 'toBranch';

            for (let i = 0; i < unionKeys.length && i < MAX_ROWS; i++) {
                const key = unionKeys[i];
                const curRaw = normCurrent[key];
                const remRaw = normRemoved[key];

                const cur = maskIfSecret(key, curRaw);
                const rem = maskIfSecret(key, remRaw);

                // Show the key itself (config name)
                rowsHtml += `
      <div class="ckf-row"><span class="ckf-label">key:</span><span>${escapeHtmlProps(key)}</span></div>
      <div class="ckf-row"><span class="ckf-label">${escapeHtmlProps(primaryLabel)}:</span><span>${escapeHtmlProps(cur !== undefined ? String(cur) : 'Not set')}</span></div>
    `;

                // Show other side if present and different
                if (rem !== undefined && String(rem) !== String(cur)) {
                    rowsHtml += `
        <div class="ckf-row"><span class="ckf-label">${escapeHtmlProps(otherLabel)}:</span><span>${escapeHtmlProps(String(rem))}</span></div>
      `;
                }

                // Small visual separator between entries
                if (i < unionKeys.length - 1 && i < MAX_ROWS - 1) {
                    rowsHtml += `<div style="height:6px"></div>`;
                }
            }

            if (unionKeys.length === 0) {
                rowsHtml = `
      <div class="ckf-row">
        <span class="ckf-label">keys:</span><span>None found under this prefix</span>
      </div>
    `;
            } else if (unionKeys.length > MAX_ROWS) {
                rowsHtml += `
      <div class="ckf-row">
        <span class="ckf-label">more:</span><span>${escapeHtmlProps(String(unionKeys.length - MAX_ROWS))} additional keys…</span>
      </div>
    `;
            }

            const html = `
    <div class="ckf-title">${escapeHtmlProps(title)}</div>
    ${rowsHtml}
  `;
            showTooltip(hi, html);
        });


        hi.addEventListener('mouseleave', hideTooltip);
        hi.addEventListener('click', hideTooltip);
    });
}

// --------------------
// Main scan
// --------------------

// --------------------
// Main scan (extend minimally)
// --------------------
async function runScan(reason = 'manual') {
    const now = Date.now();
    if (isScanning) {
        console.debug('[Config Key Finder] runScan skipped; already scanning. reason:', reason);
        return;
    }
    if (now - lastScanTs < SCAN_COOLDOWN_MS) {
        console.debug('[Config Key Finder] runScan skipped; cooldown. reason:', reason);
        return;
    }
    if (document.visibilityState === 'hidden') {
        console.debug('[Config Key Finder] runScan skipped; tab hidden. reason:', reason);
        return;
    }
    lastScanTs = now;
    isScanning = true;
    console.log("[Config Key Finder] runScan START. reason:", reason);
    try {
        globalObserver && globalObserver.disconnect();

        const settings = await getSettingsSafe();
        if (!settings.enableExtension) {
            console.log("[Config Key Finder] Extension disabled by user.");
            return;
        }

        try {
            await waitForSelector('ol.files, ul.files', { timeout: 8000 });
            console.log("[Config Key Finder] files list detected.");
        } catch (e) {
            console.warn("[Config Key Finder] files list not found yet; proceeding to scan whatever is present.");
        }

        const sig = computeSignature();
        if (sig === lastSignature) {
            console.debug('[Config Key Finder] signature unchanged; skipping scan. reason:', reason);
            return;
        }
        lastSignature = sig;

        const symbolTable = buildSymbolTableFromDiff();

        const detectedConfigs = detectAnnotations(symbolTable);
        const renderableConfigs = detectedConfigs.filter(c => c.lineType !== 'REMOVED');
        console.log(`[Config Key Finder] renderable (non-removed) -> ${renderableConfigs.length} items.`);

        // New: detect @ConfigurationProperties
        const detectedConfigProps = detectConfigurationPropertiesAnnotations(symbolTable);
        const renderableConfigProps = detectedConfigProps.filter(c => c.lineType !== 'REMOVED');
        console.log(`[Config Key Finder] renderable configprops -> ${renderableConfigProps.length} items.`);

        const filesDual = findConfigFilesInPRDualUsingAnchors() || [];
        console.log(`[Config Key Finder] findConfigFilesInPRDualUsingAnchors -> ${filesDual.length} files.`);

        let removedConfigs = {};
        let currentConfigs = {};
        if (filesDual.length > 0) {
            const both = await fetchConfigsDual(filesDual);
            removedConfigs = both.removedConfigs;
            currentConfigs = both.currentConfigs;
        } else {
            console.log('[Config Key Finder] No config file candidates found.');
        }

        // Existing @Value/const badges
        injectHighlightsWithHover(renderableConfigs, removedConfigs /* TO/default */, currentConfigs /* FROM */, settings);

        // New: @ConfigurationProperties badges
        injectConfigPropsHighlights(renderableConfigProps, removedConfigs /* TO/default */, currentConfigs /* FROM */, settings);

        console.log("[Config Key Finder] Scan complete.");
    } catch (e) {
        console.error('[Config Key Finder] scan error:', e);
    } finally {
        installObservers();
        isScanning = false;
        console.log("[Config Key Finder] runScan END. reason:", reason);
    }
}


// --------------------
// Bootstrap
// --------------------
(function bootstrap() {
    runScan('bootstrap');
    installObservers();
    window.addEventListener('popstate', () => runScan('popstate'));
    window.addEventListener('hashchange', () => runScan('hashchange'));
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) runScan('visibility');
        else globalObserver && globalObserver.disconnect();
    });
})();
