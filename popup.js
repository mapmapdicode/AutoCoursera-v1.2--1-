const SETTINGS_KEYS = ["quiz", "key", "model", "quizResultSettleSeconds"];
const DEFAULT_MODEL = "gemini-2.5-flash";
const DEFAULT_QUIZ_RESULT_SETTLE_SECONDS = 4;
const LOG_PREVIEW_LIMIT = 18;
const {
    describeRunnerLogEntry,
    formatRunnerLogExport,
    normalizeQuizResultSettleSeconds,
} = window.CourseRunnerHelpers || {};

document.addEventListener("DOMContentLoaded", () => {
    const elements = {
        bypass: document.getElementById("bypass"),
        autoQuiz: document.getElementById("autoQuiz"),
        makeDoneAll: document.getElementById("makeDoneAll"),
        makeQuizAll: document.getElementById("makeQuizAll"),
        quizToggle: document.getElementById("quizToggel"),
        keyInput: document.getElementById("key"),
        modelSelect: document.getElementById("model-select"),
        quizResultSettleInput: document.getElementById("quiz-result-settle-seconds"),
        saveButton: document.getElementById("save"),
        exportLogsButton: document.getElementById("export-logs"),
        keyStatus: document.getElementById("key-status"),
        runStatus: document.getElementById("run-status"),
        runLog: document.getElementById("run-log"),
    };

    initializePopup(elements).catch((error) => {
        console.error("Failed to initialize popup:", error);
        setRunStatus(elements, "Unable to load popup state.");
    });
});

async function initializePopup(elements) {
    const settings = await storageGet(SETTINGS_KEYS);
    const activeTab = await getActiveTab();

    elements.quizToggle.checked = Boolean(settings.quiz);
    elements.keyInput.value = settings.key || "";
    elements.modelSelect.value = settings.model || DEFAULT_MODEL;
    elements.quizResultSettleInput.value = getQuizResultSettleSeconds(settings.quizResultSettleSeconds);
    updateKeyStatus(elements, settings.key);
    bindStorageListener(elements, activeTab.id);

    elements.bypass.addEventListener("click", async () => {
        await sendMessageToTab(activeTab.id, "bypass");
        setRunStatus(elements, "Partial course action sent.");
    });

    elements.autoQuiz.addEventListener("click", async () => {
        await sendMessageToTab(activeTab.id, "attempt");
        setRunStatus(elements, "Quiz solve action sent.");
    });

    elements.makeDoneAll.addEventListener("click", async () => {
        elements.makeDoneAll.disabled = true;
        setRunStatus(elements, "Running...");

        try {
            await sendMessageToTab(activeTab.id, {
                type: "makeDoneAll",
                startFrom: "firstIncomplete",
                skipUnsupported: true,
                includeQuizzesWhenPossible: true,
            });
        } catch (error) {
            console.error("Failed to start full run:", error);
            setRunStatus(elements, error.message || "Failed to start.");
        } finally {
            elements.makeDoneAll.disabled = false;
            await refreshRunStatus(elements, activeTab.id);
        }
    });

    elements.makeQuizAll.addEventListener("click", async () => {
        elements.makeQuizAll.disabled = true;
        setRunStatus(elements, "Running quizzes...");

        try {
            await sendMessageToTab(activeTab.id, {
                type: "makeQuizAll",
                startFrom: "firstIncompleteQuiz",
                skipOnFailure: true,
            });
        } catch (error) {
            console.error("Failed to start quiz run:", error);
            setRunStatus(elements, error.message || "Failed to start.");
        } finally {
            elements.makeQuizAll.disabled = false;
            await refreshRunStatus(elements, activeTab.id);
        }
    });

    elements.quizToggle.addEventListener("change", async () => {
        const quizEnabled = elements.quizToggle.checked;
        await storageSet({ quiz: quizEnabled });
        setRunStatus(elements, quizEnabled ? "Auto quiz enabled." : "Auto quiz disabled.");
    });

    elements.saveButton.addEventListener("click", async () => {
        const key = elements.keyInput.value.trim();
        const model = elements.modelSelect.value || DEFAULT_MODEL;
        const quizResultSettleSeconds = getQuizResultSettleSeconds(
            elements.quizResultSettleInput.value
        );
        elements.quizResultSettleInput.value = quizResultSettleSeconds;

        await storageSet({ key, model, quizResultSettleSeconds });
        updateKeyStatus(elements, key);
        elements.saveButton.classList.add("saved");
        setRunStatus(elements, "Settings saved.");

        setTimeout(() => {
            elements.saveButton.classList.remove("saved");
        }, 2000);
    });

    elements.exportLogsButton.addEventListener("click", async () => {
        try {
            const storageKey = `runnerLogs:${activeTab.id}`;
            const storageResult = await storageGet([storageKey]);
            const entries = storageResult[storageKey] || [];

            if (!entries.length) {
                setRunStatus(elements, "No logs available.");
                return;
            }

            const content = formatRunnerLogExport
                ? formatRunnerLogExport(entries)
                : entries.map((entry) => entry.message || "").join("\n");
            const courseSlug = getCourseSlugFromTab(activeTab.url);
            await downloadLogsFile(content, courseSlug);
            setRunStatus(elements, "Logs exported.");
        } catch (error) {
            console.error("Failed to export logs:", error);
            setRunStatus(elements, error.message || "Failed to export logs.");
        }
    });

    await refreshRunStatus(elements, activeTab.id);
    await refreshRunLogs(elements, activeTab.id);
}

