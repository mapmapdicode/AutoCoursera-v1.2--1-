const test = require("node:test");
const assert = require("node:assert/strict");

const GeminiAI = require("./ai-helper");

test("Luna autofill is opt-in and does not call the API when disabled", async () => {
  for (const initial of [{}, { lunaAutofillEnabled: false }]) {
    let calls = 0;
    const storage = createStorage(initial);
    const ai = new GeminiAI("", "", { storage: storage.api, fetch: async () => { calls++; } });
    await assert.rejects(ai.solveQuestionsViaLuna("[]"), /tắt/i);
    assert.equal(calls, 0);
  }
});

test("Luna autofill uses its own endpoint, key, model and cursor despite Gemini mode", async () => {
  const storage = createStorage({
    aiMode: "gemini_web", apiEndpoint: "https://api.openai.com/v1/chat/completions",
    openaiKeys: ["sk-main"], openaiModel: "another-model", openaiKeyCursor: 3,
    lunaAutofillEnabled: true, lunaAutofillEndpoint: "https://api.apiz.vn/",
    lunaAutofillKeys: ["sk-autofill"], lunaAutofillKeyCursor: 0,
  });
  const calls = [];
  const ai = new GeminiAI("", "", { storage: storage.api, fetch: async (url, options) => {
    calls.push({url, options});
    return createJsonResponse(200, {choices: [{message: {content: '[{"correctOptionsIndex":[1]}]'}}]});
  }});
  ai.generateResponseViaChatGPTWeb = async () => { throw new Error("must not use web for explicit Luna request"); };
  const answers = await ai.solveQuestionsViaLuna('[{"prompt":"Example"}]', { aiMode: "gemini_web", model: "wrong-model" });
  assert.deepEqual(answers, [{correctOptionsIndex: [1]}]);
  assert.equal(calls[0].url, "https://api.apiz.vn/v1/chat/completions");
  assert.equal(calls[0].options.headers.Authorization, "Bearer sk-autofill");
  assert.equal(JSON.parse(calls[0].options.body).model, "gh/gpt-5.6-luna");
  assert.equal(storage.data.openaiKeyCursor, 3);
  assert.equal(storage.data.lunaAutofillKeyCursor, 0);
});

test("Luna autofill defaults use the existing Luna service independently of main keys", async () => {
  const storage = createStorage({lunaAutofillEnabled: true, openaiKeys: ["sk-main"]});
  const ai = new GeminiAI("", "", {storage: storage.api});
  const settings = await ai.readLunaAutofillSettings();
  assert.equal(settings.apiEndpoint, GeminiAI.DEFAULT_API_ENDPOINT);
  assert.deepEqual(settings.apiKeys, [GeminiAI.DEFAULT_API_KEY]);
  assert.equal(settings.model, "gh/gpt-5.6-luna");
});

test("turning Luna off during an API request discards the response", async () => {
  const storage = createStorage({lunaAutofillEnabled: true});
  const ai = new GeminiAI("", "", {storage: storage.api, fetch: async () => {
    storage.data.lunaAutofillEnabled = false;
    return createJsonResponse(200, {choices: [{message: {content: '[{"correctOptionsIndex":[0]}]'}}]});
  }});
  await assert.rejects(ai.solveQuestionsViaLuna("[]"), /đã tắt/i);
});

test("legacy Auto Quiz also honors the Luna toggle without changing other AI calls", async () => {
  const storage = createStorage({lunaAutofillEnabled: true, aiMode: "api", lunaAutofillKeys: ["sk-luna"]});
  let calls = 0;
  const ai = new GeminiAI("", "", {storage: storage.api, fetch: async () => {
    calls++;
    return createJsonResponse(200, {choices: [{message: {content: '[{"correctOptionsIndex":[0]}]'}}]});
  }});
  await ai.solveQuestions("[]");
  assert.equal(calls, 1);
  await ai.generateResponse("Navigation / feedback");
  assert.equal(calls, 2);
});

function createStorage(initial = {}) {
  // These legacy tests exercise the optional API path explicitly. Web is now
  // the default; its migration and routing are covered in ai-helper-chatgpt.test.
  const storage = { aiMode: "api", ...initial };
  return {
    data: storage,
    api: {
      local: {
        get(keys, callback) {
          const result = {};
          const keyList = Array.isArray(keys) ? keys : [keys];
          keyList.forEach((key) => {
            result[key] = storage[key];
          });
          callback(result);
        },
        set(values, callback) {
          Object.assign(storage, values);
          if (callback) callback();
        },
      },
    },
  };
}

function createJsonResponse(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        return headers[String(name).toLowerCase()] || null;
      },
    },
    async json() {
      return body;
    },
  };
}

