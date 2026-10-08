/* Uses the signed-in ChatGPT UI. No cookies, tokens or private endpoints are read. */
(function () {
    if (window.__AutoCourseraChatGPTBridgeInjected) return;
    window.__AutoCourseraChatGPTBridgeInjected = true;
    let activeRequestId = null;
    let cancelledRequestId = null;
    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const visible = (el) => Boolean(el && !el.hidden && (el.offsetParent !== null || el.getClientRects?.().length));
    const label = (el) => [el?.textContent || "", el?.getAttribute("aria-label") || "", el?.getAttribute("title") || ""].join(" ").replace(/\s+/g, " ").trim();
    const enabled = (el) => visible(el) && !el.disabled && el.getAttribute("aria-disabled") !== "true";
    const PRO = /\bpro\b/i;
    const FAST = /\b(instant|fast|quick)\b|nhanh|tốc độ/i;

    function findInput() {
        return ['#prompt-textarea', 'textarea[data-testid="prompt-textarea"]', '[contenteditable="true"][role="textbox"]']
            .map((selector) => document.querySelector(selector)).find(visible);
    }
    function findSend() {
        return ['button[data-testid="send-button"]', 'button[aria-label="Send prompt"]', 'button[aria-label="Send message"]',
            'button[aria-label="Gửi tin nhắn"]', 'button[aria-label="Gửi câu lệnh"]', 'button[aria-label="Gửi"]']
            .map((selector) => document.querySelector(selector)).find(visible);
    }
    function isGenerating() {
        return ['button[data-testid="stop-button"]', 'button[aria-label*="Stop generating" i]', 'button[aria-label*="Stop streaming" i]',
            'button[aria-label*="Dừng" i]', '[data-is-streaming="true"]', '[aria-busy="true"][data-message-author-role="assistant"]']
            .some((selector) => visible(document.querySelector(selector)));
    }
    function modelControl() {
        const input = findInput();
        const composer = input?.closest('[data-testid="composer"], form, [class*="composer" i]') || input?.parentElement?.parentElement;
        const candidates = composer ? Array.from(composer.querySelectorAll('button, [role="button"]')) : [];
        return candidates.find((el) => enabled(el) && /\b(pro|instant|thinking|auto|fast)\b|mức nỗ lực|reasoning|model/i.test(label(el))) ||
            [document.querySelector('[data-testid="model-switcher-dropdown-button"]'),
                ...Array.from(document.querySelectorAll('button, [role="button"]'))]
                .find((el) => enabled(el) && /\b(pro|instant|thinking|auto|fast)\b|mức nỗ lực|reasoning|choose model|chọn mô hình/i.test(label(el)));
    }
    function menuChoice(pattern) {
        const choices = Array.from(document.querySelectorAll('[role="menuitem"], [role="menuitemradio"], [role="option"], button, [role="button"]'));
        return choices.find((el) => enabled(el) && pattern.test(label(el)) && !/upgrade|get pro|nâng cấp/i.test(label(el)) &&
            (el.getAttribute("role")?.startsWith("menuitem") || el.getAttribute("role") === "option" ||
                el.closest('[role="menu"], [role="dialog"], [data-state="open"][data-radix-popper-content-wrapper]')));
    }
    function findSlider() {
        const sliders = Array.from(document.querySelectorAll('input[type="range"], [role="slider"]')).filter(visible);
        return sliders.find((el) => /reasoning|effort|suy luận|nỗ lực/i.test(label(el))) || (sliders.length === 1 ? sliders[0] : null);
    }
    function selectedMode(pattern) {
        if (pattern.test(label(modelControl()))) return true;
        const selected = Array.from(document.querySelectorAll('[role="menuitemradio"][aria-checked="true"], [role="option"][aria-selected="true"]'));
        if (selected.some((el) => visible(el) && pattern.test(label(el)))) return true;
        // A menu may list Pro even when another mode is selected.
        return false;
    }
    async function setEffort(slider, maximum) {
        const native = slider.tagName === "INPUT" && slider.type === "range";
        const min = Number(native ? slider.min || "0" : slider.getAttribute("aria-valuemin"));
        const max = Number(native ? slider.max || "100" : slider.getAttribute("aria-valuemax"));
        if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) throw new Error("PRO_EFFORT_UNAVAILABLE: Không xác định được giới hạn mức suy luận.");
        const target = maximum ? max : min;
        slider.focus();
        if (native) {
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement?.prototype || {}, "value")?.set;
            if (setter) setter.call(slider, String(target)); else slider.value = String(target);
            slider.dispatchEvent(new Event("input", {bubbles: true}));
            slider.dispatchEvent(new Event("change", {bubbles: true}));
        } else {
            // Let React/the slider change its own state; never forge aria-valuenow.
            const key = maximum ? "End" : "Home";
            slider.dispatchEvent(new KeyboardEvent("keydown", {key, code: key, bubbles: true}));
            slider.dispatchEvent(new KeyboardEvent("keyup", {key, code: key, bubbles: true}));
        }
        await delay(400);
        const current = findSlider();
        const actual = current ? Number(native ? current.value : current.getAttribute("aria-valuenow")) : NaN;
        if (actual !== target) throw new Error("PRO_EFFORT_NOT_CONFIRMED: Thanh suy luận chưa đạt mức yêu cầu; đã dừng.");
    }
    async function selectResponseMode(options = {}) {
        // Choose the Conversation surface when the Chat/Work switch is present.
        const conversation = Array.from(document.querySelectorAll('button, [role="tab"]')).find((el) =>
            enabled(el) && /^(trò chuyện|conversation)$/i.test((el.textContent || "").trim()));
        if (conversation && conversation.getAttribute("aria-selected") !== "true") {
            conversation.click(); await delay(400);
        }
        const control = modelControl();
        if (!control) throw new Error("CHATGPT_MODE_UNAVAILABLE: Không tìm thấy bộ chọn chế độ ChatGPT.");
        if (options.mode === "fast" && selectedMode(FAST)) return;
        control.click();
        await delay(400);
        if (options.mode === "fast") {
            const fast = menuChoice(FAST);
            if (fast) {fast.click(); await delay(400);}
            if (selectedMode(FAST)) return;
            const slider = findSlider();
            if (slider) {await setEffort(slider, false); return;}
            throw new Error("CHATGPT_FAST_UNAVAILABLE: Không xác nhận được chế độ trả lời nhanh.");
        }
        if (!selectedMode(PRO)) {
            const pro = menuChoice(PRO);
            if (!pro) throw new Error("PRO_MODE_UNAVAILABLE: Tài khoản/giao diện chưa có chế độ Pro.");
            pro.click(); await delay(400);
        }
        // Some layouts put the effort control behind a second composer menu.
        if (!findSlider()) {
            const effort = modelControl();
            if (effort) {effort.click(); await delay(400);}
        }
        const slider = findSlider();
        if (!slider) throw new Error("PRO_EFFORT_UNAVAILABLE: Không tìm thấy thanh mức suy luận để chọn cao nhất.");
        await setEffort(slider, true);
        // Close the effort popover without changing the chosen value.
        const closeControl = modelControl();
        if (closeControl) {closeControl.click(); await delay(200);}
        if (!selectedMode(PRO)) throw new Error("PRO_MODE_NOT_CONFIRMED: Không xác nhận được Pro; không gửi bài giới hạn lượt.");
    }
    function assistantTurns() {
        return Array.from(document.querySelectorAll('[data-message-author-role="assistant"]'));
    }
    function finalText(turn) {
        return Array.from(turn.querySelectorAll('.markdown')).filter((node) =>
            !node.closest('[data-testid*="thinking" i], [data-testid*="reasoning" i], [class*="reasoning" i]'))
            .map((node) => (node.innerText || node.textContent || "").trim()).filter(Boolean).join("\n");
    }
    function completedTurn(turn) {
        const container = turn.closest('article, [data-testid^="conversation-turn-"]') || turn;
        return Boolean(container.querySelector('[data-testid="copy-turn-action-button"], [data-testid="good-response-turn-action-button"], button[aria-label="Copy" i], button[aria-label="Sao chép" i]'));
    }
    function checkCancelled(requestId) {
        if (requestId && cancelledRequestId === requestId) throw new Error("CHATGPT_CANCELLED: Đã hủy yêu cầu.");
    }
    async function attachScreenshots(input, urls, requestId) {
        for (let index = 0; index < urls.length; index++) {
            checkCancelled(requestId);
            if (!/^data:image\/(png|jpeg|webp);base64,/.test(urls[index])) throw new Error("INVALID_SCREENSHOT");
            const blob = await (await fetch(urls[index])).blob();
            checkCancelled(requestId);
            const name = `question-section-${Date.now()}-${index + 1}.${blob.type === "image/png" ? "png" : "jpg"}`;
            const transfer = new DataTransfer();
            transfer.items.add(new File([blob], name, {type: blob.type}));
            const fileInput = Array.from(document.querySelectorAll('input[type="file"]')).find((el) => !el.accept || /image|png|jpeg/i.test(el.accept));
            if (fileInput) {fileInput.files = transfer.files; fileInput.dispatchEvent(new Event("change", {bubbles: true}));}
            else input.dispatchEvent(new ClipboardEvent("paste", {bubbles: true, cancelable: true, clipboardData: transfer}));
            const started = Date.now();
            let ready = false;
            while (Date.now() - started < 30000) {
                checkCancelled(requestId);
                const filenameVisible = (document.body.innerText || "").includes(name) ||
                    Array.from(document.querySelectorAll('[aria-label], [title]')).some((el) => label(el).includes(name));
                if (filenameVisible && enabled(findSend()) && !document.querySelector('[data-testid*="upload"] [role="progressbar"]')) {ready = true; break;}
                await delay(400);
            }
            if (!ready) throw new Error("IMAGE_UPLOAD_FAILED: ChatGPT chưa xác nhận tải ảnh hoàn tất.");
        }
    }
    async function handleAskChatGPT(prompt, options = {}) {
        if (!prompt?.trim()) throw new Error("EMPTY_PROMPT");
        if (isGenerating()) throw new Error("CHATGPT_BUSY: Tab đang tạo phản hồi khác.");
        let input = findInput();
        if (!input) throw new Error("NOT_LOGGED_IN: Mở tab ChatGPT và đăng nhập tài khoản Pro trong cùng trình duyệt.");
        if ((input.value ?? input.textContent ?? "").trim()) throw new Error("CHATGPT_DRAFT_PRESENT: Tab có tin nhắn chưa gửi; hãy xử lý trước.");
        await selectResponseMode(options);
        checkCancelled(options.requestId);
        input = findInput();
        if (!input) throw new Error("CHATGPT_COMPOSER_MISSING");
        const baseline = new Set(assistantTurns());
        input.focus();
        if (input.tagName === "TEXTAREA") {
            const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
            if (setter) setter.call(input, prompt); else input.value = prompt;
        } else if (!document.execCommand("insertText", false, prompt)) input.textContent = prompt;
        input.dispatchEvent(new InputEvent("input", {bubbles: true, inputType: "insertText", data: prompt}));
        await attachScreenshots(input, options.screenshotUrls || [], options.requestId);
        const sendStarted = Date.now();
        while (!enabled(findSend()) && Date.now() - sendStarted < 15000) {checkCancelled(options.requestId); await delay(300);}
        const send = findSend();
        if (!enabled(send)) throw new Error("SEND_BUTTON_NOT_READY: ChatGPT chưa sẵn sàng gửi.");
        checkCancelled(options.requestId);
        send.click();
        const timeoutMs = options.timeoutMs || (options.mode === "fast" ? 300000 : 1800000);
        const started = Date.now();
        let lastText = "", stableSince = null, sentConfirmed = false;
        while (Date.now() - started < timeoutMs) {
            checkCancelled(options.requestId);
            await delay(600);
            const generating = isGenerating();
            const turns = assistantTurns();
            const turn = turns[turns.length - 1];
            const isNew = turn && !baseline.has(turn);
            if (!(input.value ?? input.textContent ?? "").trim() || generating || isNew) sentConfirmed = true;
            if (!sentConfirmed && Date.now() - started > 10000) throw new Error("SEND_NOT_CONFIRMED: ChatGPT chưa nhận câu hỏi.");
            const text = isNew ? finalText(turn) : "";
            if (text !== lastText || generating || !isNew || !completedTurn(turn)) {lastText = text; stableSince = null; continue;}
            if (stableSince === null) stableSince = Date.now();
            if (text && Date.now() - stableSince >= 1800) return text;
        }
        throw new Error("CHATGPT_TIMEOUT: Phản hồi chưa hoàn tất; không lấy đáp án một phần.");
    }

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (sender.id !== chrome.runtime.id) return;
        if (message?.type === "PING_CHATGPT") {
            const input = findInput();
            sendResponse({ok: true, isReady: true, loggedIn: Boolean(input), busy: Boolean(activeRequestId) || isGenerating(),
                hasDraft: Boolean((input?.value ?? input?.textContent ?? "").trim())});
            return;
        }
        if (message?.type === "CANCEL_CHATGPT_JOB" && activeRequestId === message.requestId) {
            cancelledRequestId = message.requestId;
            // Do not stop or modify the user's conversation; discard any late answer.
            sendResponse({ok: true}); return;
        }
        if (message?.type !== "START_CHATGPT_JOB") return;
        if (activeRequestId || isGenerating()) {sendResponse({ok: false, error: "CHATGPT_BUSY"}); return;}
        activeRequestId = message.requestId;
        sendResponse({ok: true}); // Short ACK keeps MV3 messaging independent of Pro's duration.
        handleAskChatGPT(message.prompt, {...message.options, requestId: message.requestId})
            .then((text) => ({ok: true, text}), (error) => ({ok: false, error: error.message}))
            .then((result) => {
                chrome.runtime.sendMessage({type: "chatGPTJobResult", requestId: message.requestId, ...result}, () => {void chrome.runtime.lastError;});
            })
            .finally(() => {activeRequestId = null;});
    });
})();