function getQuizResultSettleSeconds(value) {
    if (typeof normalizeQuizResultSettleSeconds === "function") {
        return normalizeQuizResultSettleSeconds(
            value,
            DEFAULT_QUIZ_RESULT_SETTLE_SECONDS
        );
    }

    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        return DEFAULT_QUIZ_RESULT_SETTLE_SECONDS;
    }

    return Math.min(120, Math.max(1, Math.round(parsed)));
}

async function refreshRunStatus(elements, tabId) {
    const fullRunKey = `fullRunState:${tabId}`;
    const quizRunKey = `quizRunState:${tabId}`;
    const stateResult = await storageGet([fullRunKey, quizRunKey]);
    const quizRunState = stateResult[quizRunKey];
    const fullRunState = stateResult[fullRunKey];
    const runState =
        quizRunState && quizRunState.active ? quizRunState : fullRunState;

    if (!runState || !runState.active) {
        setRunStatus(elements, "");
        return;
    }

    const statusLabel = runState.lastStatus || runState.status || "Running";
    setRunStatus(elements, statusLabel);
}

async function refreshRunLogs(elements, tabId) {
    const storageKey = `runnerLogs:${tabId}`;
    const result = await storageGet([storageKey]);
    renderRunLogs(elements, result[storageKey] || []);
}

function updateKeyStatus(elements, key) {
    elements.keyStatus.textContent = key
        ? "Gemini API key saved. Auto-solving quizzes is available."
        : "Required for auto-solving quizzes.";
}

function setRunStatus(elements, message) {
    elements.runStatus.textContent = message || "";
}

function renderRunLogs(elements, entries) {
    const latestEntries = Array.isArray(entries)
        ? entries.slice(-LOG_PREVIEW_LIMIT)
        : [];

    if (!latestEntries.length) {
        elements.runLog.className = "log-panel empty";
        elements.runLog.textContent = "No logs yet.";
        return;
    }

    elements.runLog.className = "log-panel";
    elements.runLog.innerHTML = "";
    latestEntries.forEach((entry) => appendLogNode(elements.runLog, entry));
    elements.runLog.scrollTop = elements.runLog.scrollHeight;
}

function bindStorageListener(elements, tabId) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== "local") {
            return;
        }

        const logKey = `runnerLogs:${tabId}`;
        const fullRunKey = `fullRunState:${tabId}`;
        const quizRunKey = `quizRunState:${tabId}`;

        if (changes[logKey]) {
            const oldEntries = Array.isArray(changes[logKey].oldValue)
                ? changes[logKey].oldValue
                : [];
            const newEntries = Array.isArray(changes[logKey].newValue)
                ? changes[logKey].newValue
                : [];
            appendLogChanges(elements, oldEntries, newEntries);
        }

        if (changes[fullRunKey] || changes[quizRunKey]) {
            refreshRunStatus(elements, tabId).catch((error) => {
                console.error("Failed to refresh popup status:", error);
            });
        }
    });
}

