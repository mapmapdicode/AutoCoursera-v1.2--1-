/* Shared attempt policy. Missing metadata always takes the careful route. */
(function (root) {
    const FAST_TIMEOUT_MS = 5 * 60 * 1000;
    const PRO_TIMEOUT_MS = 30 * 60 * 1000;
    let observedAssignment = null;
    let renderedHeading = "";
    let staleHeading = null;
    function classifyAttempts(text = "") {
        const value = String(text).replace(/\s+/g, " ");
        const limited = /\b\d+\s*(?:of\s*\d+\s*)?attempts?\b|\d+\s*(?:lượt|lần)\s*(?:làm|thử)|every\s*24\s*hours|mỗi\s*24\s*giờ/i.test(value);
        const unlimited = /unlimited\s+attempts|(?:số\s*)?(?:lần\s*thử|lượt\s*làm)\s*không\s*giới\s*hạn|không\s*giới\s*hạn\s*(?:lần|lượt)/i.test(value);
        return makePolicy(limited ? "limited" : unlimited ? "unlimited" : "unknown");
    }
    function makePolicy(kind) {
        return {kind, mode: kind === "unlimited" ? "fast" : "pro",
            reasoningEffort: kind === "unlimited" ? "min" : "max",
            timeoutMs: kind === "unlimited" ? FAST_TIMEOUT_MS : PRO_TIMEOUT_MS};
    }
    function assignmentKey(path = "") {
        const clean = String(path).split(/[?#]/)[0].replace(/\/+$/, "");
        return clean.match(/^\/learn\/[^/]+\/(?:quiz|assignment-submission)\/[^/]+/)?.[0] ||
            clean.replace(/\/(attempt|view-feedback|feedback|instructions|submit|submission|review)$/, "");
    }
    function rememberPolicy(path, text, storage) {
        const result = classifyAttempts(text);
        if (result.kind !== "unknown") {
            try { storage?.setItem(`autocoursera:attemptPolicy:${assignmentKey(path)}`, JSON.stringify({kind: result.kind, savedAt: Date.now()})); } catch (_) {}
        }
        return result;
    }
    function getPolicy(path, text, storage) {
        const current = rememberPolicy(path, text, storage);
        if (current.kind !== "unknown") return {...current, assignmentKey: assignmentKey(path)};
        try {
            const saved = JSON.parse(storage?.getItem(`autocoursera:attemptPolicy:${assignmentKey(path)}`) || "null");
            if (saved && ["limited", "unlimited"].includes(saved.kind) && Number.isFinite(saved.savedAt) &&
                Date.now() - saved.savedAt < 24 * 60 * 60 * 1000) {
                return {...makePolicy(saved.kind), assignmentKey: assignmentKey(path)};
            }
        } catch (_) {}
        return {...current, assignmentKey: assignmentKey(path)};
    }
    function currentPolicy() {
        const doc = root.document;
        let text = "";
        let heading = "";
        if (doc?.body) {
            const main = doc.querySelector('main, [role="main"]');
            const rendered = main || doc.body;
            heading = (rendered.querySelector('h1, [data-testid="assignment-title"]')?.textContent || "").replace(/\s+/g, " ").trim();
            const clone = (main || doc.body).cloneNode(true);
            clone.querySelectorAll('nav, aside, header, footer, [role="navigation"], [role="complementary"], [class*="sidebar" i], [data-testid*="outline" i], script, style, noscript').forEach((node) => node.remove());
            text = clone.textContent || "";
        }
        let storage;
        try { storage = root.sessionStorage; } catch (_) {}
        const path = root.location?.pathname || "";
        const key = assignmentKey(path);
        if (observedAssignment !== key) {
            staleHeading = observedAssignment === null ? null : renderedHeading;
            observedAssignment = key;
        }
        // pushState can change the URL before the old quiz's DOM unmounts.
        // Until a new assignment heading renders, only already-saved metadata
        // for this exact assignment is trustworthy. Repeated titles take Pro.
        const trustworthy = Boolean(heading) && (staleHeading === null || heading !== staleHeading);
        if (trustworthy) {renderedHeading = heading; staleHeading = null;}
        return getPolicy(path, trustworthy ? text : "", storage);
    }
    const api = {FAST_TIMEOUT_MS, PRO_TIMEOUT_MS, classifyAttempts, assignmentKey, rememberPolicy, getPolicy, currentPolicy};
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    root.ChatGPTPolicy = api;
    if (root.document && root.location?.hostname?.endsWith("coursera.org")) {
        let scheduled = false;
        const remember = () => {
            if (scheduled) return;
            scheduled = true;
            setTimeout(() => { scheduled = false; currentPolicy(); }, 200);
        };
        currentPolicy();
        // Capture policy before Start/Resume changes the SPA route or unloads the page.
        root.document.addEventListener("click", currentPolicy, true);
        new MutationObserver(remember).observe(root.document.body, {childList: true, subtree: true, characterData: true});
    }
})(typeof globalThis !== "undefined" ? globalThis : this);
