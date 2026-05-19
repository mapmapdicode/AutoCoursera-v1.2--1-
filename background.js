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

        if (fullRunState && fullRunState.active) {
            sendTabMessage(tabId, { type: "resumeMakeDoneAll" });
        }

        if (
            quizRunState &&
            quizRunState.active &&
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
});
