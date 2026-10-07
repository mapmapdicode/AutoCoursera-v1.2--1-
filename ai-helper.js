/**
 * APIZ / ChatGPT Luna (OpenAI-compatible)-backed AI helper.
 *
 * The class name stays GeminiAI because the legacy obfuscated content script
 * instantiates window.GeminiAI directly.
 */
class GeminiAI {
    constructor(apiKey = "", model = "", dependencies = {}) {
        this.apiKey = apiKey;
        this.model = model || GeminiAI.DEFAULT_CHATGPT_MODEL;
        this.fetchImpl = dependencies.fetch || getBoundGlobalFetch();
        this.storage = dependencies.storage || (globalThis.chrome && chrome.storage);
        this.apiEndpoint = dependencies.endpoint || GeminiAI.DEFAULT_API_ENDPOINT;
    }

    async generateResponse(prompt, options = {}) {
        const settings = await this.readSettings();
        const keys = settings.apiKeys;

        if (!keys.length) {
            throw new Error("APIZ / ChatGPT API Key is missing.");
        }

        if (typeof this.fetchImpl !== "function") {
            throw new Error("Fetch API is not available.");
        }

        const endpoint = options.endpoint || settings.apiEndpoint || this.apiEndpoint || GeminiAI.DEFAULT_API_ENDPOINT;
        const model = options.model || settings.model || this.model || GeminiAI.DEFAULT_CHATGPT_MODEL;
        const startIndex = normalizeKeyCursor(settings.keyCursor, keys);
        let lastError = null;
        let rateLimitRetries = 0;

        for (let offset = 0; offset < keys.length; offset += 1) {
            const keyIndex = (startIndex + offset) % keys.length;
            const apiKey = keys[keyIndex];

            try {
                const requestPayload = {
                    method: "POST",
                    headers: {
                        Authorization: `Bearer ${apiKey}`,
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify(
                        GeminiAI.buildRequestBody(prompt, model, options)
                    ),
                };

                const { response, body } = await executeFetch(
                    this.fetchImpl,
                    endpoint,
                    requestPayload
                );
                if (!response.ok) {
                    const message =
                        body.error && body.error.message
                            ? body.error.message
                            : `AI API request failed with status ${response.status}`;
                    lastError = new Error(message);
                    logAiEvent("request_failed", {
                        status: response.status,
                        keyIndex,
                        message,
                    });

                    if (isRateLimitResponse(response, body)) {
                        if (keys.length > 1) {
                            await this.persistKeyCursor((keyIndex + 1) % keys.length);
                            logAiEvent("key_rotated", {
                                fromKeyIndex: keyIndex,
                                toKeyIndex: (keyIndex + 1) % keys.length,
                                totalKeys: keys.length,
                            });
                            continue;
                        } else if (rateLimitRetries < 2) {
                            rateLimitRetries += 1;
                            logAiEvent("rate_limit_wait", { keyIndex, retry: rateLimitRetries, waitSeconds: 3 });
                            await new Promise((r) => setTimeout(r, 3000));
                            offset -= 1;
                            continue;
                        }
                    }

                    throw lastError;
                }

                await this.persistKeyCursor(keyIndex);
                const resultText = getCompletionContent(body);
                if (!resultText) {
                    throw new Error("No content found in AI response.");
                }

                return resultText;
            } catch (error) {
                lastError = error;

                if (offset >= keys.length - 1 || !isRetryableError(error)) {
                    logAiEvent("request_error", {
                        keyIndex,
                        message: error && error.message,
                    });
                    throw error;
                }

                logAiEvent("request_retry", {
                    keyIndex,
                    nextKeyIndex: (keyIndex + 1) % keys.length,
                    message: error && error.message,
                });
            }
        }

        throw lastError || new Error("AI API request failed.");
    }

    async solveQuestions(questionsPrompt, options = {}) {
        const hasImage = Boolean(options && (options.screenshotUrl || options.imageUrl));
        const fullPrompt = buildCourseraQuizPrompt(questionsPrompt, hasImage);
        let responseText;

        try {
            responseText = await this.generateResponse(fullPrompt, options);
        } catch (error) {
            if (hasImage) {
                console.warn(
                    `[AutoCoursera][AI] Vision request failed (${error.message}). Retrying with text-only prompt...`
                );
                const textOnlyPrompt = buildCourseraQuizPrompt(questionsPrompt, false);
                const textOnlyOptions = { ...options };
                delete textOnlyOptions.screenshotUrl;
                delete textOnlyOptions.imageUrl;
                responseText = await this.generateResponse(textOnlyPrompt, textOnlyOptions);
            } else {
                throw error;
            }
        }

        try {
            return GeminiAI.parseAnswerResponse(responseText);
        } catch (error) {
            console.error("Failed to parse AI response:", responseText);
            throw new Error("AI returned invalid JSON.");
        }
    }

    async decideActionFromScreenshot(screenshotUrl, context = {}) {
        if (!screenshotUrl) {
            throw new Error("Screenshot URL is required for vision decision.");
        }

        const systemPrompt = [
            "You are an AI vision navigator helping an automated runner complete Coursera quizzes and assignments.",
            "Analyze the provided screenshot of the current Coursera webpage.",
            "The runner might be blocked by an overlay or modal dialog (such as 'Start new attempt?', 'Resume attempt', confirmation popup, or honor code), or cannot find quiz questions in the DOM.",
            "Identify what button or clickable element must be clicked to proceed (e.g. 'Continue', 'Start attempt', 'Resume', 'Try again', 'Got it', 'Next', 'Submit', 'I agree', 'Start', or close an overlay).",
            "Return JSON only with this structure:",
            "{",
            '  "action": "click" | "wait" | "refresh" | "none",',
            '  "targetText": string, // Exact visible text of the button/element to click, e.g. "Continue", "Start attempt"',
            '  "targetSelector": string, // Optional CSS selector or element hint',
            '  "reason": string // Brief explanation of what is shown on screen and why this action was chosen',
            "}",
        ].join("\n");

        const promptLines = [
            "Coursera Navigation Analysis:",
            context.url ? `Current URL: ${context.url}` : "",
            context.title ? `Page Title: ${context.title}` : "",
            context.status ? `Current Status: ${context.status}` : "",
            "Look at the screenshot carefully. If there is a modal or dialog (e.g. 'Start new attempt?' with a 'Continue' button), return action 'click' with targetText 'Continue'. If there is a start or resume button, return action 'click' with its text. Return JSON only.",
        ].filter(Boolean);

        const prompt = promptLines.join("\n");

        let responseText;
        try {
            responseText = await this.generateResponse(prompt, {
                screenshotUrl,
                systemPrompt,
                maxTokens: 1024,
            });
        } catch (error) {
            if (/từ chối|hỗ trợ|not support|unsupported|image|vision|400|500/i.test(error.message || "")) {
                console.warn("[AutoCoursera][AI] Configured model rejected vision payload. Retrying with claude-haiku-4-5...");
                responseText = await this.generateResponse(prompt, {
                    screenshotUrl,
                    systemPrompt,
                    maxTokens: 1024,
                    model: "claude-haiku-4-5",
                });
            } else {
                throw error;
            }
        }

        try {
            return GeminiAI.parseVisionDecision(responseText);
        } catch (error) {
            console.error("Failed to parse AI vision response:", responseText);
            throw new Error("AI returned invalid JSON for vision decision.");
        }
    }

    async readSettings() {
        const storageResult = await storageGet(this.storage, [
            "apiEndpoint",
            "openaiKeys",
            "openaiModel",
            "openaiKeyCursor",
            "groqKeys",
            "groqModel",
            "groqKeyCursor",
            "key",
            "model",
        ]);

        let rawKeys =
            storageResult.openaiKeys && storageResult.openaiKeys.length
                ? storageResult.openaiKeys
                : this.apiKey ||
                  (storageResult.groqKeys && storageResult.groqKeys.length
                      ? storageResult.groqKeys
                      : storageResult.key) ||
                  GeminiAI.DEFAULT_API_KEY;

        let candidateKeys = GeminiAI.normalizeKeys(rawKeys);
        if (!candidateKeys.length || candidateKeys.every((k) => k.startsWith("AIzaSy"))) {
            candidateKeys = [GeminiAI.DEFAULT_API_KEY];
        }

        const apiKeys = candidateKeys;
        let apiEndpoint = normalizeEndpoint(storageResult.apiEndpoint || this.apiEndpoint);
        if (/generativelanguage\.googleapis\.com/i.test(apiEndpoint)) {
            apiEndpoint = GeminiAI.DEFAULT_API_ENDPOINT;
        }

        const model =
            normalizeModel(storageResult.openaiModel) ||
            normalizeModel(this.model) ||
            normalizeModel(storageResult.groqModel) ||
            normalizeModel(storageResult.model) ||
            GeminiAI.DEFAULT_CHATGPT_MODEL;

        const keyCursor =
            storageResult.openaiKeyCursor !== undefined
                ? storageResult.openaiKeyCursor
                : storageResult.groqKeyCursor;

        return {
            apiEndpoint,
            apiKeys,
            groqKeys: apiKeys,
            model,
            groqModel: model,
            keyCursor,
            groqKeyCursor: keyCursor,
        };
    }

    async readGroqSettings() {
        return this.readSettings();
    }

    async persistKeyCursor(cursor) {
        await storageSet(this.storage, {
            openaiKeyCursor: cursor,
            groqKeyCursor: cursor,
        });
    }

    async persistGroqKeyCursor(cursor) {
        return this.persistKeyCursor(cursor);
    }

    static normalizeKeys(value) {
        const candidates = Array.isArray(value)
            ? value
            : String(value || "").split(/\r?\n|,/);
        const seen = new Set();
        const keys = [];

        candidates.forEach((item) => {
            const key = normalizeText(item);
            if (!key || seen.has(key)) {
                return;
            }

            seen.add(key);
            keys.push(key);
        });

        return keys;
    }

    static normalizeGroqKeys(value) {
        return GeminiAI.normalizeKeys(value);
    }

    static buildRequestBody(prompt, model = GeminiAI.DEFAULT_CHATGPT_MODEL, options = {}) {
        const requestModel = normalizeText(model) || GeminiAI.DEFAULT_CHATGPT_MODEL;
        const systemContent = options.systemPrompt || [
            "You solve Coursera quiz questions.",
            "Return JSON only. Do not include markdown, explanations, or <think> output.",
            "Return an object with one property named answers.",
            "answers must be an array matching this schema for each question:",
            "{ correctOptions: string[], correctOptionsIndex: number[], content: string }",
            "CRITICAL RULES:",
            "- For multi-select questions (type 'multi_select', checkboxes, or questions asking to select multiple / all that apply): You MUST return ALL correct option indexes in correctOptionsIndex (e.g. [1, 2]) and all corresponding option texts in correctOptions. DO NOT return only one answer if multiple options are correct!",
            "- For single-choice questions (type 'single_choice' or 'mcq', radio buttons): correctOptionsIndex must contain exactly one zero-based index (e.g. [0]).",
            "- For text answers (type 'text', essay, paragraph, free-response): include a clear, complete, and concise written answer in content (100-200 words per question). Keep it focused directly on the prompt and rubric criteria to avoid response cutoff.",
            "- If a question provides 'memory', 'previousAttempt', 'COURSERA FEEDBACK', or 'courseraHints':",
            "  * If confirmed correct options are given: You MUST select those exact options.",
            "  * If wrong options or failed combinations are given (scored 0 points in previous attempt): NEVER select them again! Choose a different valid alternative to avoid an infinite loop of repeating wrong answers.",
            "  * If Coursera explanation, hint, or feedback is provided (e.g. 'COURSERA FEEDBACK / EXPLANATION: ...'): You MUST read it carefully! It explains exactly why the prior answer was wrong or hints at the correct concept. Eliminate the rejected options and select the answer that directly aligns with Coursera's explanation.",
            "  * If the previous attempt scored below passing (e.g. < 80%): Re-evaluate all questions that were not confirmed correct, eliminate failed choices, and switch to better options.",
        ].join("\n");

        const userContent = options.screenshotUrl || options.imageUrl
            ? [
                { type: "text", text: prompt },
                {
                    type: "image_url",
                    image_url: {
                        url: options.screenshotUrl || options.imageUrl,
                        detail: options.imageDetail || "high",
                    },
                },
            ]
            : prompt;

        const body = {
            model: requestModel,
            temperature: options.temperature !== undefined ? options.temperature : 0.1,
            max_completion_tokens: options.maxTokens || 8192,
            top_p: 0.95,
            stream: false,
            response_format: { type: "json_object" },
            messages: [
                {
                    role: "system",
                    content: systemContent,
                },
                {
                    role: "user",
                    content: userContent,
                },
            ],
        };

        if (/luna|sol|astra/i.test(requestModel)) {
            body.reasoning_effort = "none";
        }

        return body;
    }

    static buildGroqRequestBody(prompt, model, options = {}) {
        return GeminiAI.buildRequestBody(prompt, model, options);
    }

    static parseAnswerResponse(content) {
        const text = String(content || "").trim();
        try {
            const parsed = JSON.parse(stripJsonCodeFence(text));
            if (Array.isArray(parsed)) {
                return parsed;
            }

            if (parsed && Array.isArray(parsed.answers)) {
                return parsed.answers;
            }
        } catch (initialErr) {
            const repaired = repairAndParseJson(text);
            if (Array.isArray(repaired) && repaired.length > 0) {
                return repaired;
            }
            console.error("Failed to parse AI response:", text);
            throw new Error("AI returned invalid JSON.");
        }

        const repaired = repairAndParseJson(text);
        if (Array.isArray(repaired) && repaired.length > 0) {
            return repaired;
        }

        throw new Error("AI response does not contain an answer array.");
    }

    static parseVisionDecision(content) {
        const parsed = JSON.parse(stripJsonCodeFence(content));
        if (parsed && typeof parsed === "object") {
            return {
                action: normalizeText(parsed.action || "none").toLowerCase(),
                targetText: normalizeText(parsed.targetText || parsed.buttonText || ""),
                targetSelector: normalizeText(parsed.targetSelector || ""),
                reason: normalizeText(parsed.reason || ""),
            };
        }

        throw new Error("Invalid vision decision object.");
    }
}

GeminiAI.DEFAULT_API_ENDPOINT = "https://llm.vcoderlog.com/v1/chat/completions";
GeminiAI.DEFAULT_API_KEY = "sk-f12dd12cc0944935-5ndjfx-d292546a";
GeminiAI.DEFAULT_CHATGPT_MODEL = "gh/gpt-5.6-luna";
GeminiAI.DEFAULT_MODEL = "gh/gpt-5.6-luna";
GeminiAI.DEFAULT_GROQ_MODEL = "gh/gpt-5.6-luna";
GeminiAI.CHATGPT_CHAT_COMPLETIONS_ENDPOINT =
    "https://llm.vcoderlog.com/v1/chat/completions";
GeminiAI.GROQ_CHAT_COMPLETIONS_ENDPOINT =
    "https://llm.vcoderlog.com/v1/chat/completions";

function normalizeEndpoint(value) {
    let endpoint = String(value || "").trim();
    if (!endpoint) {
        return GeminiAI.DEFAULT_API_ENDPOINT;
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

function buildCourseraQuizPrompt(questionsPrompt, hasScreenshot = false) {
    const rules = [
        "Analyze the following JSON representing Coursera questions and provide the correct answers.",
        "IMPORTANT RULES:",
        "1. For multi_select questions (checkboxes): There may be MULTIPLE correct answers! You MUST include ALL correct option indexes in correctOptionsIndex (e.g. [1, 2]) and all corresponding option texts in correctOptions.",
        "2. For single_choice questions (radio buttons): Exactly ONE option is correct. Include one index in correctOptionsIndex (e.g. [2]).",
        "3. For text questions (type 'text'): Write a comprehensive, well-structured, professional answer in 'content'.",
    ];

    if (hasScreenshot) {
        rules.push(
            "4. A screenshot of the quiz/assignment page is attached. For essay / paragraph questions, inspect any diagrams, charts, readings, or specific prompt guidelines visible in the screenshot to formulate the most accurate and thorough response."
        );
    }

    rules.push(
        "5. CRITICAL QUIZ MEMORY: If a question includes 'previousAttemptFeedback' or mentions 'CONFIRMED WRONG OPTION(S)', you MUST NEVER select those wrong options! If 'CONFIRMED CORRECT ANSWER(S)' are provided, you MUST include them and select alternative unconfirmed options to find the complete correct set.",
        "6. PREVIOUS ATTEMPT & SCORE HISTORY: If 'previousAttemptReport' is present in the prompt, the previous attempt scored below the required passing threshold. Inspect what was submitted in the previous attempt and the points earned. DO NOT repeat answers that were marked INCORRECT (0 points) or combinations that failed. Retain answers that earned full credit (CORRECT). For all failed questions, re-analyze and choose better alternative options so the quiz passes with >= passing threshold!",
        "7. ASSIGNMENT CONTEXT & SCENARIO: If 'assignmentContext' is present in Question Data, it contains the instructions, scenario passage, steps, or dataset details for this assignment. Carefully examine this context to find the exact answer to any questions referencing it.",
        "8. EXCEL & DATA ANALYSIS SPECIALIZATION: For questions regarding Microsoft Excel (functions such as TRIM, CLEAN, PROPER, UPPER, LOWER, TEXT, CONCATENATE, TEXTJOIN, LEFT, RIGHT, MID, FIND, SEARCH, SUBSTITUTE, REPLACE, VLOOKUP, XLOOKUP, INDEX/MATCH, IF, IFS, SUMIFS, COUNTIFS, DATE, YEAR, MONTH, DAY, NETWORKDAYS, etc.), analyze Excel syntax, formula evaluation, cell references, data cleaning rules, and table calculations meticulously. Pay strict attention to case sensitivity, leading/trailing spaces, argument order, and exact standard Excel formula behavior.",
        "Respond with JSON only in this shape: {\"answers\":[...]}",
        "Question Data:",
        questionsPrompt
    );

    return rules.join("\n");
}

function getCompletionContent(body) {
    return body && body.choices && body.choices[0] && body.choices[0].message
        ? body.choices[0].message.content || ""
        : "";
}
const getGroqCompletionContent = getCompletionContent;

function isRateLimitResponse(response, body) {
    return (
        response.status === 429 ||
        (body && body.error && body.error.code === "rate_limit_exceeded") ||
        (body && body.error && body.error.type === "insufficient_quota") ||
        /rate limit|quota/i.test(body && body.error && body.error.message)
    );
}
const isGroqRateLimitResponse = isRateLimitResponse;

function isRetryableError(error) {
    const msg = String(error && error.message ? error.message : error || "").toLowerCase();
    return /rate limit|quota|429|500|502|503|504|temporarily unavailable|timeout|timed out|message port closed|port closed|failed to fetch|network/i.test(
        msg
    );
}
const isRetryableGroqError = isRetryableError;

function normalizeKeyCursor(value, keys) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || !keys.length) {
        return 0;
    }

    return Math.min(Math.max(parsed, 0), keys.length - 1);
}
const normalizeGroqKeyCursor = normalizeKeyCursor;

function stripJsonCodeFence(content) {
    return normalizeText(content)
        .replace(/^```json\s*/i, "")
        .replace(/^```\s*/i, "")
        .replace(/\s*```$/i, "");
}

function repairAndParseJson(rawContent) {
    let text = String(rawContent || "").trim();
    text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

    try {
        const data = JSON.parse(text);
        if (Array.isArray(data)) return data;
        if (data && Array.isArray(data.answers)) return data.answers;
    } catch (ignore) {}

    const firstBrace = text.indexOf("{");
    const firstBracket = text.indexOf("[");
    let startIdx = -1;
    let isArray = false;

    if (firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) {
        startIdx = firstBrace;
        isArray = false;
    } else if (firstBracket !== -1) {
        startIdx = firstBracket;
        isArray = true;
    }

    if (startIdx === -1) return null;
    text = text.slice(startIdx);

    let lastCloseBrace = text.lastIndexOf("}");
    while (lastCloseBrace !== -1) {
        let candidate = text.slice(0, lastCloseBrace + 1);
        candidate = candidate.replace(/,\s*$/, "");
        if (!isArray) {
            if (!candidate.endsWith("]}")) {
                candidate += "]}";
            }
        } else {
            if (!candidate.endsWith("]")) {
                candidate += "]";
            }
        }

        try {
            const data = JSON.parse(candidate);
            const answers = Array.isArray(data) ? data : data && data.answers;
            if (Array.isArray(answers) && answers.length > 0) {
                return answers;
            }
        } catch (ignore) {}

        lastCloseBrace = text.lastIndexOf("}", lastCloseBrace - 1);
    }

    return null;
}

function normalizeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeModel(value) {
    const model = normalizeText(value);
    if (!model || /^gemini/i.test(model) || /^qwen|^llama|^deepseek/i.test(model)) {
        return "";
    }

    return model;
}
const normalizeGroqModel = normalizeModel;

function getBoundGlobalFetch() {
    return typeof globalThis.fetch === "function"
        ? globalThis.fetch.bind(globalThis)
        : null;
}

async function executeFetch(fetchImpl, endpoint, requestInit) {
    const canUseRelay =
        Boolean(globalThis.chrome && chrome.runtime && typeof chrome.runtime.sendMessage === "function");

    try {
        const response = await fetchImpl(endpoint, requestInit);
        const body = await response.json().catch(() => ({}));
        return { response, body };
    } catch (fetchError) {
        if (canUseRelay && isNetworkOrCorsError(fetchError)) {
            logAiEvent("cors_relay_attempt", {
                endpoint,
                reason: fetchError.message || "Failed to fetch",
            });
            return await relayFetchToBackground(endpoint, requestInit);
        }
        throw fetchError;
    }
}

function relayFetchToBackground(url, options, retryCount = 0) {
    return new Promise((resolve, reject) => {
        if (!globalThis.chrome || !chrome.runtime || typeof chrome.runtime.sendMessage !== "function") {
            return reject(new Error("chrome.runtime.sendMessage is not available."));
        }

        chrome.runtime.sendMessage(
            {
                type: "fetchAi",
                url,
                options,
            },
            (result) => {
                if (chrome.runtime.lastError) {
                    const errMsg = chrome.runtime.lastError.message || "";
                    if ((errMsg.includes("message port closed") || errMsg.includes("Could not establish connection")) && retryCount < 2) {
                        setTimeout(() => {
                            relayFetchToBackground(url, options, retryCount + 1).then(resolve, reject);
                        }, 500);
                        return;
                    }
                    return reject(new Error(errMsg));
                }

                if (!result) {
                    if (retryCount < 2) {
                        setTimeout(() => {
                            relayFetchToBackground(url, options, retryCount + 1).then(resolve, reject);
                        }, 500);
                        return;
                    }
                    return reject(new Error("No response received from background relay."));
                }

                if (result.error && !result.status) {
                    return reject(new Error(result.error));
                }

                resolve({
                    response: {
                        ok: Boolean(result.ok),
                        status: result.status,
                        statusText: result.statusText || "",
                    },
                    body: result.body || {},
                });
            }
        );
    });
}

function isNetworkOrCorsError(error) {
    const msg = String(error && error.message ? error.message : error || "").toLowerCase();
    return (
        msg.includes("failed to fetch") ||
        msg.includes("networkerror") ||
        msg.includes("cors") ||
        msg.includes("cross-origin") ||
        msg.includes("blocked by client")
    );
}

function logAiEvent(eventName, details = {}) {
    const safeDetails = {};
    Object.keys(details || {}).forEach((key) => {
        if (/key$/i.test(key) && !/index/i.test(key)) {
            return;
        }

        safeDetails[key] = details[key];
    });

    console.log(`[AutoCoursera][AI] ${eventName}`, safeDetails);
}

function storageGet(storage, keys) {
    return new Promise((resolve) => {
        if (!storage || !storage.local || typeof storage.local.get !== "function") {
            resolve({});
            return;
        }

        storage.local.get(keys, resolve);
    });
}

function storageSet(storage, values) {
    return new Promise((resolve) => {
        if (!storage || !storage.local || typeof storage.local.set !== "function") {
            resolve();
            return;
        }

        storage.local.set(values, resolve);
    });
}

// Export for use in other scripts
if (typeof module !== "undefined" && module.exports) {
    module.exports = GeminiAI;
} else {
    window.GeminiAI = GeminiAI;
    window.GroqAI = GeminiAI;
    window.ChatGPTAI = GeminiAI;
    window.OpenAI = GeminiAI;
}
