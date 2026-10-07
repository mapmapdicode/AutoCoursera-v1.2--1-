function sendTabMessage(tabId, message) {
    chrome.tabs.sendMessage(tabId, message, () => {
        if (
            chrome.runtime.lastError &&
            !isIgnorableMessagePortError(chrome.runtime.lastError.message)
        ) {
            console.log("Error sending message to tab:", chrome.runtime.lastError.message);
        }
    });
}

function isIgnorableMessagePortError(message) {
    return (
        typeof message === "string" &&
        message.includes("The message port closed before a response was received.")
    );
}

chrome.tabs.onUpdated.addListener(async function (tabId, changeInfo, tab) {
    if (
        !tab.url ||
        changeInfo.status !== "complete" ||
        !tab.url.startsWith("https://www.coursera.org/learn")
    ) {
        return;
    }

    const fullRunKey = `fullRunState:${tabId}`;
    const quizRunKey = `quizRunState:${tabId}`;
    chrome.storage.local.get([fullRunKey, quizRunKey], (result) => {
        const fullRunState = result[fullRunKey];
        const quizRunState = result[quizRunKey];

        const urlPath = new URL(tab.url).pathname;
        if (urlPath.endsWith("attempt") && !quizRunState?.active) {
            sendTabMessage(tabId, "attempt");
        }

        if (fullRunState && fullRunState.active && fullRunState.status !== "paused") {
            sendTabMessage(tabId, { type: "resumeMakeDoneAll" });
        }

        if (
            quizRunState &&
            quizRunState.active &&
            quizRunState.status !== "paused" &&
            !quizRunState.processing
        ) {
            sendTabMessage(tabId, { type: "resumeMakeQuizAll" });
        }
    });
});

chrome.runtime.onInstalled.addListener(function () {
    chrome.tabs.query({ url: "https://www.coursera.org/*" }, function (tabs) {
        tabs.forEach(function (tab) {
            chrome.tabs.reload(tab.id);
        });
    });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message && message.type === "getTabId") {
        sendResponse({ tabId: sender.tab ? sender.tab.id : null });
        return;
    }

    if (message && message.type === "captureVisibleTab") {
        const windowId = sender.tab ? sender.tab.windowId : undefined;
        try {
            chrome.tabs.query({ active: true, windowId }, (activeTabs) => {
                if (chrome.runtime.lastError || !sender.tab || activeTabs[0]?.id !== sender.tab.id) {
                    sendResponse({ ok: false, error: "Tab Coursera phải đang mở ở phía trước để chụp đúng câu hỏi." });
                    return;
                }
            chrome.tabs.captureVisibleTab(
                windowId,
                { format: message.format || "jpeg", quality: message.quality || 80 },
                (dataUrl) => {
                    if (chrome.runtime.lastError) {
                        sendResponse({ ok: false, error: chrome.runtime.lastError.message });
                    } else {
                        sendResponse({ ok: true, dataUrl });
                    }
                }
            );
            });
        } catch (err) {
            sendResponse({ ok: false, error: err.message });
        }
        return true;
    }

    if (message && message.type === "relayTabMessage") {
        if (!sender.tab || !sender.tab.id) {
            sendResponse({ ok: false, error: "Missing tab context." });
            return;
        }

        try {
            chrome.tabs.sendMessage(sender.tab.id, message.payload, () => {
                if (
                    chrome.runtime.lastError &&
                    !isIgnorableMessagePortError(chrome.runtime.lastError.message)
                ) {
                    console.log(
                        "Error relaying message to tab:",
                        chrome.runtime.lastError.message
                    );
                }
            });
            sendResponse({ ok: true, fireAndForget: true });
        } catch (error) {
            sendResponse({ ok: false, error: error.message });
        }
    }

    if (message && message.type === "fetchAi") {
        (async () => {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 28000);
            try {
                const fetchOptions = {
                    ...message.options,
                    signal: controller.signal,
                };
                const response = await fetch(message.url, fetchOptions);
                clearTimeout(timer);
                const body = await response.json().catch(() => ({}));
                sendResponse({
                    ok: response.ok,
                    status: response.status,
                    statusText: response.statusText,
                    body: body,
                });
            } catch (err) {
                clearTimeout(timer);
                const isAbort = err && err.name === "AbortError";
                sendResponse({
                    ok: false,
                    status: isAbort ? 504 : 0,
                    error: isAbort ? "AI request timed out (28s)." : (err && err.message) || "Fetch failed",
                });
            }
        })();
        return true;
    }

    if (message && message.type === "askGeminiWeb") {
        (async () => {
            try {
                const callerTabId = sender.tab ? sender.tab.id : null;
                const result = await handleAskGeminiWeb(message.prompt, message.options, callerTabId);
                sendResponse(result);
            } catch (err) {
                console.error("[AutoCoursera][Background] askGeminiWeb error:", err);
                sendResponse({
                    ok: false,
                    error: err.message || "Không thể lấy câu trả lời từ tab Gemini Web.",
                });
            }
        })();
        return true;
    }

    if (message && message.type === "openGeminiTab") {
        (async () => {
            try {
                const tab = await getOrCreateGeminiTab({ activate: true });
                sendResponse({ ok: true, tabId: tab.id });
            } catch (err) {
                sendResponse({ ok: false, error: err.message });
            }
        })();
        return true;
    }
});

