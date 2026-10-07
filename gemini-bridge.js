/**
 * Gemini Web Tab Bridge Script
 * Injected into https://gemini.google.com/*
 * 
 * Automates typing prompts, submitting, waiting for answers,
 * and extracting responses directly from Google Gemini Web UI.
 */

(function () {
    if (window.__AutoCourseraGeminiBridgeInjected) {
        return;
    }
    window.__AutoCourseraGeminiBridgeInjected = true;

    console.log("[AutoCoursera][GeminiBridge] Bridge script loaded on Gemini Web.");

    function log(message, details = null) {
        if (details) {
            console.log(`[AutoCoursera][GeminiBridge] ${message}`, details);
        } else {
            console.log(`[AutoCoursera][GeminiBridge] ${message}`);
        }
    }

    function delay(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    function isLoginPage() {
        const href = window.location.href;
        if (href.includes("accounts.google.com")) {
            return true;
        }

        const signInBtn = document.querySelector(
            'a[href*="accounts.google.com"], button[aria-label*="Sign in" i], button[aria-label*="Đăng nhập" i]'
        );
        return Boolean(signInBtn && !findChatInput());
    }

    function findElementAcrossShadowRoots(selector) {
        const direct = document.querySelector(selector);
        if (direct) return direct;

        const allCustom = document.querySelectorAll("*");
        for (const el of allCustom) {
            if (el.shadowRoot) {
                const inside = el.shadowRoot.querySelector(selector);
                if (inside) return inside;
            }
        }
        return null;
    }

    function findChatInput() {
        const candidates = [
            'rich-textarea div[contenteditable="true"]',
            'rich-textarea .ql-editor',
            'div[contenteditable="true"][role="textbox"]',
            'div.ql-editor[contenteditable="true"]',
            'div[contenteditable="true"][aria-label]',
            'div[contenteditable="true"]',
            'textarea[aria-label*="prompt" i]',
            'textarea[aria-label*="lệnh" i]',
            'textarea'
        ];

        for (const sel of candidates) {
            const el = findElementAcrossShadowRoots(sel);
            if (el && el.offsetParent !== null) {
                return el;
            }
        }
        return null;
    }

    function findSendButton() {
        const candidates = [
            'button[aria-label*="Send message" i]',
            'button[aria-label*="Send prompt" i]',
            'button[aria-label*="Send" i]',
            'button[aria-label*="Gửi tin nhắn" i]',
            'button[aria-label*="Gửi câu lệnh" i]',
            'button[aria-label*="Gửi" i]',
            'button.send-button',
            'button[aria-label*="Submit" i]',
            'button[data-testid="send-button"]',
            'button[data-test-id="send-button"]',
            '.send-button-container button'
        ];

        for (const sel of candidates) {
            const btn = findElementAcrossShadowRoots(sel);
            if (btn && btn.offsetParent !== null) {
                return btn;
            }
        }

        const allButtons = document.querySelectorAll("button");
        for (const btn of allButtons) {
            if (btn.offsetParent === null) continue;
            const aria = (btn.getAttribute("aria-label") || "").toLowerCase();
            if (aria.includes("send") || aria.includes("gửi")) {
                return btn;
            }
            const icon = btn.querySelector('mat-icon, svg, [data-mat-icon-name="send"]');
            const iconName = icon ? `${icon.textContent || ""} ${icon.getAttribute("data-mat-icon-name") || ""}`.toLowerCase() : "";
            if (icon && (String(btn.className).includes("send") || /\b(send|arrow_upward|arrow_up|north)\b/.test(iconName))) {
                return btn;
            }
        }

        return null;
    }

    function isGenerating() {
        const stopSelectors = [
            'button[aria-label*="Stop response" i]',
            'button[aria-label*="Stop generating" i]',
            'button[aria-label*="Stop" i]',
            'button[aria-label*="Dừng tạo" i]',
            'button[aria-label*="Dừng phản hồi" i]',
            'button[aria-label*="Dừng" i]',
            'button.stop-button',
            '.stop-button-container button',
            'mat-progress-bar',
            '.loading-dots',
            '.streaming'
        ];

        for (const sel of stopSelectors) {
            const el = findElementAcrossShadowRoots(sel);
            if (el && el.offsetParent !== null) {
                return true;
            }
        }
        return false;
    }

    function getAllResponseElements() {
        const responseSelectors = [
            'message-content',
            '.model-response-text',
            '[data-test-id="model-response"]',
            '.response-container-content',
            '.model-turn .markdown',
            '.assistant-turn .markdown',
            'model-response'
        ];

        for (const sel of responseSelectors) {
            const els = document.querySelectorAll(sel);
            if (els && els.length > 0) {
                return Array.from(els);
            }
        }

        const markdowns = document.querySelectorAll(".markdown");
        if (markdowns && markdowns.length > 0) {
            return Array.from(markdowns);
        }

        return [];
    }

    function getLatestResponseText() {
        const els = getAllResponseElements();
        if (els.length > 0) {
            const last = els[els.length - 1];
            return (last.innerText || last.textContent || "").trim();
        }
        return "";
    }

    async function waitForInput(timeoutMs = 15000) {
        const startTime = Date.now();
        while (Date.now() - startTime < timeoutMs) {
            if (isLoginPage()) {
                throw new Error("NOT_LOGGED_IN: Vui lòng đăng nhập tài khoản Google trên tab Gemini trước!");
            }
            const input = findChatInput();
            if (input) {
                return input;
            }
            await delay(400);
        }
        throw new Error("TIMEOUT_FIND_INPUT: Không tìm thấy ô nhập câu hỏi trên Gemini Web sau 15 giây.");
    }

    async function injectPromptText(inputEl, text) {
        inputEl.focus();
        await delay(100);

        try {
            const sel = window.getSelection();
            const range = document.createRange();
            range.selectNodeContents(inputEl);
            sel.removeAllRanges();
            sel.addRange(range);
        } catch (e) {
            // Ignore selection error
        }

        let inserted = false;
        try {
            inserted = document.execCommand("insertText", false, text);
        } catch (e) {
            inserted = false;
        }

        if (!inserted || !inputEl.textContent || inputEl.textContent.trim().length === 0) {
            inputEl.textContent = text;
            inputEl.dispatchEvent(
                new InputEvent("input", {
                    bubbles: true,
                    cancelable: true,
                    inputType: "insertText",
                    data: text,
                })
            );
        }

        inputEl.dispatchEvent(new Event("input", { bubbles: true }));
        inputEl.dispatchEvent(new Event("change", { bubbles: true }));
        await delay(250);
    }

    async function triggerSend(inputEl) {
        const baselineCount = getAllResponseElements().length;
        const started = Date.now();
        let clicked = false;
        while (Date.now() - started < 15000) {
            const sendBtn = findSendButton();
            if (sendBtn && !sendBtn.disabled && sendBtn.getAttribute("aria-disabled") !== "true") {
                log("Clicking send button.");
                sendBtn.click();
                clicked = true;
                break;
            }
            await delay(300);
        }
        if (!clicked) throw new Error("SEND_BUTTON_NOT_READY: Không tìm thấy nút gửi Gemini khả dụng sau 15 giây.");
        const clickedAt = Date.now();
        while (Date.now() - clickedAt < 10000) {
            const composerText = (inputEl.value !== undefined ? inputEl.value : inputEl.textContent) || "";
            if (!composerText.trim() || isGenerating() || getAllResponseElements().length > baselineCount) return true;
            await delay(300);
        }
        throw new Error("SEND_NOT_CONFIRMED: Đã bấm gửi nhưng Gemini chưa nhận prompt; không đọc lại câu trả lời cũ.");
    }

    async function attachQuestionScreenshots(inputEl, urls = []) {
        for (let index = 0; index < urls.length; index++) {
            const url = urls[index];
            if (!/^data:image\/(png|jpeg|webp);base64,/.test(url)) throw new Error("INVALID_SCREENSHOT: Ảnh không hợp lệ.");
            const blob = await (await fetch(url)).blob();
            const name = `question-section-${Date.now()}-${index + 1}.${blob.type === "image/png" ? "png" : "jpg"}`;
            const file = new File([blob], name, { type: blob.type });
            const transfer = new DataTransfer();
            transfer.items.add(file);
            const fileInput = findElementAcrossShadowRoots('input[type="file"]');
            if (fileInput) {
                fileInput.files = transfer.files;
                fileInput.dispatchEvent(new Event("change", { bubbles: true }));
            } else {
                inputEl.focus();
                inputEl.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer }));
            }
            let attached = false;
            const started = Date.now();
            while (Date.now() - started < 30000) {
                const filenameVisible = (document.body.innerText || "").includes(name) ||
                    Array.from(document.querySelectorAll('[aria-label], [title]')).some((el) =>
                        (el.getAttribute("aria-label") || "").includes(name) || (el.getAttribute("title") || "").includes(name));
                const send = findSendButton();
                if (filenameVisible && send && !send.disabled && send.getAttribute("aria-disabled") !== "true") {
                    attached = true;
                    break;
                }
                await delay(400);
            }
            if (!attached) throw new Error("IMAGE_UPLOAD_FAILED: Gemini chưa xác nhận ảnh đã tải lên; không gửi thiếu ảnh.");
        }
    }

    async function handleAskGemini(prompt, options = {}) {
        const timeoutMs = options.timeoutMs || 120000;
        log("Received ASK_GEMINI prompt, length:", prompt.length);

        if (isLoginPage()) {
            throw new Error("NOT_LOGGED_IN: Vui lòng đăng nhập tài khoản Google trên tab Gemini trước!");
        }

        const inputEl = await waitForInput(15000);
        const baselineResponses = getAllResponseElements().length;
        const baselineText = getLatestResponseText();
        log("Baseline response count:", baselineResponses);

        await injectPromptText(inputEl, prompt);
        await attachQuestionScreenshots(inputEl, options.screenshotUrls || []);
        await delay(300);

        await triggerSend(inputEl);
        log("Prompt sent, waiting for Gemini response...");

        const startTime = Date.now();
        let generationStarted = false;
        let lastText = "";
        let stableCount = 0;

        while (Date.now() - startTime < timeoutMs) {
            await delay(600);

            const generating = isGenerating();
            const currentResponses = getAllResponseElements().length;
            const currentLatestText = getLatestResponseText();

            if (generating || currentResponses > baselineResponses || (currentLatestText && currentLatestText !== baselineText)) {
                if (!generationStarted) {
                    generationStarted = true;
                    log("Gemini generation detected / started.");
                }
            }

            if (generationStarted) {
                if (currentLatestText && currentLatestText !== baselineText && currentLatestText === lastText && !generating) {
                    stableCount++;
                    if (stableCount >= 2 && currentLatestText.length > 20) {
                        log("Gemini response completed & stabilized. Length:", currentLatestText.length);
                        return currentLatestText;
                    }
                } else {
                    stableCount = 0;
                    lastText = currentLatestText;
                }
            }
        }

        const fallbackText = getLatestResponseText();
        if (generationStarted && !isGenerating() && fallbackText !== baselineText && fallbackText && fallbackText.length > 20) {
            log("Timeout reached but got fallback response text, length:", fallbackText.length);
            return fallbackText;
        }

        throw new Error("TIMEOUT_WAIT_RESPONSE: Gemini Web không phản hồi hoặc phản hồi quá lâu (> " + Math.round(timeoutMs / 1000) + "s).");
    }

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (!message) return;

        if (message.type === "PING_GEMINI") {
            const loggedIn = !isLoginPage();
            const hasInput = Boolean(findChatInput());
            sendResponse({
                ok: true,
                isReady: true,
                loggedIn: loggedIn,
                hasInput: hasInput,
                url: window.location.href,
            });
            return;
        }

        if (message.type === "ASK_GEMINI") {
            (async () => {
                try {
                    const text = await handleAskGemini(message.prompt, message.options || {});
                    sendResponse({ ok: true, text });
                } catch (err) {
                    log("Error solving with Gemini:", err.message);
                    sendResponse({
                        ok: false,
                        error: err.message || "Failed to get response from Gemini Web",
                    });
                }
            })();
            return true;
        }
    });
})();
