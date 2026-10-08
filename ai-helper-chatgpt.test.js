const test = require("node:test");
const assert = require("node:assert/strict");
const AI = require("./ai-helper");
const storage = (data) => ({local: {get: (keys, cb) => cb(data), set: (values, cb) => {Object.assign(data, values); cb?.();}}});

test("default and legacy Gemini configurations migrate to ChatGPT web even with saved keys", async () => {
    for (const data of [{}, {key: "sk-old"}, {aiMode: "gemini_web", lunaAutofillEnabled: true},
        {aiMode: "api", model: "gemini-flash-latest", key: "AIzaSy-old"},
        {aiMode: "api", apiEndpoint: "https://generativelanguage.googleapis.com/"}]) {
        const ai = new AI("", "", {storage: storage(data)});
        assert.equal((await ai.readSettings()).aiMode, "chatgpt_web");
    }
});

test("legacy Auto Quiz uses ChatGPT web even when an old Luna toggle is enabled", async () => {
    const ai = new AI("", "", {storage: storage({aiMode: "gemini_web", lunaAutofillEnabled: true}),
        fetch: async () => { throw new Error("Must not call API"); }});
    ai.generateResponseViaChatGPTWeb = async () => '{"answers":[{"correctOptionsIndex":[1]}]}';
    assert.deepEqual(await ai.solveQuestions("[]"), [{correctOptionsIndex: [1]}]);
});

test("ChatGPT failure never falls back to an API or a different provider", async () => {
    let apiCalls = 0;
    const ai = new AI("", "", {storage: storage({aiMode: "gemini_web", openaiKeys: ["sk-old"]}),
        fetch: async () => { apiCalls++; return {ok: true, json: async () => ({choices: [{message: {content: "wrong fallback"}}]})}; }});
    ai.generateResponseViaChatGPTWeb = async () => { throw new Error("PRO_MODE_UNAVAILABLE"); };
    await assert.rejects(ai.generateResponse("Quiz"), /PRO_MODE_UNAVAILABLE/);
    assert.equal(apiCalls, 0);
});
test("legacy callers cannot receive truncated, incomplete or invalid ChatGPT answer sets", async () => {
    const questions = JSON.stringify({questions: [{type: "single_choice", options: ["A", "B"]}, {type: "text"}]});
    for (const reply of ['{"answers":[{"correctOptionsIndex":[1]}',
        '{"answers":[{"correctOptionsIndex":[1]}]}',
        '{"answers":[{"correctOptionsIndex":[4]},{"content":"Explanation"}]}',
        '{"answers":[{"correctOptionsIndex":[1]},{"content":""}]}']) {
        const ai = new AI("", "", {storage: storage({aiMode: "chatgpt_web"})});
        ai.generateResponseViaChatGPTWeb = async () => reply;
        await assert.rejects(ai.solveQuestions(questions), /CHATGPT_INVALID_ANSWER/);
    }
});
test("a missing job acknowledgement is rejected instead of polling forever", async () => {
    const oldChrome = globalThis.chrome;
    let calls = 0;
    globalThis.chrome = {runtime: {sendMessage(message, cb) {calls++; cb({ok: true});}}};
    try {
        const ai = new AI("", "", {storage: storage({aiMode: "chatgpt_web"})});
        await assert.rejects(ai.generateResponse("Question"), /CHATGPT_INVALID_ACK/);
        assert.equal(calls, 1);
    } finally {globalThis.chrome = oldChrome;}
});

test("ChatGPT job polling waits for completed output and forwards the highest-effort policy", async () => {
    const oldChrome = globalThis.chrome;
    const messages = [];
    let polls = 0;
    globalThis.chrome = {runtime: {sendMessage(message, cb) {
        messages.push(message);
        if (message.type === "startChatGPTJob") cb({ok: true, requestId: "job-1"});
        else if (message.type === "getChatGPTJob") cb(++polls < 2 ? {ok: true, status: "running"} :
            {ok: true, status: "complete", text: '{"answers":[{"correctOptionsIndex":[0]}]}'});
        else cb({ok: false, error: "Unexpected message"});
    }}};
    try {
        const ai = new AI("", "", {storage: storage({aiMode: "chatgpt_web"})});
        const answers = await ai.solveQuestions("[]", {chatgptPolicy: {kind: "limited", mode: "pro", reasoningEffort: "max"}});
        assert.deepEqual(answers, [{correctOptionsIndex: [0]}]);
        assert.equal(polls, 2);
        assert.equal(messages[0].options.mode, "pro");
        assert.equal(messages[0].options.reasoningEffort, "max");
        assert.ok(messages[0].options.timeoutMs > 120000);
    } finally { globalThis.chrome = oldChrome; }
});
