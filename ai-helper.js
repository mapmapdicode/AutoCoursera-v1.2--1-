/**
 * Helper class for interacting with Gemini API
 */
class GeminiAI {
    constructor(apiKey, model = 'gemini-2.5-flash') {
        this.apiKey = apiKey;
        this.model = model;
        this.apiEndpoint = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`;
    }

    async generateResponse(prompt, responseMimeType = "application/json") {
        if (!this.apiKey) {
            throw new Error('Gemini API Key is missing.');
        }

        const url = `${this.apiEndpoint}?key=${this.apiKey}`;
        
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { 
                    temperature: 0.1, 
                    responseMimeType: responseMimeType 
                },
            }),
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.error?.message || `Gemini API request failed with status ${response.status}`);
        }

        const data = await response.json();
        const resultText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        
        if (!resultText) {
            throw new Error('No content found in Gemini response.');
        }

        return resultText;
    }

    async solveQuestions(questionsPrompt) {
        const fullPrompt = `You are a Coursera expert. Analyze the following JSON representing Coursera questions and provide the correct answers. For multiple-choice questions (mcq), provide both 'correctOptions' (array of strings) and 'correctOptionsIndex' (0-indexed array of numbers). For text answers, provide 'content' (string). Respond with ONLY a valid JSON array of objects. Do not include any explanatory text, markdown, or anything outside the JSON array itself. Question Data:\n${questionsPrompt}`;
        const responseText = await this.generateResponse(fullPrompt);
        try {
            return JSON.parse(responseText);
        } catch (e) {
            console.error("Failed to parse AI response:", responseText);
            throw new Error("AI returned invalid JSON.");
        }
    }
}

// Export for use in other scripts
if (typeof module !== 'undefined' && module.exports) {
    module.exports = GeminiAI;
} else {
    window.GeminiAI = GeminiAI;
}