function delayMs(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForTabComplete(tabId, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            chrome.tabs.onUpdated.removeListener(listener);
            resolve(); // timeout fallback
        }, timeoutMs);

        function listener(updatedTabId, changeInfo) {
            if (updatedTabId === tabId && changeInfo.status === "complete") {
                clearTimeout(timer);
                chrome.tabs.onUpdated.removeListener(listener);
                resolve();
            }
        }

        chrome.tabs.onUpdated.addListener(listener);
    });
}

async function getOrCreateGeminiTab(options = {}) {
    const tabs = await new Promise((resolve) => {
        chrome.tabs.query({ url: "*://gemini.google.com/*" }, resolve);
    });

    if (tabs && tabs.length > 0) {
        const tab = tabs[0];
        if (options.activate) {
            chrome.tabs.update(tab.id, { active: true });
        }
        return tab;
    }

    const newTab = await new Promise((resolve) => {
        chrome.tabs.create(
            {
                url: "https://gemini.google.com/app",
                active: options.activate !== false,
            },
            resolve
        );
    });

    if (newTab && newTab.id) {
        await waitForTabComplete(newTab.id, 20000);
        await delayMs(2500); // Allow Gemini SPA scripts to hydrate
    }

    return newTab;
}

async function pingGeminiTab(tabId, maxRetries = 6) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            const res = await new Promise((resolve, reject) => {
                chrome.tabs.sendMessage(tabId, { type: "PING_GEMINI" }, (response) => {
                    if (chrome.runtime.lastError) {
                        return reject(new Error(chrome.runtime.lastError.message));
                    }
                    resolve(response);
                });
            });

            if (res && res.isReady) {
                return res;
            }
        } catch (e) {
            // Wait and retry
            await delayMs(1000);
        }
    }
    return null;
}

async function handleAskGeminiWeb(prompt, options = {}, callerTabId = null) {
    if (!prompt) {
        throw new Error("Prompt câu hỏi không được để trống.");
    }

    console.log("[AutoCoursera][Background] Preparing Gemini Web tab for query...");
    const geminiTab = await getOrCreateGeminiTab({
        activate: options && options.activateTab === true,
    });

    if (!geminiTab || !geminiTab.id) {
        throw new Error("Không thể mở hoặc kết nối tới tab Gemini Web.");
    }

    const pingStatus = await pingGeminiTab(geminiTab.id, 7);
    if (!pingStatus) {
        throw new Error(
            "Script cầu nối trên tab Gemini chưa sẵn sàng. Hãy đảm bảo tab https://gemini.google.com/app đã được tải xong."
        );
    }

    if (pingStatus.loggedIn === false) {
        // Activate tab so user can log in
        chrome.tabs.update(geminiTab.id, { active: true });
        throw new Error(
            "Chưa đăng nhập Gemini: Vui lòng chuyển sang tab Gemini và đăng nhập tài khoản Google của bạn!"
        );
    }

    console.log("[AutoCoursera][Background] Sending prompt to Gemini Web tab id:", geminiTab.id);

    const result = await new Promise((resolve, reject) => {
        chrome.tabs.sendMessage(
            geminiTab.id,
            {
                type: "ASK_GEMINI",
                prompt,
                options: {
                    timeoutMs: (options && options.timeoutMs) || 120000,
                    screenshotUrls: options.screenshotUrls || [],
                },
            },
            (response) => {
                if (chrome.runtime.lastError) {
                    return reject(new Error(chrome.runtime.lastError.message));
                }
                if (!response) {
                    return reject(new Error("Không nhận được phản hồi từ tab Gemini."));
                }
                resolve(response);
            }
        );
    });

    // Optionally switch back to Coursera tab so user can see auto-filling
    if (callerTabId && options && options.activateTab === true) {
        try {
            chrome.tabs.update(callerTabId, { active: true });
        } catch (e) {
            // Ignore switch back error
        }
    }

    return result;
}