test("normalizeKeys trims, splits, and dedupes keys", () => {
  assert.deepEqual(
    GeminiAI.normalizeKeys([" sk-test1 ", "", "sk-test2", "sk-test1"]),
    ["sk-test1", "sk-test2"]
  );
  assert.deepEqual(
    GeminiAI.normalizeGroqKeys("sk-a\nsk-b\n\n sk-a "),
    ["sk-a", "sk-b"]
  );
});

test("solveQuestions calls APIZ ChatGPT Luna endpoint and returns the legacy answer array", async () => {
  const storage = createStorage({
    openaiKeys: ["sk-luna-first"],
    openaiModel: "gpt-6-luna",
    apiEndpoint: "https://api.apiz.vn/v1/chat/completions",
  });
  const calls = [];
  const ai = new GeminiAI("", "", {
    storage: storage.api,
    fetch: async (url, options) => {
      calls.push({ url, options });
      return createJsonResponse(200, {
        choices: [
          {
            message: {
              content: JSON.stringify([
                {
                  correctOptionsIndex: [1],
                  correctOptions: ["B"],
                  content: "",
                },
              ]),
            },
          },
        ],
      });
    },
  });

  const answers = await ai.solveQuestions(JSON.stringify([{ prompt: "2+2?" }]));

  assert.deepEqual(answers, [
    {
      correctOptionsIndex: [1],
      correctOptions: ["B"],
      content: "",
    },
  ]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.apiz.vn/v1/chat/completions");
  assert.equal(calls[0].options.headers.Authorization, "Bearer sk-luna-first");
  const requestBody = JSON.parse(calls[0].options.body);
  assert.equal(requestBody.model, "gpt-6-luna");
  assert.equal(requestBody.reasoning_effort, "none");
  assert.deepEqual(requestBody.response_format, { type: "json_object" });
});

test("solveQuestions rotates ChatGPT keys after a rate limit response", async () => {
  const storage = createStorage({
    openaiKeys: ["sk-limited", "sk-next"],
    openaiModel: "gpt-6-luna",
    openaiKeyCursor: 0,
  });
  const usedKeys = [];
  const ai = new GeminiAI("", "", {
    storage: storage.api,
    fetch: async (_url, options) => {
      usedKeys.push(options.headers.Authorization.replace("Bearer ", ""));
      if (usedKeys.length === 1) {
        return createJsonResponse(429, {
          error: {
            code: "rate_limit_exceeded",
            message: "Rate limit reached for requests per min",
          },
        });
      }
      return createJsonResponse(200, {
        choices: [
          {
            message: {
              content: JSON.stringify({
                answers: [{ correctOptionsIndex: [0], correctOptions: ["A"] }],
              }),
            },
          },
        ],
      });
    },
  });

  const answers = await ai.solveQuestions("[]");

  assert.deepEqual(usedKeys, ["sk-limited", "sk-next"]);
  assert.deepEqual(answers, [{ correctOptionsIndex: [0], correctOptions: ["A"] }]);
  assert.equal(storage.data.openaiKeyCursor, 1);
});

test("solveQuestions ignores legacy Gemini and Groq model names when calling ChatGPT Luna", async () => {
  const storage = createStorage({});
  let requestBody = null;
  const ai = new GeminiAI("sk-legacy", "qwen/qwen3-32b", {
    storage: storage.api,
    fetch: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return createJsonResponse(200, {
        choices: [
          {
            message: {
              content: JSON.stringify({ answers: [] }),
            },
          },
        ],
      });
    },
  });

  await ai.solveQuestions("[]");

  assert.equal(requestBody.model, GeminiAI.DEFAULT_CHATGPT_MODEL);
});

test("solveQuestions binds global fetch to the window/global object", async () => {
  const originalFetch = globalThis.fetch;
  const originalChrome = globalThis.chrome;
  const storage = createStorage({
    openaiKeys: ["sk-bound"],
    openaiModel: "gpt-6-luna",
  });

  globalThis.chrome = { storage: storage.api };
  globalThis.fetch = async function (_url, options) {
    assert.equal(this, globalThis);
    assert.equal(options.headers.Authorization, "Bearer sk-bound");
    return createJsonResponse(200, {
      choices: [
        {
          message: {
            content: JSON.stringify({ answers: [] }),
          },
        },
      ],
    });
  };

  try {
    const ai = new GeminiAI();
    const answers = await ai.solveQuestions("[]");

    assert.deepEqual(answers, []);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalChrome === undefined) {
      delete globalThis.chrome;
    } else {
      globalThis.chrome = originalChrome;
    }
  }
});