function appendLogChanges(elements, oldEntries, newEntries) {
    const latestEntries = newEntries.slice(-LOG_PREVIEW_LIMIT);

    if (!latestEntries.length) {
        renderRunLogs(elements, []);
        return;
    }

    const oldLatestEntries = oldEntries.slice(-LOG_PREVIEW_LIMIT);
    const canAppend =
        oldLatestEntries.length > 0 &&
        latestEntries.length >= oldLatestEntries.length &&
        latestEntries
            .slice(0, oldLatestEntries.length)
            .every((entry, index) => hasSameLogEntry(entry, oldLatestEntries[index]));

    if (!canAppend) {
        renderRunLogs(elements, latestEntries);
        return;
    }

    if (elements.runLog.classList.contains("empty")) {
        elements.runLog.className = "log-panel";
        elements.runLog.innerHTML = "";
    }

    latestEntries.slice(oldLatestEntries.length).forEach((entry) => {
        appendLogNode(elements.runLog, entry);
    });

    elements.runLog.scrollTop = elements.runLog.scrollHeight;
}

function appendLogNode(container, entry) {
    const line = document.createElement("div");
    line.className = `log-line ${normalizeLogLevel(entry.level)}`.trim();

    const timeNode = document.createElement("span");
    timeNode.className = "log-time";
    timeNode.textContent = formatLogTimestamp(entry.timestamp);

    const textNode = document.createElement("span");
    textNode.textContent = describeRunnerLogEntry
        ? describeRunnerLogEntry(entry)
        : entry.message || "";

    line.appendChild(timeNode);
    line.appendChild(textNode);
    container.appendChild(line);
}

function hasSameLogEntry(left, right) {
    if (!left || !right) {
        return false;
    }

    return (
        left.timestamp === right.timestamp &&
        left.eventName === right.eventName &&
        left.message === right.message
    );
}

function normalizeLogLevel(level) {
    const value = String(level || "info").toLowerCase();
    if (value === "error") {
        return "error";
    }

    if (value === "warn" || value === "warning") {
        return "warn";
    }

    return "info";
}

function getActiveTab() {
    return new Promise((resolve, reject) => {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            const tab = tabs && tabs[0];
            if (!tab || !tab.id) {
                reject(new Error("Open a Coursera tab first."));
                return;
            }

            resolve(tab);
        });
    });
}

function sendMessageToTab(tabId, payload) {
    return new Promise((resolve, reject) => {
        chrome.tabs.sendMessage(tabId, payload, (response) => {
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
                return;
            }

            resolve(response || { ok: true });
        });
    });
}

function storageGet(keys) {
    return new Promise((resolve) => {
        chrome.storage.local.get(keys, resolve);
    });
}

function storageSet(values) {
    return new Promise((resolve) => {
        chrome.storage.local.set(values, resolve);
    });
}

function downloadLogsFile(content, courseSlug) {
    return new Promise((resolve, reject) => {
        const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
        const blobUrl = URL.createObjectURL(blob);
        const filename = `autocoursera-logs-${courseSlug || "course"}-${Date.now()}.log`;

        chrome.downloads.download(
            {
                url: blobUrl,
                filename,
                conflictAction: "uniquify",
                saveAs: false,
            },
            (downloadId) => {
                URL.revokeObjectURL(blobUrl);

                if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message));
                    return;
                }

                if (!downloadId) {
                    reject(new Error("Unable to create log download."));
                    return;
                }

                resolve(downloadId);
            }
        );
    });
}

function getCourseSlugFromTab(url) {
    try {
        const pathname = new URL(url).pathname;
        const match = pathname.match(/^\/learn\/([^/]+)/);
        return match ? match[1] : "";
    } catch (error) {
        return "";
    }
}

function formatLogTimestamp(timestamp) {
    const date = timestamp ? new Date(timestamp) : new Date();
    return date.toLocaleTimeString("en-GB", {
        hour12: false,
    });
}
