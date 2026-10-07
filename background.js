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
});
