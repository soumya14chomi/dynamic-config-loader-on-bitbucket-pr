
// =====================================
// Config Key Finder - Bitbucket PR page
// =====================================

console.log("[Config Key Finder] Content script loaded.");

// --------------------
// Regex & Selectors
// --------------------
const CODE_LINE_SELECTORS = [
    'td.diff-line',
    'td[data-line-type]',   // Bitbucket uses data-line-type="ADDED"/"REMOVED"/"CONTEXT"
    '.udiff-line',
    '.diff-line'
].join(', ');

/**
 * Matches @Value("${key}") and @Value("${key:default}") with single or double quotes.
 * Captures "key" in group 1.
 */
const VALUE_LITERAL_REGEX =
    /@Value\s*\(\s*["']\$\{([^}:]+)(?::[^}]*)?\}\s*["']\s*\)/;

/** Detect constants in Java diffs, e.g.:
 *  private static final String TERMINAL_PROPERTIES_MAP_NAME = "hazelcast.terminal.properties.map.name";
 */
const CONST_ASSIGN_REGEX =
    /\b(?:(?:public|protected|private)\s+)?(?:static\s+)?(?:final\s+)?(?:String|char|int|long|double|float|var)\s+([A-Z0-9_]+)\s*=\s*"'["']/;

// --------------------
// Utility: wait for selector
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

// --------------------
// Global scanning state & helpers
// --------------------
const SCAN_COOLDOWN_MS = 2000;
let isScanning = false;
let lastScanTs = 0;
let globalObserver = null;   // make observer accessible
let lastSignature = '';      // dedupe by content signature

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
        .join('|');

    const lineCount =
        document.querySelectorAll('td.diff-line, td[data-line-type], .udiff-line, .diff-line').length;
    return `${fileHrefs}:${lineCount}`;
}

// Mark nodes we inject so we can ignore our own mutations
function isOurNode(node) {
    return node && node.nodeType === 1 && (node.hasAttribute('data-ckf') || node.closest('[data-ckf]'));
}

// ---------- Safe Chrome helpers ----------
function isExtensionAlive() {
    return !!(window.chrome && chrome.runtime && chrome.runtime.id);
}

async function getSettingsSafe(defaults = { maskSecrets: true, missingBehavior: 'show', enableExtension: true }) {
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
// Key normalization & parsing helpers
// --------------------

// Remove surrounding quotes, trim, strip invisible chars, and normalize dots
function sanitizeKey(k) {
    if (typeof k !== 'string') return k;

    let s = k.replace(/^\uFEFF/, '')                // BOM at start
        .replace(/[\u200B\u200C\u200D]/g, '')  // zero-width chars
        .replace(/\u00A0/g, ' ')               // non-breaking space -> normal space
        .trim();

    s = s.replace(/^['"]/, '').replace(/['"]$/, '');
    s = s.replace(/\.{2,}/g, '.');      // collapse accidental double dots
    s = s.replace(/\s*\.\s*/g, '.');    // remove spaces around dots

    return s;
}

// Collapse simple Java string concatenations into a single literal string
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

// After constants have been substituted, normalize @Value("${" + ... + "}") -> @Value("${...}")
function normalizeValueConcat(s) {
    return s.replace(/"\$\{\s*"\s*\+\s*([^}]+?)\s*\+\s*"\s*\}"/g, (m, inner) => {
        let cleaned = inner.replace(/"\s*\+\s*|\s*\+\s*"/g, '')
            .replace(/\s*\+\s*/g, '')
            .replace(/"/g, '')
            .trim();
        return `"${'${' + cleaned + '}' }"`;
    });
}

function normalizeKey(name) {
    const kebab = name.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
    const snake = kebab.replace(/-/g, '_');
    return [kebab, name, snake];
}

// Robust .properties parser: supports '=' and ':', BOM, continuations, inline comments, basic unescape
function parseProperties(text) {
    text = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');

    // Continuations
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
        value = value.replace(/\s+#.*$/, '');

        key = key.replace(/\\:/g, ':').replace(/\\=/g, '=').replace(/\\ /g, ' ');
        value = value.replace(/\\:/g, ':').replace(/\\=/g, '=').replace(/\\ /g, ' ');

        key = sanitizeKey(key);
        map[key] = value;
    }

    return map;
}

function flattenYaml(obj, prefix = '') {
    let result = {};
    if (!obj || typeof obj !== 'object') return result;
    for (const [k, v] of Object.entries(obj)) {
        const newKey = prefix ? `${prefix}.${k}` : k;
        if (typeof v === 'object' && v !== null) {
            Object.assign(result, flattenYaml(v, newKey));
        } else {
            result[newKey] = v;
        }
    }
    return result;
}


function buildSymbolTableFromDiff() {
    const symbolTable = {};

    // 1) Prefer exact code cells that carry line-type info
    const codeCells = document.querySelectorAll(
        'td[data-line-type], td.diff-line, .udiff-line, .diff-line'
    );

    codeCells.forEach(cell => {
        // Skip our injected nodes
        if (isOurNode(cell)) return;

        // Collect token spans inside the cell
        const tokens = [...cell.querySelectorAll(
            '.hl-variable, .hl-operator, .hl-string, .hl-type, .hl-keyword'
        )];

        if (tokens.length === 0) {
            // Fallback: try text-based regex on the cell
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

        // 2) Walk tokens to find patterns: VARIABLE -> '=' -> STRING
        let lastVariable = null;

        for (let i = 0; i < tokens.length; i++) {
            const t = tokens[i];
            const cls = t.classList;

            // Capture a candidate constant name
            if (cls.contains('hl-variable')) {
                lastVariable = (t.textContent || '').trim();
                continue;
            }

            // When we see '=', bind the last variable to the next string literal
            if (cls.contains('hl-operator') && (t.textContent || '').trim() === '=') {
                if (!lastVariable) continue;

                // Find the next string token on the same line (to the right)
                let valueToken = null;
                for (let j = i + 1; j < tokens.length; j++) {
                    const tj = tokens[j];
                    if (tj.classList.contains('hl-string')) {
                        valueToken = tj;
                        break;
                    }
                    // Stop if we hit a semicolon or operator that implies end of assignment
                    if (tj.classList.contains('hl-operator') && (tj.textContent || '').includes(';')) break;
                }

                if (valueToken) {
                    // Strip quotes from "literal"
                    let rawVal = (valueToken.textContent || '').trim();
                    rawVal = rawVal.replace(/^['"]/, '').replace(/['"]$/, '');
                    const constName = sanitizeKey(lastVariable);
                    const constValue = sanitizeKey(rawVal);

                    // Only record ALL_CAPS names (typical constants) to avoid picking locals
                    if (/^[A-Z0-9_]+$/.test(constName)) {
                        symbolTable[constName] = constValue;
                        console.log(`[Config Key Finder] Constant detected (tokens): ${constName} = ${constValue}`);
                    }
                }

                // Reset lastVariable so we don’t associate further operators with the same name
                lastVariable = null;
            }
        }
    });

    // 3) As a final sweep, try regex on any remaining lines that weren’t tokenized
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

// A) @Value(...) detection
function detectValueAnnotationsOnly(symbolTable = {}) {
    const nodes = document.querySelectorAll(CODE_LINE_SELECTORS);
    console.log(`[Config Key Finder] Scanning ${nodes.length} diff line nodes for @Value.`);

    const results = [];
    nodes.forEach(node => {
        let raw = (node.textContent || '').trim();
        if (!raw || !raw.includes('@Value')) return;

        // Strip unified diff markers
        raw = raw.replace(/^([+\-])\s?/, '');

        // Substitute constants
        let normalized = raw.replace(/\b([A-Z0-9_]+)\b/g, (name) =>
            symbolTable[name] !== undefined ? symbolTable[name] : name
        );

        // Collapse concatenations and rewrite ${" + ... + "} forms
        normalized = collapseJavaStringConcat(normalized);
        normalized = normalizeValueConcat(normalized);

        const m = normalized.match(VALUE_LITERAL_REGEX);
        if (!m) return;

        const key = sanitizeKey(m[1]); // robust key
        const lineContainer = node.closest('tr') || node;

        // Determine line side (ADDED/REMOVED/CONTEXT)
        const typeHolder = node.closest('td[data-line-type]') || node.closest('tr[data-line-type]');
        const lineType = typeHolder?.getAttribute('data-line-type') || 'CONTEXT';

        results.push({ type: 'value', key, element: lineContainer, lineType });
        console.log(`[Config Key Finder] @Value found (${lineType}): ${key}`);
    });

    console.log(`[Config Key Finder] @Value detection -> ${results.length} items.`);
    return results;
}

// B) Constant assignment detection: extract RHS string literal as a property key
function detectConstantPropertyKeys(symbolTable = {}) {
    const nodes = document.querySelectorAll(CODE_LINE_SELECTORS);
    const results = [];

    nodes.forEach(node => {
        let raw = (node.textContent || '').trim();
        if (!raw) return;

        // Strip unified diff markers
        raw = raw.replace(/^([+\-])\s?/, '');

        // First try direct match
        let m = raw.match(CONST_ASSIGN_REGEX);

        // If not matched, collapse concatenations and try again
        if (!m) {
            const collapsed = collapseJavaStringConcat(raw);
            m = collapsed.match(CONST_ASSIGN_REGEX);
        }

        if (!m) return;

        const literal = sanitizeKey(m[2]); // RHS string literal
        // Heuristic: looks like a property key (must contain a dot and at least one alpha)
        if (!(/\./.test(literal) && /[a-z]/i.test(literal))) return;

        const lineContainer = node.closest('tr') || node;
        const typeHolder = node.closest('td[data-line-type]') || node.closest('tr[data-line-type]');
        const lineType = typeHolder?.getAttribute('data-line-type') || 'CONTEXT';

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

    // De-duplicate by key+line element to avoid double badges
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
        const repoSlug   = lozenge.getAttribute('data-repo-slug')   || null;
        const branchText =
            lozenge.querySelector('.ref-lozenge-content > span')?.textContent?.trim()
            || lozenge.querySelector('.ref-lozenge-content')?.textContent?.trim()
            || null;
        const ref = branchText ? `refs/heads/${branchText}` : null;
        return { projectKey, repoSlug, branch: branchText, ref };
    }

    const from = readSide(lozenges[0]); // first lozenge = FROM (source)
    const to   = readSide(lozenges[1]); // second lozenge = TO (destination)

    console.debug('[CKF] PR sides:', { from, to });
    return { from, to };
}

function buildRawUrl(origin, projectKey, repoSlug, filePath, ref /* may be null */) {
    let url = `${origin}/projects/${projectKey}/repos/${repoSlug}/raw/${filePath}`;
    if (ref) url += `?at=${encodeURIComponent(ref)}`;
    return url;
}

/**
 * Return config file candidates with dual raw URLs:
 * [
 *   { name, filePath, fromUrl, toUrl, defaultUrl }
 * ]
 */
function findConfigFilesInPRDualUsingAnchors() {
    const origin = location.origin;

    // PR page repo (default/fallback)
    const parts = location.pathname.split('/').filter(Boolean);
    const projIdx = parts.indexOf('projects');
    const reposIdx = parts.indexOf('repos');
    if (projIdx === -1 || reposIdx === -1) {
        console.warn('[CKF] Cannot parse project/repo from pathname:', location.pathname);
    }
    const pageProjectKey = projIdx !== -1 ? parts[projIdx + 1] : null;
    const pageRepoSlug   = reposIdx !== -1 ? parts[reposIdx + 1] : null;

    const sides = getPRSidesFromHeader(); // { from:{projectKey,repoSlug,ref}, to:{...} }
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
                .trim() || filePath.split('/').pop();

        // Only consider application*.properties / yml|yaml
        if (!/^application.*\.(properties|yml|yaml)$/i.test(fileName)) return;

        // Build URLs per side; fallback to pageProjectKey/pageRepoSlug when side data missing
        const fromProj = sides?.from?.projectKey || pageProjectKey;
        const fromRepo = sides?.from?.repoSlug   || pageRepoSlug;
        const toProj   = sides?.to?.projectKey   || pageProjectKey;
        const toRepo   = sides?.to?.repoSlug     || pageRepoSlug;

        const fromUrl    = (fromProj && fromRepo) ? buildRawUrl(origin, fromProj, fromRepo, filePath, sides?.from?.ref) : null;
        const toUrl      = (toProj && toRepo)     ? buildRawUrl(origin, toProj,   toRepo,   filePath, sides?.to?.ref)   : null;
        const defaultUrl = (pageProjectKey && pageRepoSlug) ? buildRawUrl(origin, pageProjectKey, pageRepoSlug, filePath, null) : null;

        files.push({ name: fileName, filePath, fromUrl, toUrl, defaultUrl });
        console.log('[CKF] Config file (dual):', { name: fileName, fromUrl, toUrl, defaultUrl });
    });

    return files;
}

// --------------------
// Dual fetch: removedConfigs (FROM) & currentConfigs (TO/default)
// --------------------
async function fetchConfigsDual(files) {
    const removedConfigs = {}; // FROM side (REMOVED)
    const currentConfigs = {}; // TO side (ADDED/CONTEXT)

    async function fetchText(url) {
        if (!url) return null;
        try {
            const res = await fetch(url, { credentials: 'include' });
            if (!res.ok) {
                console.debug('[CKF] fetch failed', url, 'status:', res.status);
                return null;
            }
            const txt = await res.text();
            return txt && txt.length ? txt : null;
        } catch (e) {
            console.debug('[CKF] fetch error', url, e);
            return null;
        }
    }

    for (const file of files) {
        // ---------- removedConfigs (FROM) ----------
        const fromText = await fetchText(file.fromUrl);
        if (fromText) {
            if (file.name.endsWith('.properties')) {
                Object.assign(currentConfigs, parseProperties(fromText));
            } else if (/\.(yml|yaml)$/i.test(file.name)) {
                if (window.jsyaml) {
                    Object.assign(currentConfigs, flattenYaml(window.jsyaml.load(fromText)));
                } else {
                    console.warn('[CKF] YAML for FROM but jsyaml not present; skipping.');
                }
            }
        }

        // ---------- currentConfigs (TO -> default fallback) ----------
        let toText = await fetchText(file.toUrl);
        if (!toText) toText = await fetchText(file.defaultUrl);

        if (toText) {
            if (file.name.endsWith('.properties')) {
                Object.assign(removedConfigs, parseProperties(toText));
            } else if (/\.(yml|yaml)$/i.test(file.name)) {
                if (window.jsyaml) {
                    Object.assign(removedConfigs, flattenYaml(window.jsyaml.load(toText)));
                } else {
                    console.warn('[CKF] YAML for TO but jsyaml not present; skipping.');
                }
            }
        }
    }

    console.log('[CKF] removedConfigs size:', Object.keys(removedConfigs).length);
    console.log('[CKF] currentConfigs size:', Object.keys(currentConfigs).length);

    return { removedConfigs, currentConfigs };
}

// --------------------
// Inject badges per side
// --------------------

// Inject a <style> block once (if you don't have a CSS file)
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

/**
 * Highlight detected keys inline and show a hover tooltip with values.
 * fromBranch = configs ADDED (most recent)
 * toBranch   = configs REMOVED (older)
 */
function injectHighlightsWithHover(configs, removedConfigs_toBranch, currentConfigs_fromBranch, settings) {
    // Build normalized lookup maps
    const normRemoved = {};
    for (const [k, v] of Object.entries(removedConfigs_toBranch)) normRemoved[sanitizeKey(k)] = v;
    const normCurrent = {};
    for (const [k, v] of Object.entries(currentConfigs_fromBranch)) normCurrent[sanitizeKey(k)] = v;

    // Create/attach one tooltip element for the page
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
        const top = window.scrollY + rect.top - tooltip.offsetHeight - 6; // above the key
        const left = window.scrollX + rect.left;
        tooltip.style.top = `${Math.max(8, top)}px`;
        tooltip.style.left = `${left}px`;
    };

    const hideTooltip = () => {
        tooltip.classList.remove('show');
    };

    configs.forEach(cfg => {
        const container = cfg.element || document.body;
        const key = sanitizeKey(cfg.key);


        const safeKey = (window.CSS && CSS.escape) ? CSS.escape(key) : key.replace(/"/g, '\\"');
        if (container.querySelector(`.ckf-highlight[data-key="${safeKey}"]`)) return;


        // Find the deepest text node containing the key
        let targetTextNode = null;
        const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
            acceptNode: (node) => {
                if (!node.nodeValue) return NodeFilter.FILTER_SKIP;
                const txt = node.nodeValue;
                return txt.includes(key) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
            }
        });
        targetTextNode = walker.nextNode();

        // If not found, fallback to adding a small highlight at the end of the line

// If we didn't find a text node containing the resolved key,
// fallback to highlight the literal ${ ... } token.
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
            const hi = document.createElement('span');
            hi.className = 'ckf-highlight';
            hi.setAttribute('data-ckf', 'value-highlight');
            hi.setAttribute('data-key', key);
            hi.textContent = key;
            container.appendChild(hi);
            attachHover(hi, cfg, key, normRemoved, normCurrent, settings, showTooltip, hideTooltip);
            return;
        }

        // Split the text node around the key and wrap it
        const full = targetTextNode.nodeValue;
        const idx = full.indexOf(key);
        const before = document.createTextNode(full.slice(0, idx));
        const after = document.createTextNode(full.slice(idx + key.length));
        const hi = document.createElement('span');
        hi.className = 'ckf-highlight';
        hi.setAttribute('data-ckf', 'value-highlight');
        hi.setAttribute('data-key', key);
        hi.textContent = key;

        const parent = targetTextNode.parentNode;
        parent.replaceChild(after, targetTextNode);
        parent.insertBefore(hi, after);
        parent.insertBefore(before, hi);

        attachHover(hi, cfg, key, normRemoved, normCurrent, settings, showTooltip, hideTooltip);
    });

    function attachHover(hi, cfg, key, normRemoved, normCurrent, settings, showTooltip, hideTooltip) {
        // Choose map by lineType with your mapping:
        // ADDED  -> fromBranch (currentConfigs_fromBranch)
        // REMOVED-> toBranch   (removedConfigs_toBranch)
        // CONTEXT-> fromBranch
        const map = (cfg.lineType === 'REMOVED') ? normRemoved : normCurrent;
        let value = map[key];

        // Optional: also show the other side if present
        const otherMap = (cfg.lineType === 'REMOVED') ? normCurrent : normRemoved;
        const otherValue = otherMap[key];

        // Mask secrets
        if (settings.maskSecrets && /password|secret|token|apikey|api_key/i.test(key)) {
            value = (value !== undefined) ? '••••••' : value;
        }


        hi.addEventListener('mouseenter', () => {
            // Always show the key first
            const title = `@Value key: ${key}`;

            // Primary side mapping:
            // - REMOVED  -> toBranch (older)    -> normRemoved
            // - ADDED    -> fromBranch (added)  -> normCurrent
            // - CONTEXT  -> fromBranch          -> normCurrent
            const primarySide = (cfg.lineType === 'REMOVED')
                ? 'toBranch (removed)'
                : 'fromBranch (added)';

            const primaryVal = (value !== undefined) ? String(value) : 'Not set';

            // Base tooltip content: show key, then primary value
            let html = `
                <div class="ckf-title">${escapeHtml(title)}</div>
                <div class="ckf-row"><span class="ckf-label">${primarySide}:</span><span>${escapeHtml(primaryVal)}</span></div>
              `;

            // If other side exists and is different, show it as secondary
            if (otherValue !== undefined && String(otherValue) !== String(value)) {
                html += `<div class="ckf-row"><span class="ckf-label">other side:</span><span>${escapeHtml(String(otherValue))}</span></div>`;
            }

            showTooltip(hi, html);
        });


        hi.addEventListener('mouseleave', hideTooltip);
        hi.addEventListener('click', hideTooltip); // hides if user clicks
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
            // Ignore mutations caused by our own injected nodes
            if (isOurNode(m.target)) continue;
            if ([...m.addedNodes].some(n => isOurNode(n))) continue;

            // New files or diff content appeared
            const addedRelevant = [...m.addedNodes].some(n => {
                if (n.nodeType !== 1) return false;
                return (
                    n.matches?.('ol.files, ul.files, li.file, .diff-view, .js-diff-progressive') ||
                    n.querySelector?.('ol.files, ul.files, li.file, .diff-view, .js-diff-progressive, ' + CODE_LINE_SELECTORS)
                );
            });

            if (addedRelevant) {
                relevant = true;
                break;
            }

            // Attribute changes that indicate file selection changes
            if (m.type === 'attributes' && m.attributeName === 'aria-selected') {
                relevant = true;
                break;
            }
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

// --------------------
// Main scan
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
        // Disconnect observer during scan to avoid self-trigger loops
        globalObserver && globalObserver.disconnect();

        // Settings (safe wrapper)
        const settings = await getSettingsSafe();
        if (!settings.enableExtension) {
            console.log("[Config Key Finder] Extension disabled by user.");
            return;
        }

        // Wait for file list (Bitbucket commonly uses <ol class="files">)
        try {
            await waitForSelector('ol.files, ul.files', { timeout: 8000 });
            console.log("[Config Key Finder] files list detected.");
        } catch (e) {
            console.warn("[Config Key Finder] files list not found yet; proceeding to scan whatever is present.");
        }

        // Signature-based dedupe to skip redundant scans
        const sig = computeSignature();
        if (sig === lastSignature) {
            console.debug('[Config Key Finder] signature unchanged; skipping scan. reason:', reason);
            return;
        }
        lastSignature = sig;

        // Build symbol table to resolve constants inside @Value expressions
        const symbolTable = buildSymbolTableFromDiff();

        // Detect annotations in diff lines (with lineType)
        const detectedConfigs = detectAnnotations(symbolTable);
        console.log(`[Config Key Finder] detectAnnotations -> ${detectedConfigs.length} items.`);

        // Find dual config file candidates using anchors (FROM/TO/default)
        const filesDual = findConfigFilesInPRDualUsingAnchors() || [];
        console.log(`[Config Key Finder] findConfigFilesInPRDualUsingAnchors -> ${filesDual.length} files.`);

        // Fetch both sides
        let removedConfigs = {};
        let currentConfigs = {};
        if (filesDual.length > 0) {
            const both = await fetchConfigsDual(filesDual);
            removedConfigs = both.removedConfigs;
            currentConfigs = both.currentConfigs;
        } else {
            console.log('[Config Key Finder] No config file candidates found.');
        }


        // Inject inline highlights + hover values (fromBranch for ADDED/CONTEXT; toBranch for REMOVED)
        injectHighlightsWithHover(detectedConfigs, removedConfigs /* toBranch */, currentConfigs /* fromBranch */, settings);


        console.log("[Config Key Finder] Scan complete.");
    } catch (e) {
        console.error('[Config Key Finder] scan error:', e);
    } finally {
        // Reconnect observer
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
