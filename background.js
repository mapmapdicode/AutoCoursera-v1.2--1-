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
    chrome.storage.local.get([fullRunKey, quizRunKey, "quiz"], (result) => {
        const fullRunState = result[fullRunKey];
        const quizRunState = result[quizRunKey];

        const urlPath = new URL(tab.url).pathname;
        if (result.quiz === true && urlPath.endsWith("attempt") && !quizRunState?.active && !fullRunState?.active &&
            quizRunState?.status !== "paused" && fullRunState?.status !== "paused") {
            sendTabMessage(tabId, {type: "solveChatGPTQuiz"});
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
    if (["startChatGPTJob", "getChatGPTJob", "releaseChatGPTJob", "chatGPTJobResult", "openChatGPTTab"].includes(message?.type)) {
        handleChatGPTMessage(message, sender).then(sendResponse, (error) => sendResponse({ok: false, error: error.message}));
        return true;
    }
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

// Session storage survives MV3 worker suspension. Each message below is short;
// the content script owns the long-running UI interaction and reports completion.
const chatgptJobStorage = chrome.storage.session || chrome.storage.local;
let chatgptMutationQueue = Promise.resolve();
const sessionGet = (keys) => new Promise((resolve) => chatgptJobStorage.get(keys, resolve));
const sessionSet = (values) => new Promise((resolve) => chatgptJobStorage.set(values, resolve));
const sessionRemove = (keys) => new Promise((resolve) => chatgptJobStorage.remove(keys, resolve));
function serializeChatGPTMutation(action) {
    const pending = chatgptMutationQueue.then(action);
    chatgptMutationQueue = pending.catch(() => {});
    return pending;
}
function chatGPTTabMessage(tabId, message) {
    return new Promise((resolve, reject) => chrome.tabs.sendMessage(tabId, message, (result) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else if (!result || result.ok === false) reject(new Error(result?.error || "CHATGPT_CONNECTION_LOST"));
        else resolve(result);
    }));
}
async function getOrCreateChatGPTTab({activate = false, assignmentKey} = {}) {
    const saved = (await sessionGet(["chatgptWebTab"])).chatgptWebTab;
    if (saved?.id) {
        const tab = await new Promise((resolve) => chrome.tabs.get(saved.id, (result) => {
            if (chrome.runtime.lastError) resolve(null); else resolve(result);
        }));
        if (tab && new URL(tab.url).hostname === "chatgpt.com") {
            if (assignmentKey !== undefined && saved.assignmentKey !== assignmentKey) {
                const status = await chatGPTTabMessage(tab.id, {type: "PING_CHATGPT"});
                if (status.busy || status.hasDraft) throw new Error("CHATGPT_BUSY: Tab có phản hồi hoặc bản nháp chưa hoàn tất.");
                await new Promise((resolve) => chrome.tabs.update(tab.id, {url: "https://chatgpt.com/", active: activate}, resolve));
                await waitForTabComplete(tab.id);
                await sessionSet({chatgptWebTab: {id: tab.id, assignmentKey}});
            } else if (activate) chrome.tabs.update(tab.id, {active: true});
            return tab;
        }
    }
    // A dedicated tab shares browser login but does not overwrite personal chats.
    const tab = await new Promise((resolve, reject) => chrome.tabs.create({url: "https://chatgpt.com/", active: activate}, (result) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message)); else resolve(result);
    }));
    if (!tab?.id) throw new Error("CHATGPT_TAB_UNAVAILABLE");
    await sessionSet({chatgptWebTab: {id: tab.id, assignmentKey: assignmentKey || ""}});
    if (tab.status !== "complete") await waitForTabComplete(tab.id);
    return tab;
}
async function dispatchChatGPTJob(job, prompt, options) {
    try {
        const tab = await getOrCreateChatGPTTab({assignmentKey: options.assignmentKey || ""});
        let status;
        for (let index = 0; index < 12; index++) {
            try {status = await chatGPTTabMessage(tab.id, {type: "PING_CHATGPT"}); if (status.isReady) break;} catch (_) {}
            await delayMs(500);
        }
        if (!status?.isReady) throw new Error("CHATGPT_BRIDGE_UNAVAILABLE: Reload extension rồi mở lại tab ChatGPT.");
        if (!status.loggedIn) {
            chrome.tabs.update(tab.id, {active: true});
            throw new Error("NOT_LOGGED_IN: Đăng nhập ChatGPT Pro trong tab vừa mở rồi chạy lại.");
        }
        if (status.busy || status.hasDraft) throw new Error("CHATGPT_BUSY: Tab có phản hồi hoặc tin nhắn chưa gửi.");
        await serializeChatGPTMutation(async () => {
            const current = (await sessionGet([`chatgptJob:${job.requestId}`]))[`chatgptJob:${job.requestId}`];
            if (!current || current.status !== "preparing") throw new Error("CHATGPT_CANCELLED");
            job = {...current, chatTabId: tab.id, status: "running"};
            await sessionSet({[`chatgptJob:${job.requestId}`]: job});
        });
        await chatGPTTabMessage(tab.id, {type: "START_CHATGPT_JOB", requestId: job.requestId, prompt,
            options: {...options, timeoutMs: job.timeoutMs, reasoningEffort: options.mode === "fast" ? "min" : "max"}});
    } catch (error) {
        await serializeChatGPTMutation(async () => {
            const key = `chatgptJob:${job.requestId}`;
            const current = (await sessionGet([key]))[key];
            if (current) await sessionSet({[key]: {...current, status: "failed", error: error.message}});
        });
    }
}
async function handleChatGPTMessage(message, sender) {
    if (sender.id !== chrome.runtime.id) throw new Error("CHATGPT_ACCESS_DENIED");
    if (message.type === "openChatGPTTab") {
        const tab = await getOrCreateChatGPTTab({activate: true});
        return {ok: true, tabId: tab.id};
    }
    if (message.type === "startChatGPTJob") {
        if (!sender.tab || !/^https:\/\/(www\.)?coursera\.org\/learn\//.test(sender.tab.url || "")) throw new Error("CHATGPT_ACCESS_DENIED");
        if (typeof message.prompt !== "string" || !message.prompt.trim()) throw new Error("EMPTY_PROMPT");
        const options = {...message.options, mode: message.options?.mode === "fast" ? "fast" : "pro"};
        const job = await serializeChatGPTMutation(async () => {
            const activeId = (await sessionGet(["chatgptActiveJob"])).chatgptActiveJob;
            const active = activeId ? (await sessionGet([`chatgptJob:${activeId}`]))[`chatgptJob:${activeId}`] : null;
            if (active && ["preparing", "running"].includes(active.status) && active.expiresAt > Date.now()) throw new Error("CHATGPT_BUSY: Một bài khác đang chờ AI trả lời.");
            if (activeId) await sessionRemove([`chatgptJob:${activeId}`, "chatgptActiveJob"]);
            const requestId = crypto.randomUUID();
            const timeoutMs = options.mode === "fast" ? 300000 : 1800000;
            const result = {requestId, callerTabId: sender.tab.id, chatTabId: null, status: "preparing", createdAt: Date.now(),
                timeoutMs, expiresAt: Date.now() + timeoutMs + 45000};
            await sessionSet({chatgptActiveJob: requestId, [`chatgptJob:${requestId}`]: result});
            return result;
        });
        void dispatchChatGPTJob(job, message.prompt, options);
        return {ok: true, requestId: job.requestId};
    }
    return serializeChatGPTMutation(async () => {
        const key = `chatgptJob:${message.requestId}`;
        let job = (await sessionGet([key]))[key];
        if (!job) throw new Error("CHATGPT_JOB_NOT_FOUND: Không tự gửi lại để tránh trùng câu hỏi.");
        if (message.type === "chatGPTJobResult") {
            if (sender.tab?.id !== job.chatTabId || !/^https:\/\/chatgpt\.com\//.test(sender.tab.url || "") || job.status !== "running") throw new Error("CHATGPT_ACCESS_DENIED");
            const complete = message.ok === true && typeof message.text === "string" && Boolean(message.text.trim()) && Date.now() < job.expiresAt;
            await sessionSet({[key]: {...job, status: complete ? "complete" : "failed", text: complete ? message.text : undefined,
                error: complete ? undefined : message.error || "CHATGPT_RESPONSE_INCOMPLETE"}});
            return {ok: true};
        }
        if (sender.tab?.id !== job.callerTabId) throw new Error("CHATGPT_ACCESS_DENIED");
        if (message.type === "releaseChatGPTJob") {
            if (["running", "preparing"].includes(job.status) && job.chatTabId) {
                void chatGPTTabMessage(job.chatTabId, {type: "CANCEL_CHATGPT_JOB", requestId: job.requestId}).catch(() => {});
            }
            await sessionRemove([key]);
            if ((await sessionGet(["chatgptActiveJob"])).chatgptActiveJob === job.requestId) await sessionRemove(["chatgptActiveJob"]);
            return {ok: true};
        }
        if (Date.now() >= job.expiresAt || (job.status === "preparing" && Date.now() - job.createdAt > 45000)) {
            job = {...job, status: "failed", text: undefined, error: "CHATGPT_TIMEOUT: AI chưa hoàn tất; không sử dụng đáp án một phần."};
            await sessionSet({[key]: job});
        }
        return {ok: true, status: job.status, text: job.status === "complete" ? job.text : undefined, error: job.error};
    });
}