test("solveQuestions parses multi-select answers with multiple correct indexes and options", async () => {
  const storage = createStorage({
    openaiKeys: ["sk-multi-select"],
    openaiModel: "gpt-6-luna",
    apiEndpoint: "https://api.apiz.vn/v1/chat/completions",
  });

  const expectedAnswers = [
    {
      correctOptionsIndex: [1, 2],
      correctOptions: [
        "To gather requirements and insights that can help with project planning and decision-making.",
        "To build relationships with stakeholders and ensure their ongoing support and commitment throughout the project lifecycle.",
      ],
    },
  ];

  let requestBody = null;
  const ai = new GeminiAI("", "", {
    storage: storage.api,
    fetch: async (url, options) => {
      requestBody = JSON.parse(options.body);
      return createJsonResponse(200, {
        choices: [
          {
            message: {
              content: JSON.stringify({ answers: expectedAnswers }),
            },
          },
        ],
      });
    },
  });

  const result = await ai.solveQuestions(
    JSON.stringify([
      {
        type: "multi_select",
        question: "Why is it important to engage with stakeholders early in the project?",
        options: [
          "To minimize stakeholders' involvement",
          "To gather requirements and insights",
          "To build relationships with stakeholders",
          "To gather all requirements upfront",
        ],
      },
    ])
  );

  assert.deepEqual(result, expectedAnswers);
  assert.equal(requestBody.model, "gpt-6-luna");
});

test("buildRequestBody creates multimodal message when screenshotUrl is supplied", () => {
  const body = GeminiAI.buildRequestBody("Solve essay", "gpt-6-luna", {
    screenshotUrl: "data:image/jpeg;base64,mockdata123",
  });

  assert.equal(Array.isArray(body.messages[1].content), true);
  assert.equal(body.messages[1].content[0].type, "text");
  assert.equal(body.messages[1].content[0].text, "Solve essay");
  assert.equal(body.messages[1].content[1].type, "image_url");
  assert.equal(body.messages[1].content[1].image_url.url, "data:image/jpeg;base64,mockdata123");
});

test("solveQuestions forwards screenshotUrl to AI request payload", async () => {
  let capturedBody = null;
  const storage = createStorage({
    openaiKeys: ["sk-luna-test"],
    openaiModel: "gpt-6-luna",
    apiEndpoint: "https://api.apiz.vn/v1/chat/completions",
  });

  const ai = new GeminiAI("", "", {
    storage: storage.api,
    fetch: async (url, options) => {
      capturedBody = JSON.parse(options.body);
      return createJsonResponse(200, {
        choices: [
          {
            message: {
              content: JSON.stringify({ answers: [{ content: "An essay paragraph response" }] }),
            },
          },
        ],
      });
    },
  });

  const result = await ai.solveQuestions(
    JSON.stringify([{ type: "text", question: "Write a summary paragraph" }]),
    { screenshotUrl: "data:image/jpeg;base64,screenshot456" }
  );

  assert.equal(result[0].content, "An essay paragraph response");
  assert.equal(capturedBody.messages[1].content[1].image_url.url, "data:image/jpeg;base64,screenshot456");
});

test("decideActionFromScreenshot sends vision prompt and returns action decision", async () => {
  let capturedBody = null;
  const storage = createStorage({
    openaiKeys: ["sk-luna-test"],
    openaiModel: "gpt-6-luna",
    apiEndpoint: "https://api.apiz.vn/v1/chat/completions",
  });

  const ai = new GeminiAI("", "", {
    storage: storage.api,
    fetch: async (url, options) => {
      capturedBody = JSON.parse(options.body);
      return createJsonResponse(200, {
        choices: [
          {
            message: {
              content: "```json\n{\"action\": \"click\", \"targetText\": \"Continue\", \"reason\": \"Modal Start new attempt is open\"}\n```",
            },
          },
        ],
      });
    },
  });

  const decision = await ai.decideActionFromScreenshot("data:image/jpeg;base64,modal_screen", {
    url: "https://www.coursera.org/learn/business-analysis-fundamentals/assignment-submission/3qpW9/attempt",
    title: "Start new attempt?",
  });

  assert.deepEqual(decision, {
    action: "click",
    targetText: "Continue",
    targetSelector: "",
    reason: "Modal Start new attempt is open",
  });
  assert.equal(capturedBody.messages[1].content[1].image_url.url, "data:image/jpeg;base64,modal_screen");
});

