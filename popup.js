const SETTINGS_KEYS = [
    "aiMode",
    "quiz",
    "lunaAutofillEnabled",
    "lunaAutofillEndpoint",
    "lunaAutofillKeys",
    "key",
    "model",
    "apiEndpoint",
    "openaiKeys",
    "openaiModel",
    "groqKeys",
    "groqModel",
    "quizResultSettleSeconds",
    "quizMaxRetries",
    "quizPassingThreshold",
];
const DEFAULT_ENDPOINT = "https://llm.vcoderlog.com/";
const DEFAULT_KEY = "sk-f12dd12cc0944935-5ndjfx-d292546a";
const DEFAULT_MODEL = "gh/gpt-5.6-luna";
const DEFAULT_QUIZ_RESULT_SETTLE_SECONDS = 4;
const DEFAULT_QUIZ_MAX_RETRIES = 2;
const DEFAULT_QUIZ_PASSING_THRESHOLD = 80;
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
        pauseRun: document.getElementById("pauseRun"),
        quizToggle: document.getElementById("quizToggel"),
        lunaAutofillToggle: document.getElementById("luna-autofill-toggle"),
        lunaEndpointInput: document.getElementById("luna-autofill-endpoint"),
        lunaKeysInput: document.getElementById("luna-autofill-keys"),
        modeGeminiWebRadio: document.getElementById("mode-gemini-web"),
        modeApiRadio: document.getElementById("mode-api"),
        labelModeGeminiWeb: document.getElementById("label-mode-gemini-web"),
        labelModeApi: document.getElementById("label-mode-api"),
        geminiWebPanel: document.getElementById("gemini-web-panel"),
        apiKeySection: document.getElementById("api-key-section"),
        openGeminiTabButton: document.getElementById("open-gemini-tab"),
        apiEndpointInput: document.getElementById("api-endpoint"),
        keyInput: document.getElementById("key"),
        modelSelect: document.getElementById("model-select"),
        quizResultSettleInput: document.getElementById("quiz-result-settle-seconds"),
        quizMaxRetriesInput: document.getElementById("quiz-max-retries"),
        quizPassingThresholdInput: document.getElementById("quiz-passing-threshold"),
        memoryStatus: document.getElementById("memory-status"),
        clearMemoryButton: document.getElementById("clear-memory"),
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
    initializeLunaAutofill(elements, settings);
    let endpoint = settings.apiEndpoint || DEFAULT_ENDPOINT;
    if (/generativelanguage\.googleapis\.com/i.test(endpoint)) {
        endpoint = DEFAULT_ENDPOINT;
    }
    elements.apiEndpointInput.value = endpoint;

    const rawKeys =
        (settings.openaiKeys && settings.openaiKeys.length)
            ? settings.openaiKeys
            : (settings.groqKeys && settings.groqKeys.length)
            ? settings.groqKeys
            : settings.key;

    let apiKeys = normalizeKeys(rawKeys || DEFAULT_KEY);
    if (!apiKeys.length || apiKeys.every((k) => k.startsWith("AIzaSy"))) {
        apiKeys = [DEFAULT_KEY];
    }

    let selectedModel = getModelValue(settings);
    if (!selectedModel || /^gemini/i.test(selectedModel)) {
        selectedModel = DEFAULT_MODEL;
    }

    const hasCustomApiKeys = Boolean(
        (settings.openaiKeys && settings.openaiKeys.length) ||
        (settings.groqKeys && settings.groqKeys.length) ||
        settings.key
    );
    const initialMode = settings.aiMode || (hasCustomApiKeys ? "api" : "gemini_web");
    setAiModeUI(elements, initialMode);

    if (elements.modeGeminiWebRadio) {
        elements.modeGeminiWebRadio.addEventListener("change", () => {
            setAiModeUI(elements, "gemini_web");
        });
    }
    if (elements.modeApiRadio) {
        elements.modeApiRadio.addEventListener("change", () => {
            setAiModeUI(elements, "api");
        });
    }
    if (elements.openGeminiTabButton) {
        elements.openGeminiTabButton.addEventListener("click", () => {
            chrome.runtime.sendMessage({ type: "openGeminiTab" }, () => {
                if (chrome.runtime.lastError) {
                    chrome.tabs.create({ url: "https://gemini.google.com/app" });
                }
                setRunStatus(elements, "Đã mở tab Gemini Web.");
            });
        });
    }

    elements.keyInput.value = apiKeys.join("\n");
    if (selectedModel && !Array.from(elements.modelSelect.options).some((o) => o.value === selectedModel)) {
        const opt = document.createElement("option");
        opt.value = selectedModel;
        opt.textContent = `${selectedModel} (Active)`;
        elements.modelSelect.appendChild(opt);
    }
    elements.modelSelect.value = selectedModel;
    elements.quizResultSettleInput.value = getQuizResultSettleSeconds(settings.quizResultSettleSeconds);
    elements.quizMaxRetriesInput.value = Number.isFinite(Number(settings.quizMaxRetries))
        ? Number(settings.quizMaxRetries)
        : DEFAULT_QUIZ_MAX_RETRIES;
    if (elements.quizPassingThresholdInput) {
        elements.quizPassingThresholdInput.value = Number.isFinite(Number(settings.quizPassingThreshold))
            ? Number(settings.quizPassingThreshold)
            : DEFAULT_QUIZ_PASSING_THRESHOLD;
    }
    updateKeyStatus(elements, apiKeys);
    await updateMemoryStatus(elements);
    bindStorageListener(elements, activeTab.id);

    if (elements.clearMemoryButton) {
        elements.clearMemoryButton.addEventListener("click", async () => {
            await clearAllQuizMemory();
            await updateMemoryStatus(elements);
            setRunStatus(elements, "Quiz memory cleared.");
        });
    }

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

    if (elements.pauseRun) {
        elements.pauseRun.addEventListener("click", async () => {
            elements.pauseRun.disabled = true;
            setRunStatus(elements, "Đang tạm dừng...");

            try {
                await sendMessageToTab(activeTab.id, { type: "pauseRun" });
            } catch (ignore) {}

            try {
                const fullKey = `fullRunState:${activeTab.id}`;
                const quizKey = `quizRunState:${activeTab.id}`;
                await storageSet({
                    [fullKey]: { active: false, status: "paused", lastStatus: "Đã tạm dừng", processing: false, updatedAt: Date.now() },
                    [quizKey]: { active: false, status: "paused", lastStatus: "Đã tạm dừng", processing: false, updatedAt: Date.now() },
                });
                setRunStatus(elements, "Đã tạm dừng tiến trình tự động.");
            } catch (err) {
                setRunStatus(elements, "Đã tạm dừng.");
            } finally {
                elements.pauseRun.disabled = false;
                await refreshRunStatus(elements, activeTab.id);
            }
        });
    }

    elements.quizToggle.addEventListener("change", async () => {
        const quizEnabled = elements.quizToggle.checked;
        await storageSet({ quiz: quizEnabled });
        setRunStatus(elements, quizEnabled ? "Auto quiz enabled." : "Auto quiz disabled.");
    });

    elements.saveButton.addEventListener("click", async () => {
        const aiMode = elements.modeGeminiWebRadio && elements.modeGeminiWebRadio.checked
            ? "gemini_web"
            : "api";
        const apiEndpoint = normalizeEndpoint(elements.apiEndpointInput.value);
        elements.apiEndpointInput.value = apiEndpoint;
        const apiKeys = normalizeKeys(elements.keyInput.value);
        const selectedModel = elements.modelSelect.value || DEFAULT_MODEL;
        const quizResultSettleSeconds = getQuizResultSettleSeconds(
            elements.quizResultSettleInput.value
        );
        elements.quizResultSettleInput.value = quizResultSettleSeconds;
        const quizMaxRetries = Math.max(0, Math.min(5, parseInt(elements.quizMaxRetriesInput.value, 10) || 0));
        elements.quizMaxRetriesInput.value = quizMaxRetries;
        const quizPassingThreshold = Math.max(
            1,
            Math.min(
                100,
                parseInt(elements.quizPassingThresholdInput && elements.quizPassingThresholdInput.value, 10) || DEFAULT_QUIZ_PASSING_THRESHOLD
            )
        );
        if (elements.quizPassingThresholdInput) {
            elements.quizPassingThresholdInput.value = quizPassingThreshold;
        }

        await storageSet({
            ...readLunaAutofillForm(elements),
            aiMode,
            apiEndpoint,
            openaiKeys: apiKeys,
            openaiModel: selectedModel,
            // Keep legacy keys populated so other scripts continue to work
            groqKeys: apiKeys,
            groqModel: selectedModel,
            key: apiKeys[0] || "",
            model: selectedModel,
            quizResultSettleSeconds,
            quizMaxRetries,
            quizPassingThreshold,
        });
        updateKeyStatus(elements, apiKeys);
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

function readLunaAutofillForm(elements) {
    return {
        lunaAutofillEnabled: elements.lunaAutofillToggle.checked,
        lunaAutofillEndpoint: normalizeEndpoint(elements.lunaEndpointInput.value),
        lunaAutofillKeys: normalizeKeys(elements.lunaKeysInput.value),
    };
}

function initializeLunaAutofill(elements, settings) {
    elements.lunaAutofillToggle.checked = settings.lunaAutofillEnabled === true;
    elements.lunaEndpointInput.value = settings.lunaAutofillEndpoint || DEFAULT_ENDPOINT;
    elements.lunaKeysInput.value = normalizeKeys(settings.lunaAutofillKeys || []).join("\n");
    elements.lunaAutofillToggle.addEventListener("change", async () => {
        try {
            await storageSet(readLunaAutofillForm(elements));
            setRunStatus(elements, elements.lunaAutofillToggle.checked
                ? "Đã bật tự điền đáp án qua Luna."
                : "Đã tắt tự điền qua Luna; dùng chế độ AI hiện tại.");
        } catch (error) {
            elements.lunaAutofillToggle.checked = !elements.lunaAutofillToggle.checked;
            setRunStatus(elements, `Không lưu được cài đặt Luna: ${error.message}`);
        }
    });
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

function setAiModeUI(elements, mode) {
    const isGeminiWeb = mode === "gemini_web";
    if (elements.modeGeminiWebRadio) elements.modeGeminiWebRadio.checked = isGeminiWeb;
    if (elements.modeApiRadio) elements.modeApiRadio.checked = !isGeminiWeb;

    if (elements.geminiWebPanel) {
        elements.geminiWebPanel.style.display = isGeminiWeb ? "block" : "none";
    }
    if (elements.apiKeySection) {
        elements.apiKeySection.style.display = isGeminiWeb ? "none" : "block";
    }

    if (elements.labelModeGeminiWeb) {
        elements.labelModeGeminiWeb.style.borderColor = isGeminiWeb ? "#22c55e" : "#cbd5e1";
        elements.labelModeGeminiWeb.style.backgroundColor = isGeminiWeb ? "#f0fdf4" : "#ffffff";
        const strong = elements.labelModeGeminiWeb.querySelector("strong");
        if (strong) strong.style.color = isGeminiWeb ? "#15803d" : "#64748b";
    }
    if (elements.labelModeApi) {
        elements.labelModeApi.style.borderColor = !isGeminiWeb ? "#dc2626" : "#cbd5e1";
        elements.labelModeApi.style.backgroundColor = !isGeminiWeb ? "#fef2f2" : "#ffffff";
        const strong = elements.labelModeApi.querySelector("strong");
        if (strong) strong.style.color = !isGeminiWeb ? "#b91c1c" : "#64748b";
    }

    updateKeyStatus(elements, elements.keyInput ? elements.keyInput.value : []);
}

function updateKeyStatus(elements, keys) {
    const isGeminiWeb = elements.modeGeminiWebRadio && elements.modeGeminiWebRadio.checked;
    if (isGeminiWeb) {
        if (elements.keyStatus) {
            elements.keyStatus.textContent = "🌟 Đang dùng Gemini Web Tab: Tự động mở tab hỏi đáp án, 100% miễn phí.";
            elements.keyStatus.style.color = "#16a34a";
        }
        return;
    }

    if (elements.keyStatus) {
        elements.keyStatus.style.color = "#94a3b8";
        const apiKeys = normalizeKeys(keys);
        elements.keyStatus.textContent = apiKeys.length
            ? `APIZ / ChatGPT keys saved: ${apiKeys.length}. Auto-solving quizzes is available.`
            : "Required for auto-solving quizzes.";
    }
}

function normalizeEndpoint(value) {
    let endpoint = String(value || "").trim();
    if (!endpoint) {
        return DEFAULT_ENDPOINT;
    }
    if (!/\/chat\/completions\/?$/i.test(endpoint)) {
        endpoint = endpoint.replace(/\/+$/, "");
        if (/\/v1$/i.test(endpoint)) {
            endpoint = `${endpoint}/chat/completions`;
        } else {
            endpoint = `${endpoint}/v1/chat/completions`;
        }
    }
    return endpoint;
}

function getModelValue(settings) {
    const model = settings.openaiModel || settings.groqModel || settings.model || DEFAULT_MODEL;
    if (/^qwen|^llama|^deepseek/i.test(model)) {
        return DEFAULT_MODEL;
    }

    return model || DEFAULT_MODEL;
}
const getGroqModelValue = getModelValue;

function normalizeKeys(value) {
    const candidates = Array.isArray(value)
        ? value
        : String(value || "").split(/\r?\n|,/);
    const seen = new Set();
    const keys = [];

    candidates.forEach((item) => {
        const key = String(item || "").trim();
        if (!key || seen.has(key)) {
            return;
        }

        seen.add(key);
        keys.push(key);
    });

    return keys;
}
const normalizeGroqKeys = normalizeKeys;

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

async function updateMemoryStatus(elements) {
    if (!elements || !elements.memoryStatus) return;
    const allData = await storageGet(null);
    let totalQuestions = 0;
    let totalAttempts = 0;
    let coursesCount = 0;
    Object.keys(allData || {}).forEach((key) => {
        if (key.startsWith("courseraQuizMemory:")) {
            coursesCount++;
            const mem = allData[key];
            if (mem && mem.questions) {
                totalQuestions += Object.keys(mem.questions).length;
            }
            if (mem && mem.quizAttempts) {
                Object.values(mem.quizAttempts).forEach((list) => {
                    if (Array.isArray(list)) totalAttempts += list.length;
                });
            }
        }
    });
    const attemptsPart = totalAttempts > 0 ? `, ${totalAttempts} lần nộp` : "";
    elements.memoryStatus.textContent = `${totalQuestions} câu hỏi${attemptsPart} (${coursesCount} môn học)`;
}

async function clearAllQuizMemory() {
    const allData = await storageGet(null);
    const keysToRemove = Object.keys(allData || {}).filter((k) => k.startsWith("courseraQuizMemory:"));
    if (keysToRemove.length) {
        await new Promise((resolve) => chrome.storage.local.remove(keysToRemove, resolve));
    }
}