test("solveQuestions automatically falls back to text-only if image is rejected by model", async () => {
  let callCount = 0;
  const storage = createStorage({
    openaiKeys: ["sk-luna-test"],
    openaiModel: "gpt-6-luna",
  });

  const ai = new GeminiAI("", "", {
    storage: storage.api,
    fetch: async (_url, options) => {
      callCount++;
      const body = JSON.parse(options.body);
      if (callCount === 1) {
        // First call with image - simulate 400 model rejection
        assert.ok(Array.isArray(body.messages[1].content));
        return createJsonResponse(400, {
          error: {
            message: "Mô hình từ chối yêu cầu. Kiểm tra lại tham số, định dạng tin nhắn và nội dung gửi kèm (ví dụ ảnh, tệp) có được mô hình này hỗ trợ không.",
          },
        });
      }

      // Second call fallback - verify text-only
      assert.ok(typeof body.messages[1].content === "string");
      return createJsonResponse(200, {
        choices: [
          {
            message: {
              content: JSON.stringify({
                answers: [{ correctOptionsIndex: [1], correctOptions: ["Option B"], content: "" }],
              }),
            },
          },
        ],
      });
    },
  });

  const result = await ai.solveQuestions(
    JSON.stringify([{ question: "What is the 5 Whys?" }]),
    { screenshotUrl: "data:image/jpeg;base64,mock" }
  );

  assert.equal(callCount, 2);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].correctOptionsIndex, [1]);
});

test("legacy Gemini settings send ChatGPT jobs with the previous feedback and parse a completed response", async () => {
  const originalChrome = globalThis.chrome;
  let sentMessage = null;

  globalThis.chrome = {
    runtime: {
      sendMessage(msg, callback) {
        if (msg.type === "startChatGPTJob") {sentMessage = msg; callback({ok: true, requestId: "job"}); return;}
        if (msg.type === "releaseChatGPTJob") {callback({ok: true}); return;}
        callback({
          ok: true,
          status: "complete",
          text: "```json\n{\"answers\":[{\"correctOptionsIndex\":[2],\"correctOptions\":[\"Answer C\"],\"content\":\"\"}]}\n```",
        });
      },
    },
  };

  try {
    const storage = createStorage({
      aiMode: "gemini_web",
    });

    const ai = new GeminiAI("", "", {
      storage: storage.api,
    });

    const result = await ai.solveQuestions(
      JSON.stringify({
        questions: [{ question: "Which is true?", options: ["A", "B", "C"] }],
        previousAttemptReport: require("./course-runner-helpers.js").buildPreviousAttemptReport(
          require("./course-runner-helpers.js").recordQuizAttemptHistory([], {
            scorePercent: 66.66, passingThreshold: 80,
            rawFeedback: "Rubric: missing impact on people",
            assignmentContext: "POPIT impact analysis scenario",
            questions: [{ prompt: "Explain impact", type: "text", chosenOptions: ["Previously submitted essay"] }],
          })
        ),
      })
    );

    assert.equal(sentMessage.type, "startChatGPTJob");
    assert.ok(sentMessage.prompt.includes("Rubric: missing impact on people"));
    assert.ok(sentMessage.prompt.includes("Previously submitted essay"));
    assert.ok(sentMessage.prompt.includes("POPIT impact analysis scenario"));
    assert.ok(sentMessage.prompt.includes("66.66%"));
    assert.ok(sentMessage.prompt.includes("80%"));
    assert.equal(result.length, 1);
    assert.deepEqual(result[0].correctOptionsIndex, [2]);
    assert.deepEqual(result[0].correctOptions, ["Answer C"]);
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test("legacy Gemini settings pause on ChatGPT login failure even with saved API keys", async () => {
  const originalChrome = globalThis.chrome;
  let webCallAttempted = false;
  let apiCallAttempted = false;

  globalThis.chrome = {
    runtime: {
      sendMessage(msg, callback) {
        if (msg.type === "startChatGPTJob") {
          webCallAttempted = true;
          callback({
            ok: false,
            error: "NOT_LOGGED_IN: Chưa đăng nhập ChatGPT",
          });
        }
      },
    },
  };

  try {
    const storage = createStorage({
      aiMode: "gemini_web",
      openaiKeys: ["sk-fallback-key"],
    });

    const ai = new GeminiAI("", "", {
      storage: storage.api,
      fetch: async () => {
        apiCallAttempted = true;
        return createJsonResponse(200, {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  answers: [{ correctOptionsIndex: [0], correctOptions: ["First"], content: "" }],
                }),
              },
            },
          ],
        });
      },
    });

    await assert.rejects(ai.solveQuestions(JSON.stringify([{ question: "Fallback test" }])), /NOT_LOGGED_IN/);
    assert.ok(webCallAttempted);
    assert.equal(apiCallAttempted, false);
  } finally {
    globalThis.chrome = originalChrome;
  }
});

