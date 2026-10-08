(function (global) {
    function normalizePath(input) {
        if (!input) {
            return "";
        }

        let path = String(input).trim();

        try {
            path = new URL(path, "https://www.coursera.org").pathname;
        } catch (error) {
            path = path.split("?")[0];
        }

        path = path.replace(/\/+$/, "");
        return path || "/";
    }

    function getItemSlug(path) {
        if (!path) return "";
        const clean = normalizePath(path).replace(/\/(attempt|view-feedback|instructions|feedback|submit|give-feedback|review)$/i, "").replace(/\/+$/, "");
        const parts = clean.split("/").filter(Boolean);
        return parts.length ? parts[parts.length - 1] : "";
    }

    function extractItemId(path) {
        if (!path) return "";
        const clean = normalizePath(path);
        const match = clean.match(/\/learn\/[^/]+\/(?:item|assignment-submission|lecture|quiz|ungradedLti|supplement|peer|exam)\/([A-Za-z0-9_-]+)/i);
        return match ? match[1] : "";
    }

    function extractCourseSlug(path) {
        if (!path) return "";
        const clean = normalizePath(path);
        const match = clean.match(/^\/learn\/([^/]+)/i);
        return match ? match[1].toLowerCase() : "";
    }

    function matchesItemPath(currentPath, itemPath) {
        const normalizedCurrent = normalizePath(currentPath);
        const normalizedItem = normalizePath(itemPath);
        if (!normalizedCurrent || !normalizedItem) return false;
        if (
            normalizedCurrent === normalizedItem ||
            normalizedCurrent === `${normalizedItem}/attempt` ||
            normalizedCurrent === `${normalizedItem}/submit` ||
            normalizedCurrent === `${normalizedItem}/instructions`
        ) {
            return true;
        }
        const currentClean = normalizedCurrent.replace(/\/(attempt|view-feedback|instructions|feedback|submit|give-feedback|review)$/i, "");
        const itemClean = normalizedItem.replace(/\/(attempt|view-feedback|instructions|feedback|submit|give-feedback|review)$/i, "");
        if (currentClean === itemClean) {
            return true;
        }

        // Match by identical course slug and item id
        // (covers /assignment-submission/Fa0r2 vs /assignment-submission/Fa0r2/activity-create-a-basic-diagram)
        const currentCourse = extractCourseSlug(normalizedCurrent);
        const itemCourse = extractCourseSlug(normalizedItem);
        const currentId = extractItemId(normalizedCurrent);
        const itemId = extractItemId(normalizedItem);
        if (currentId && itemId) {
            return Boolean(currentCourse && currentCourse === itemCourse && currentId === itemId);
        }

        const currentSlug = getItemSlug(normalizedCurrent);
        const itemSlug = getItemSlug(normalizedItem);
        if (currentSlug && itemSlug && currentSlug === itemSlug && currentCourse === itemCourse) {
            return true;
        }
        return false;
    }

    function isPathSkipped(skippedPaths, targetPath) {
        if (!skippedPaths || !targetPath) return false;
        if (skippedPaths.has && skippedPaths.has(targetPath)) return true;
        const list = Array.isArray(skippedPaths) ? skippedPaths : Array.from(skippedPaths || []);
        return list.some((p) => p === targetPath || matchesItemPath(p, targetPath));
    }

    function normalizeQuizResultSettleSeconds(value, fallback = 4) {
        const parsed = Number(value);
        if (!Number.isFinite(parsed)) {
            return fallback;
        }

        return Math.min(120, Math.max(1, Math.round(parsed)));
    }

    function normalizeQuizRetryCount(value, fallback = 2) {
        const parsed = Number(value);
        const parsedFallback = Number(fallback);
        const safeFallback = Number.isFinite(parsedFallback)
            ? Math.max(0, Math.min(5, Math.floor(parsedFallback)))
            : 2;
        if (!Number.isFinite(parsed) || parsed < 0) return safeFallback;
        return Math.max(0, Math.min(5, Math.floor(parsed)));
    }

    function buildCourseMaterialsUrl(slug) {
        return `/api/ondemandcoursematerials.v2/?q=slug&slug=${encodeURIComponent(slug)}&includes=modules`;
    }

    function guessItemType(path, title) {
        if (isUngradedAppItem({ path, title })) {
            return "app";
        }

        const value = `${path || ""} ${title || ""}`.toLowerCase();

        if (/(quiz|exam|practice|graded|assignment|peer|assessment|attempt)/.test(value)) {
            return "quiz";
        }

        return "lesson";
    }

    function pickFirstIncomplete(items, completionMap, skippedPaths = new Set()) {
        return items.find((item) => !isPathSkipped(skippedPaths, item.path) && completionMap.get(item.path) !== true) || null;
    }

    function isEligibleQuizItem(item) {
        if (!item || item.type !== "quiz") {
            return false;
        }

        const value = `${item.path || ""} ${item.title || ""}`.toLowerCase();

        if (/(programming|discussion\s+prompt|lecture|reading|supplement)/.test(value)) {
            return false;
        }

        return /(quiz|practice|graded|assignment-submission|attempt|peer|assignment)/.test(value);
    }

    function isUngradedAppItem(item) {
        if (!item) {
            return false;
        }

        const path = String(item.path || "").toLowerCase();
        const value = `${item.path || ""} ${item.title || ""} ${item.type || ""}`.toLowerCase();

        return (
            /\/ungradedlti\//.test(path) ||
            /\bungraded app item\b/.test(value) ||
            /\blti launch\b/.test(value)
        );
    }

    function isEligibleQuizRunItem(item) {
        return isEligibleQuizItem(item) || isUngradedAppItem(item);
    }

    function pickFirstIncompleteQuiz(items, completionMap, skippedPaths = new Set()) {
        return (
            items.find((item) => {
                if (!isEligibleQuizRunItem(item)) {
                    return false;
                }

                if (isPathSkipped(skippedPaths, item.path)) {
                    return false;
                }

                return completionMap.get(item.path) !== true;
            }) || null
        );
    }

    const DEFAULT_PASSING_PERCENT = 80;

    function extractGradePercentage(text) {
        if (!text) return null;
        const clean = String(text).trim();

        // 1. Percentage formats: "Grade: 80%", "AssignmentGrade: 0%", "Score: 16.66%", "Your grade: 75%", "Highest: 100%"
        const gradeMatch = clean.match(/(?:grade|score|highest|latest|received|mark)[\s:]*(\d+(?:\.\d+)?)\s*%/i);
        if (gradeMatch) {
            const val = parseFloat(gradeMatch[1]);
            if (!Number.isNaN(val) && val >= 0 && val <= 100) {
                return val;
            }
        }

        // 2. Reverse percentage: "100% grade", "80% score"
        const reverseMatch = clean.match(/\b(\d+(?:\.\d+)?)\s*%\s*(?:grade|score)/i);
        if (reverseMatch) {
            const val = parseFloat(reverseMatch[1]);
            if (!Number.isNaN(val) && val >= 0 && val <= 100) {
                return val;
            }
        }

        // 3. Fraction format: "Grade: 4/10", "Score: 1/5"
        const fractionMatch = clean.match(/(?:grade|score|mark)[\s:]*(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/i);
        if (fractionMatch) {
            const numerator = parseFloat(fractionMatch[1]);
            const denominator = parseFloat(fractionMatch[2]);
            if (!Number.isNaN(numerator) && !Number.isNaN(denominator) && denominator > 0) {
                const percent = (numerator / denominator) * 100;
                return Math.min(100, Math.max(0, Math.round(percent * 100) / 100));
            }
        }

        // 4. Standalone Grade with 0 or 0%: "Grade: 0"
        const zeroMatch = clean.match(/\b(?:assignment)?grade[\s:]*0\b/i);
        if (zeroMatch) {
            return 0;
        }

        return null;
    }

    function extractPassingThreshold(text, defaultThreshold = DEFAULT_PASSING_PERCENT) {
        if (!text) return defaultThreshold;
        const match = String(text).match(/(?:passing grade|to pass|pass at|pass with|threshold|minimum passing score)[\s:]*(\d+(?:\.\d+)?)\s*%/i);
        if (match) {
            const val = parseFloat(match[1]);
            if (!Number.isNaN(val) && val > 0 && val <= 100) {
                return val;
            }
        }
        return defaultThreshold;
    }

    function inferSidebarCompletionSignals({
        ariaLabel = "",
        text = "",
        hasSuccessIcon = false,
        passingThreshold = DEFAULT_PASSING_PERCENT,
    } = {}) {
        const raw = `${ariaLabel} ${text}`.trim();
        if (!raw && !hasSuccessIcon) {
            return null;
        }

        const value = raw.toLowerCase();

        // 1. Check if there is an explicit grade percentage
        const dynamicThreshold = extractPassingThreshold(value, passingThreshold);
        const gradePercent = extractGradePercentage(raw);
        if (gradePercent !== null) {
            // Below passing threshold: Coursera gives 0 credit / unpassed. MUST RETRY.
            if (gradePercent < dynamicThreshold) {
                return false;
            }
            // Meets or exceeds passing threshold
            if (gradePercent >= dynamicThreshold) {
                return true;
            }
        }

        // 2. Check for explicit unpassed / failed signals
        if (/(did not pass|not passed|try again|failed|retake|unsuccessful)/.test(value)) {
            return false;
        }

        // 3. Check for unstarted / incomplete signals
        if (/(not submitted|not started|incomplete|pending)/.test(value)) {
            return false;
        }

        // 4. Success icon from Coursera (only present when actually completed/passed)
        if (hasSuccessIcon) {
            return true;
        }

        // 5. Passed / completed signals (without failed / low grade signals)
        if (/(congratulations|you passed|passed|success)/.test(value)) {
            return true;
        }

        if (/\bcompleted\b/.test(value)) {
            return true;
        }

        return null;
    }

    function isSubmitActionLabel(label) {
        const value = String(label || "").trim().toLowerCase();
        if (!value) {
            return false;
        }

        const clean = value.replace(/^[^a-zA-Z0-9\u00C0-\u024F\u1EA0-\u1EF9]+/, "").trim();
        return /^(submit|check|finish|turn in|send answer|nộp bài|nộp)/i.test(clean) ||
               /\b(submit assignment|submit for review|nộp bài)\b/i.test(clean);
    }

    function isContinueActionLabel(label) {
        const value = String(label || "").trim().toLowerCase();
        if (!value) {
            return false;
        }

        const clean = value.replace(/^[^a-zA-Z0-9\u00C0-\u024F\u1EA0-\u1EF9]+/, "").trim();
        return /^(continue|next|go to next|next item|next lesson|next module|continue to next|tiếp tục|mục tiếp theo|tiếp theo)/i.test(clean) ||
               /(?:^|\b)(next item|go to next|continue to next|tiếp tục|mục tiếp theo|tiếp theo)\b/i.test(clean);
    }

    function isStartActionLabel(label) {
        const value = String(label || "").trim().toLowerCase();
        if (!value) {
            return false;
        }
        const clean = value.replace(/^[^a-zA-Z0-9\u00C0-\u024F\u1EA0-\u1EF9]+/, "").trim();
        if (/^(cancel|back|return|review|feedback|help|hủy|quay lại|next item|go to next|next lesson|next module)/i.test(clean)) {
            return false;
        }
        if (/(menu|outline|navigation|search|drawer|sidebar|settings|profile|avatar|notification|dropdown|close|expand|collapse)/i.test(clean)) {
            return false;
        }
        // Standalone "continue" or "next" is for navigation to next lesson, not start quiz
        if (/^(continue|next)$/i.test(clean)) {
            return false;
        }
        if (/^(start assignment|resume assignment|continue assignment|open assignment|start quiz|resume quiz|continue quiz|take quiz|start practice|take assignment|my submission|start submission)/i.test(clean)) {
            return true;
        }
        if (/^(bắt đầu làm bài|bắt đầu bài tập|làm tiếp bài tập|bắt đầu|làm tiếp|làm bài)/i.test(clean)) {
            return true;
        }
        return /^(start|begin|resume|take\b|retake\b)/i.test(clean);
    }

    function isRetryActionLabel(label) {
        const value = String(label || "").trim().toLowerCase();
        if (!value) {
            return false;
        }
        const clean = value.replace(/^[^a-zA-Z0-9]+/, "").trim();
        return /^(retry|try again|retake|take again|retake quiz|start next attempt|start new attempt|start attempt|làm lại|thử lại)/i.test(clean);
    }

    function isQuizAttemptLocked({
        pageText = "",
        retryButton = null,
        retryButtonDisabled = false,
        hasRetryButton = false,
        hasEnabledStartButton = false,
        hasFailedBanner = false,
    } = {}) {
        if (hasEnabledStartButton) {
            return false;
        }

        const hasRetry = Boolean(hasRetryButton || retryButton);
        if (hasRetry && !retryButtonDisabled) {
            return false;
        }

        if (hasRetry && retryButtonDisabled) {
            return true;
        }

        const text = String(pageText || "").toLowerCase();

        // 1. Text patterns indicating 0 attempts remaining, waiting lockout period, or max attempts reached
        const hasZeroAttempts =
            /0\s*of\s*\d+\s*attempts?\s*(every|\/|per|in|\b)/i.test(text) ||
            /0\s*attempts?\s*(remaining|left)/i.test(text) ||
            /0\s*(trong|trên)\s*\d+\s*(lần|lượt)/i.test(text) ||
            /(?:0\s*lượt\s*làm|hết\s*lượt\s*làm)/i.test(text);

        const hasLockoutPeriod =
            /(?:next attempt available in|try again in|available in \d+\s*(?:hour|minute|day)|quá số lần thử|hết lượt làm bài|thử lại sau \d+\s*giờ)/i.test(text);

        const hasAttemptLimitNotice =
            /(?:attempt limit reached|maximum attempts reached|you have reached the maximum|vượt quá giới hạn số lần)/i.test(text);

        if (hasZeroAttempts || hasLockoutPeriod || hasAttemptLimitNotice) {
            return true;
        }

        return false;
    }

    function isCancelActionLabel(label) {
        const value = String(label || "").trim().toLowerCase();
        if (!value) return false;
        return /^(cancel|back|return|close|dismiss|hủy|quay lại)/i.test(value);
    }

    function isUnansweredNoticeText(text) {
        const value = String(text || "").trim().toLowerCase();
        if (!value) return false;
        return /(?:unanswered\s*question|question(?:\s*is|\s*has)?\s*unanswered|please\s*answer\s*all|answer\s*all\s*questions|must\s*select\s*an\s*option|please\s*choose\s*an\s*option|this\s*question\s*requires\s*an\s*answer|this\s*field\s*is\s*required|field\s*is\s*required|invalid\s*response|incomplete\s*submission|you\s*have\s*\d+\s*unanswered|haven't\s*answered\s*all|chưa\s*trả\s*lời|chưa\s*chọn|không\s*được\s*để\s*trống|needs\s*to\s*be\s*a\s*little\s*bit\s*longer|write\s*a\s*few\s*sentences|answer\s*needs\s*to\s*be\s*longer|câu\s*trả\s*lời\s*quá\s*ngắn)/i.test(value);
    }

    function isPeerAssignmentSubmitted({
        isPeerItem = false,
        isSubmitUrl = false,
        hasSubmissionInputs = false,
        hasSubmitAction = false,
        pageText = "",
        justSubmitted = false,
    } = {}) {
        if (!isPeerItem) return false;
        const hasSubmittedBanner = /(you('ve| have) submitted|your assignment has been submitted|submission received|đã nộp bài|waiting for (your )?grade|waiting for (peer )?reviews|review \d+ peers to get your grade)/i.test(pageText);

        if (justSubmitted) {
            return hasSubmittedBanner || !hasSubmitAction || !hasSubmissionInputs;
        }

        if (isSubmitUrl || hasSubmissionInputs || hasSubmitAction) {
            return false;
        }

        return hasSubmittedBanner;
    }

    function isTextQuestionAnswered({
        isTitle = false,
        text = "",
        containerNotice = "",
        minLength = 50,
    } = {}) {
        const clean = String(text || "").trim();
        if (!clean) return false;
        if (/^(enter text here|type your response|viết câu trả lời|vui lòng nhập|your response)$/i.test(clean)) {
            return false;
        }
        if (containerNotice && isUnansweredNoticeText(containerNotice)) {
            return false;
        }
        if (isTitle) {
            return clean.length > 0;
        }
        return clean.length >= minLength;
    }

    function isSubmitConfirmDialogBlocked(dialogText) {
        const value = String(dialogText || "").trim().toLowerCase();
        if (!value) return false;
        return /(?:unanswered|haven't\s*answered|missing\s*answer|incomplete|without\s*answering|not\s*all\s*questions\s*have\s*been\s*answered|chưa\s*trả\s*lời\s*hết)/i.test(value);
    }

    function checkQuizSubmissionQualityGates({ questions = [], pageErrors = [], dialogText = "" }) {
        const errors = [...pageErrors];
        const unansweredIndexes = [];

        if (!Array.isArray(questions) || !questions.length) {
            return {
                canSubmit: false,
                reason: "No quiz questions detected.",
                unansweredIndexes: [],
                errors,
            };
        }

        questions.forEach((q, idx) => {
            const isAnswered = q.isAnswered !== undefined
                ? Boolean(q.isAnswered)
                : Boolean(
                    (Array.isArray(q.chosenIndexes) && q.chosenIndexes.length > 0) ||
                    (Array.isArray(q.chosenOptions) && q.chosenOptions.length > 0 && q.chosenOptions.some((opt) => String(opt || "").trim().length > 0)) ||
                    (typeof q.content === "string" && q.content.trim().length > 0)
                );

            if (!isAnswered) {
                unansweredIndexes.push(idx);
            }
        });

        if (unansweredIndexes.length > 0) {
            return {
                canSubmit: false,
                reason: `There are ${unansweredIndexes.length} unanswered questions.`,
                unansweredIndexes,
                errors,
            };
        }

        if (dialogText && isSubmitConfirmDialogBlocked(dialogText)) {
            return {
                canSubmit: false,
                reason: "Submit confirmation dialog warns about unanswered questions.",
                unansweredIndexes,
                errors: [...errors, "Dialog indicates incomplete questions"],
            };
        }

        if (errors.length > 0) {
            return {
                canSubmit: false,
                reason: "Validation error notices detected on the page.",
                unansweredIndexes,
                errors,
            };
        }

        return {
            canSubmit: true,
            reason: "All quality gates passed.",
            unansweredIndexes: [],
            errors: [],
        };
    }

    function normalizeQuestionKey(text) {
        if (!text) return "";
        let clean = String(text)
            .replace(/<[^>]*>/g, " ")
            .replace(/&nbsp;/gi, " ")
            .replace(/\s+/g, " ")
            .trim();

        // Strip leading numbering: "4. ", "Question 4: ", "4) ", "#4 "
        clean = clean.replace(/^(?:question\s*\d+[\s.:)]*|\d+[\s.:)]+)\s*/i, "");

        // Strip point indicators: "1 point", "1 / 1 point", "(1 point)", "1 pt"
        clean = clean.replace(/\(?\b\d+(?:\.\d+)?\s*(?:\/\s*\d+(?:\.\d+)?\s*)?(?:points?|pts?)\b\)?/gi, "");

        // Strip surrounding punctuation and lowercase
        clean = clean
            .replace(/^[^a-zA-Z0-9\u00C0-\u024F\u1EA0-\u1EF9]+/, "")
            .replace(/[^a-zA-Z0-9\u00C0-\u024F\u1EA0-\u1EF9?]+$/, "")
            .trim()
            .toLowerCase();

        return clean;
    }

    function normalizeOptionText(text) {
        if (!text) return "";
        let clean = String(text)
            .replace(/<[^>]*>/g, " ")
            .replace(/&nbsp;/gi, " ")
            .replace(/\s+/g, " ")
            .trim();

        // Strip leading choice indicators: "A. ", "a) ", "1. "
        clean = clean.replace(/^(?:[A-Za-z\d][\s.:)]+)\s*/, "");

        return clean.trim().toLowerCase();
    }

    function isOptionMatching(candidate, target) {
        const c = normalizeOptionText(candidate);
        const t = normalizeOptionText(target);
        if (!c || !t) return false;
        if (c === t) return true;
        if (c.length > 10 && t.length > 10 && (c.includes(t) || t.includes(c))) return true;
        return false;
    }

    function extractPointsFromText(text) {
        const value = String(text || "").trim();
        if (!value) return null;
        const match = value.match(/(?:^|\b)(\d+(?:\.\d+)?)\s*(?:\/|\bof\b)\s*(\d+(?:\.\d+)?)\s*(?:points?|pts?|điểm)\b/i);
        if (match) {
            return {
                earned: parseFloat(match[1]),
                total: parseFloat(match[2]),
            };
        }
        return null;
    }

    function classifyReviewStatus(text, earned, total) {
        if (typeof earned === "number" && typeof total === "number" && total > 0) {
            if (earned >= total) return "correct";
            if (earned === 0) return "incorrect";
            return "partially_correct";
        }

        const value = String(text || "").trim().toLowerCase();
        if (/\b(correct|100%|full credit)\b/.test(value) && !/\bincorrect\b/.test(value)) {
            return "correct";
        }
        if (/\b(incorrect|0%|no credit|didn't select all|did not select all)\b/.test(value)) {
            return "incorrect";
        }
        return "unknown";
    }

    function isSameOptionCombination(optionsA, optionsB) {
        if (!Array.isArray(optionsA) || !Array.isArray(optionsB)) return false;
        if (optionsA.length !== optionsB.length) return false;
        const normA = optionsA.map(normalizeOptionText).filter(Boolean).sort();
        const normB = optionsB.map(normalizeOptionText).filter(Boolean).sort();
        if (normA.length !== normB.length) return false;
        return normA.every((val, idx) => val === normB[idx]);
    }

    function recordQuizAttemptHistory(existingAttempts = [], newAttempt = {}) {
        const list = Array.isArray(existingAttempts) ? [...existingAttempts] : [];
        if (!newAttempt || typeof newAttempt !== "object") return list;

        const attemptNumber = list.length + 1;
        const entry = {
            attemptNumber,
            timestamp: newAttempt.timestamp || Date.now(),
            scorePercent: typeof newAttempt.scorePercent === "number" ? newAttempt.scorePercent : null,
            gradeText: newAttempt.gradeText || (typeof newAttempt.scorePercent === "number" ? `${newAttempt.scorePercent}%` : ""),
            passingThreshold: typeof newAttempt.passingThreshold === "number" ? newAttempt.passingThreshold : DEFAULT_PASSING_PERCENT,
            finalState: newAttempt.finalState || "failed",
            rawFeedback: newAttempt.rawFeedback || "",
            assignmentContext: newAttempt.assignmentContext || "",
            itemPath: newAttempt.itemPath || "",
            questions: Array.isArray(newAttempt.questions) ? newAttempt.questions : [],
        };

        list.push(entry);
        if (list.length > 10) {
            list.splice(0, list.length - 10);
        }
        return list;
    }

    function buildPreviousAttemptReport(attempts = [], currentItem = {}) {
        if (!Array.isArray(attempts) || attempts.length === 0) return null;
        const lastAttempt = attempts[attempts.length - 1];
        if (!lastAttempt) return null;

        const scoreStr = lastAttempt.scorePercent !== null && lastAttempt.scorePercent !== undefined
            ? `${lastAttempt.scorePercent}%`
            : (lastAttempt.gradeText || "chưa đạt");
        const thresholdStr = `${lastAttempt.passingThreshold || DEFAULT_PASSING_PERCENT}%`;
        const isPassed = lastAttempt.finalState === "passed";

        return {
            attemptNumber: lastAttempt.attemptNumber || attempts.length,
            totalAttemptsRecorded: attempts.length,
            previousScore: scoreStr,
            scorePercent: lastAttempt.scorePercent,
            passingThreshold: thresholdStr,
            result: isPassed ? "PASSED" : "FAILED (BELOW PASSING THRESHOLD)",
            status: isPassed ? "passed" : "failed",
            rawFeedback: lastAttempt.rawFeedback || "",
            assignmentContext: lastAttempt.assignmentContext || "",
            itemPath: currentItem.path || lastAttempt.itemPath || "",
            attemptHistory: attempts.map((attempt) => ({
                attemptNumber: attempt.attemptNumber,
                scorePercent: attempt.scorePercent,
                passingThreshold: attempt.passingThreshold,
                finalState: attempt.finalState,
                rawFeedback: attempt.rawFeedback || "",
                assignmentContext: attempt.assignmentContext || "",
                questions: attempt.questions || [],
            })),
            summaryInstruction: isPassed
                ? "The previous attempt PASSED. If retrying to improve score, review confirmed correct answers."
                : `The previous attempt scored ${scoreStr}, which FAILED to meet the passing threshold of ${thresholdStr}. DO NOT repeat answers that were marked INCORRECT (0 points) or combinations that failed. Retain answers marked CORRECT (full credit), and switch to better alternative options for questions that scored 0 points.`,
            submittedQuestions: (lastAttempt.questions || []).map((q, idx) => ({
                questionIndex: idx,
                prompt: q.prompt || "",
                type: q.type || "single_choice",
                submittedOptions: q.chosenOptions || [],
                allOptions: q.allOptions || [],
                resultStatus: q.status || "unpassed",
                points: q.pointsEarned !== undefined && q.pointsTotal !== undefined
                    ? `${q.pointsEarned}/${q.pointsTotal}`
                    : (q.status === "correct" ? "Full credit" : (q.status === "incorrect" ? "0 points" : undefined)),
                feedback: q.feedback || undefined,
            })),
        };
    }

    function formatQuestionPreviousAttempt(previousQuestion, quizScore = null, passingThreshold = DEFAULT_PASSING_PERCENT) {
        if (!previousQuestion || !Array.isArray(previousQuestion.chosenOptions) || previousQuestion.chosenOptions.length === 0) {
            return null;
        }

        const chosenStr = JSON.stringify(previousQuestion.chosenOptions);
        const scoreText = quizScore !== null && quizScore !== undefined ? ` (Quiz overall score: ${quizScore}%)` : "";
        const feedbackText = previousQuestion.feedback && previousQuestion.feedback !== "Incorrect" && previousQuestion.feedback !== "Passed"
            ? ` COURSERA FEEDBACK / EXPLANATION: "${previousQuestion.feedback}". CRITICAL: Read this explanation carefully, avoid repeating this mistake, and choose the correct answer that aligns with Coursera's explanation.`
            : "";

        if (previousQuestion.status === "correct") {
            return `PREVIOUS ATTEMPT${scoreText}: Submitted ${chosenStr} -> STATUS: CORRECT (Full Credit). RETAIN AND SELECT THIS ANSWER.`;
        }

        if (previousQuestion.status === "incorrect") {
            return `PREVIOUS ATTEMPT${scoreText}: Submitted ${chosenStr} -> STATUS: INCORRECT (0 points). CRITICAL: DO NOT SELECT ${chosenStr} AGAIN! Choose a different option.${feedbackText}`;
        }

        return `PREVIOUS ATTEMPT${scoreText}: Submitted ${chosenStr} in a failed quiz attempt (< ${passingThreshold}%). Analyze carefully and consider choosing an alternative option.${feedbackText}`;
    }

    function mergeQuestionMemory(existingMemory, newReview) {
        if (!newReview || typeof newReview !== "object" || (!newReview.prompt && !existingMemory)) {
            return existingMemory || null;
        }

        const prompt = newReview.prompt || (existingMemory && existingMemory.prompt) || "";
        const fingerprint = newReview.fingerprint || normalizeQuestionKey(prompt);
        const memory = existingMemory ? { ...existingMemory } : {
            prompt,
            fingerprint,
            type: newReview.type || "single_choice",
            confirmedCorrectOptions: [],
            knownWrongOptions: [],
            wrongAttempts: [],
            unpassedAttempts: [],
            revealedAnswer: "",
            feedbacks: [],
            lastFeedback: "",
            updatedAt: Date.now(),
        };

        memory.updatedAt = Date.now();
        if (prompt && !memory.prompt) memory.prompt = prompt;
        if (newReview.type) memory.type = newReview.type;

        // Track Coursera feedback / hints
        if (newReview.feedback && newReview.feedback !== "Incorrect" && newReview.feedback !== "Passed") {
            memory.lastFeedback = newReview.feedback;
            if (!Array.isArray(memory.feedbacks)) {
                memory.feedbacks = [];
            }
            if (!memory.feedbacks.some((f) => isOptionMatching(f, newReview.feedback))) {
                memory.feedbacks.push(newReview.feedback);
            }
        }

        // If Coursera explicitly revealed the correct answer
        if (newReview.revealedAnswer) {
            memory.revealedAnswer = newReview.revealedAnswer;
            const normRevealed = normalizeOptionText(newReview.revealedAnswer);
            if (normRevealed && !memory.confirmedCorrectOptions.some((opt) => isOptionMatching(opt, normRevealed))) {
                memory.confirmedCorrectOptions = [newReview.revealedAnswer];
            }
        }

        // Options specifically flagged as wrong by Coursera feedback (e.g. "This should not be selected")
        if (Array.isArray(newReview.specificWrongOptions) && newReview.specificWrongOptions.length > 0) {
            const currentWrong = memory.knownWrongOptions || [];
            newReview.specificWrongOptions.forEach((opt) => {
                if (!currentWrong.some((w) => isOptionMatching(w, opt))) {
                    currentWrong.push(opt);
                }
            });
            memory.knownWrongOptions = currentWrong;
        }

        if (newReview.status === "correct") {
            if (Array.isArray(newReview.chosenOptions) && newReview.chosenOptions.length > 0) {
                // Ensure unique options
                const existing = memory.confirmedCorrectOptions || [];
                const merged = [...existing];
                newReview.chosenOptions.forEach((chosen) => {
                    if (!merged.some((opt) => isOptionMatching(opt, chosen))) {
                        merged.push(chosen);
                    }
                });
                memory.confirmedCorrectOptions = merged;
            }
        } else if (newReview.status === "incorrect") {
            if (Array.isArray(newReview.chosenOptions) && newReview.chosenOptions.length > 0) {
                // Purge any chosen options from confirmedCorrectOptions to prevent stale/corrupt pre-filling
                if (memory.type !== "multi_select" && Array.isArray(memory.confirmedCorrectOptions)) {
                    memory.confirmedCorrectOptions = memory.confirmedCorrectOptions.filter(
                        (c) => !newReview.chosenOptions.some((chosen) => isOptionMatching(c, chosen))
                    );
                }

                const chosenNorm = newReview.chosenOptions.map(normalizeOptionText).sort().join(" || ");
                const exists = (memory.wrongAttempts || []).some((w) =>
                    (w.options || []).map(normalizeOptionText).sort().join(" || ") === chosenNorm
                );
                if (!exists) {
                    memory.wrongAttempts = [
                        ...(memory.wrongAttempts || []),
                        {
                            options: newReview.chosenOptions,
                            timestamp: Date.now(),
                            feedback: newReview.feedback || "Incorrect",
                        },
                    ];
                }

                // For single_choice questions, any chosen option that yielded 0 points is definitely wrong!
                const isSingleChoice = memory.type === "single_choice" || memory.type === "mcq" ||
                    newReview.type === "single_choice" ||
                    (memory.type !== "multi_select" && !newReview.hasCheckbox && Array.isArray(newReview.chosenOptions) && newReview.chosenOptions.length === 1);

                if (isSingleChoice) {
                    newReview.chosenOptions.forEach((opt) => {
                        if (!memory.knownWrongOptions.some((w) => isOptionMatching(w, opt))) {
                            memory.knownWrongOptions.push(opt);
                        }
                    });
                }
            }
        } else if (newReview.status === "unpassed_attempt") {
            // Track unpassed attempt combinations without falsely marking individual options as knownWrong
            if (Array.isArray(newReview.chosenOptions) && newReview.chosenOptions.length > 0) {
                const chosenNorm = newReview.chosenOptions.map(normalizeOptionText).sort().join(" || ");
                const exists = (memory.unpassedAttempts || []).some((w) =>
                    (w.options || []).map(normalizeOptionText).sort().join(" || ") === chosenNorm
                );
                if (!exists) {
                    memory.unpassedAttempts = [
                        ...(memory.unpassedAttempts || []),
                        {
                            options: newReview.chosenOptions,
                            timestamp: Date.now(),
                            feedback: newReview.feedback || "",
                        },
                    ];
                }
            }
        }

        // Final sanitization: ensure no knownWrongOption exists in confirmedCorrectOptions or revealedAnswer
        if (Array.isArray(memory.confirmedCorrectOptions) && Array.isArray(memory.knownWrongOptions) && memory.knownWrongOptions.length > 0) {
            memory.confirmedCorrectOptions = memory.confirmedCorrectOptions.filter(
                (c) => !memory.knownWrongOptions.some((w) => isOptionMatching(w, c))
            );
        }
        if (memory.revealedAnswer && Array.isArray(memory.knownWrongOptions) && memory.knownWrongOptions.some((w) => isOptionMatching(w, memory.revealedAnswer))) {
            memory.revealedAnswer = "";
        }

        if (Array.isArray(newReview.confirmedCorrectOptions)) {
            const confirmed = [...(memory.confirmedCorrectOptions || [])];
            newReview.confirmedCorrectOptions.forEach((option) => {
                if (!confirmed.some((c) => isOptionMatching(c, option))) confirmed.push(option);
            });
            memory.confirmedCorrectOptions = confirmed;
            memory.knownWrongOptions = (memory.knownWrongOptions || []).filter((wrong) =>
                !newReview.confirmedCorrectOptions.some((correct) => isOptionMatching(correct, wrong)));
        }
        if (memory.type === "multi_select") {
            memory.confirmedCompleteSet = newReview.status === "correct";
        }
        return memory;
    }

    function formatMemoryForPrompt(memory) {
        if (!memory) return null;
        const parts = [];

        if (memory.revealedAnswer) {
            parts.push(`PROVEN CORRECT ANSWER: "${memory.revealedAnswer}". SELECT THIS ANSWER.`);
        } else if (Array.isArray(memory.confirmedCorrectOptions) && memory.confirmedCorrectOptions.length > 0) {
            parts.push(`CONFIRMED CORRECT ANSWER(S) FROM PREVIOUS PASS: ${JSON.stringify(memory.confirmedCorrectOptions)}. SELECT THESE OPTIONS.`);
        }

        if (Array.isArray(memory.knownWrongOptions) && memory.knownWrongOptions.length > 0) {
            parts.push(`CRITICAL - DO NOT SELECT THESE CONFIRMED WRONG OPTION(S): ${JSON.stringify(memory.knownWrongOptions)}.`);
        }

        if (Array.isArray(memory.wrongAttempts) && memory.wrongAttempts.length > 0) {
            const combinations = memory.wrongAttempts.map((w) => {
                const optStr = JSON.stringify(w.options);
                if (w.feedback && w.feedback !== "Incorrect" && w.feedback !== "Passed") {
                    return `${optStr} (Coursera feedback: "${w.feedback}")`;
                }
                return optStr;
            }).join(", ");
            parts.push(`FAILED COMBINATION(S) TRIED IN PREVIOUS ATTEMPTS (SCORED 0 POINTS): ${combinations}. DO NOT REPEAT THESE COMBINATIONS.`);
        }

        if (Array.isArray(memory.unpassedAttempts) && memory.unpassedAttempts.length > 0) {
            const combinations = memory.unpassedAttempts.map((w) => {
                const optStr = JSON.stringify(w.options);
                if (w.feedback && w.feedback !== "Incorrect" && w.feedback !== "Passed") {
                    return `${optStr} (Coursera feedback: "${w.feedback}")`;
                }
                return optStr;
            }).join(", ");
            parts.push(`OPTIONS SUBMITTED IN UNPASSED QUIZ ATTEMPTS: ${combinations}. Re-evaluate carefully.`);
        }

        if (Array.isArray(memory.feedbacks) && memory.feedbacks.length > 0) {
            const usefulFeedbacks = memory.feedbacks.filter((f) => f && f !== "Incorrect" && f !== "Passed");
            if (usefulFeedbacks.length > 0) {
                parts.push(`COURSERA EXPLANATIONS / HINTS FROM PREVIOUS ATTEMPTS: ${JSON.stringify(usefulFeedbacks)}. Use these hints to identify the true correct answer.`);
            }
        }

        return parts.length ? parts.join(" ") : null;
    }

    function classifyQuizStateText(text, passingThreshold = DEFAULT_PASSING_PERCENT) {
        const value = String(text || "").trim().toLowerCase();
        if (!value) {
            return "pending";
        }

        if (
            /(haven't submitted|have not submitted|not submitted yet|not submitted|your grade\s*--|grade\s*--|resume\b|start quiz|begin quiz|start new attempt|start attempt|start assignment|begin assignment|start to submit|time to submit)/.test(value)
        ) {
            return "pending";
        }

        const gradeResultMatch = value.match(/(?:your grade|grade received|highest score|latest score)[\s:]*(\d+(?:\.\d+)?)\s*%/i);
        if (gradeResultMatch) {
            const dynamicThreshold = extractPassingThreshold(value, passingThreshold);
            const score = parseFloat(gradeResultMatch[1]);
            if (!Number.isNaN(score)) {
                return score >= dynamicThreshold ? "passed" : "failed";
            }
        }

        if (
            /(congratulations|you passed|passed this|completed this|you passed this assignment|you passed this quiz)/.test(value)
        ) {
            return "passed";
        }

        if (/(try again|did not pass|failed|incorrect|not passed|retake)/.test(value)) {
            return "failed";
        }

        return "pending";
    }

    function shouldTreatQuizStateAsFinal(quizState, submissionStarted) {
        if (!submissionStarted) {
            return false;
        }

        return quizState === "passed" || quizState === "failed";
    }

    function shouldTreatExistingAttemptAsPassed({
        quizState,
        hasNextButton,
        startLabel = "",
        pageText = "",
        passingThreshold = DEFAULT_PASSING_PERCENT,
    }) {
        if (quizState !== "passed" || !hasNextButton) {
            return false;
        }

        const startValue = String(startLabel || "").trim().toLowerCase();
        if (/^(resume|start|begin|open quiz|start quiz)/.test(startValue)) {
            return false;
        }

        const textValue = String(pageText || "").trim().toLowerCase();
        if (
            /(haven't submitted|have not submitted|not submitted yet|not submitted|your grade\s*--|grade\s*--|resume\b|start assignment|begin assignment)/.test(textValue)
        ) {
            return false;
        }

        if (/(try again|did not pass|failed|not passed)/.test(textValue)) {
            return false;
        }

        const dynamicThreshold = extractPassingThreshold(textValue, passingThreshold);
        const gradeMatch = textValue.match(/\byour grade\b[^\d]{0,40}(\d+(?:\.\d+)?)\s*%/i);
        if (gradeMatch) {
            const score = parseFloat(gradeMatch[1]);
            if (!Number.isNaN(score) && score < dynamicThreshold) {
                return false;
            }
        }

        return (
            /(congratulations|you passed this assignment|you passed this quiz|you passed this)/.test(textValue) ||
            Boolean(gradeMatch && parseFloat(gradeMatch[1]) >= dynamicThreshold)
        );
    }

    function resolveStartActionState({
        hasStartButton,
        hasStartModalButton = false,
        hasQuizWorkControls = false,
        startClickedAt,
        now,
        transitionTimeoutMs,
    }) {
        if (hasStartModalButton) {
            return "confirm_modal";
        }

        if (startClickedAt) {
            if (hasQuizWorkControls || !hasStartButton) {
                return "gone";
            }
            if (now - startClickedAt >= transitionTimeoutMs) {
                return "timeout";
            }
            return "wait";
        }

        if (hasStartButton) {
            return "click";
        }

        return "gone";
    }

    function resolveAttemptRelayState({ controlsReadyAt, now, delayMs }) {
        if (!controlsReadyAt) {
            return "wait";
        }

        return now - controlsReadyAt >= delayMs ? "ready" : "wait";
    }

    function resolveSolverFillState({
        baselineAnsweredCount = 0,
        baselineSignature = "",
        currentAnsweredCount = 0,
        currentSignature = "",
        relayedAt,
        lastChangedAt,
        now,
        minWaitMs,
        stableMs,
        timeoutMs,
    }) {
        const elapsedSinceRelay = now - relayedAt;
        const changed =
            currentSignature !== baselineSignature ||
            currentAnsweredCount > baselineAnsweredCount;
        const hasAnswers = currentAnsweredCount > 0;

        if (elapsedSinceRelay >= timeoutMs && (!changed || !hasAnswers)) {
            return "timeout";
        }

        if (!changed || !hasAnswers) {
            return "wait";
        }

        if (elapsedSinceRelay < minWaitMs) {
            return "wait";
        }

        if (now - lastChangedAt < stableMs) {
            return "wait";
        }

        return "ready";
    }

    function buildRunnerLogMessage(eventName, details = {}) {
        const cleanDetails = Object.fromEntries(
            Object.entries(details).filter(([, value]) => value !== undefined)
        );

        const suffix = Object.keys(cleanDetails).length
            ? ` ${JSON.stringify(cleanDetails)}`
            : "";

        return `[AutoCoursera][MakeDoneAll] ${eventName}${suffix}`;
    }

    function buildRunnerLogEntry(eventName, details = {}, context = {}) {
        return {
            timestamp: context.timestamp || new Date().toISOString(),
            eventName,
            level: context.level || "info",
            mode: context.mode || "full",
            path: normalizePath(context.path || ""),
            details: Object.fromEntries(
                Object.entries(details).filter(([, value]) => value !== undefined)
            ),
            message: buildRunnerLogMessage(eventName, details),
        };
    }

    function formatRunnerLogExport(entries = []) {
        return entries
            .map((entry) => {
                const timestamp = entry.timestamp || new Date().toISOString();
                const level = String(entry.level || "info").toUpperCase();
                const mode = entry.mode || "full";
                const path = normalizePath(entry.path || "");
                const pathSegment = path ? ` ${path}` : "";
                return `${timestamp} [${level}] [${mode}]${pathSegment} ${entry.message}`.trim();
            })
            .join("\n");
    }

    function describeRunnerLogEntry(entry = {}) {
        const details = entry.details || {};
        const title = details.title ? `"${details.title}"` : "item";

        if (entry.eventName === "quiz_scan_item") {
            const decisionText = {
                skip_non_quiz: "bỏ qua",
                skip_done: "bỏ qua đã làm",
                skip_already_skipped: "bỏ qua đã skip trước đó",
                start_quiz: "bắt đầu quiz",
                retry_quiz: "làm lại quiz (chưa đạt điểm)",
                start_app_item: "bắt đầu ungraded app item",
            }[details.decision] || "đang xử lý";

            return `Đọc ${title} => ${decisionText}`;
        }

        const eventMap = {
            quiz_process_run: "Bắt đầu quét danh sách quiz",
            next_pending_quiz: `Đọc ${title} => bắt đầu quiz`,
            next_pending_app_item: `Đọc ${title} => bắt đầu ungraded app item`,
            navigate_to_item: `Mở ${title}`,
            app_item_start: `Bắt đầu xử lý app item ${title}`,
            app_item_accept_agreement: 'Check "I agree to use this app responsibly"',
            app_item_wait_before_launch: `Chờ ${details.seconds || 0}s trước khi bấm Launch App`,
            app_item_launch_clicked: 'Bấm "Launch App"',
            app_item_wait_after_launch: `Chờ ${details.seconds || 0}s sau khi bấm Launch App`,
            app_item_skipped: `${title} => bỏ qua app item`,
            quiz_start: `Bắt đầu xử lý ${title}`,
            page_bootstrap: `Trang được nạp lại (${details.navigationType || "unknown"})`,
            page_previous_lifecycle: `Trang trước đó đã rời bởi ${details.eventName || "unknown"}`,
            quiz_dom_snapshot: `DOM snapshot [${details.stage || "unknown"}]: start=${details.hasStartButton ? "yes" : "no"}, submit=${details.hasSubmitButton ? "yes" : "no"}, confirm=${details.hasConfirmButton ? "yes" : "no"}, next=${details.hasNextButton ? "yes" : "no"}, checkbox=${details.hasAgreementCheckbox ? "yes" : "no"}, state=${details.quizState || "pending"}`,
            quiz_existing_passed_result: `Phát hiện quiz đã có kết quả sẵn cho ${title}`,
            quiz_run_open_attempt: `Mở quiz ${title}`,
            quiz_open_attempt: `Mở quiz ${title}`,
            wait_page_load: `Chờ ${details.seconds || 0}s để load trang`,
            quiz_wait_attempt_relay: `Chờ ${details.seconds || 0}s trước khi gọi AI`,
            quiz_attempt_relayed: "Gọi AI tính toán và fill data",
            quiz_wait_solver_fill: `Chờ AI fill đáp án (${details.answeredCount || 0} đáp án)`,
            quiz_solver_fill_progress: `AI đang fill đáp án (${details.answeredCount || 0} đáp án)`,
            quiz_solver_fill_ready: `AI đã fill đáp án (${details.answeredCount || 0} đáp án)`,
            quiz_dom_questions_found: `Tìm thấy ${details.count || 0} câu hỏi trên trang`,
            quiz_ai_request_start: `Đang gửi ${details.questionCount || 0} câu hỏi tới AI (APIZ)...`,
            quiz_chatgpt_web_start: `Đang hỏi ChatGPT ${details.responseMode === "fast" ? "nhanh" : "Pro (suy luận cao nhất)"}: ${details.unresolvedCount || details.questionCount || 0} câu hỏi; chờ phản hồi hoàn tất.`,
            quiz_ai_answers_received: `AI đã trả về ${details.answerCount || 0} đáp án`,
            quiz_dom_answers_filled: `Đã tự động điền ${details.filledCount || 0}/${details.totalQuestions || 0} câu hỏi`,
            quiz_dom_no_questions: "Không tìm thấy câu hỏi trong DOM",
            quiz_ai_error: `Lỗi AI: ${details.error || details.message || ""}`.trim(),
            quiz_ai_failed_max_retries: `AI giải bài thất bại sau ${details.attempts || 3} lần thử. Đã tạm dừng lại để bạn kiểm tra.`,
            run_paused: "Đã tạm dừng tiến trình tự động.",
            quiz_ai_text_retry: "Gửi lại câu hỏi sang chế độ văn bản (bỏ qua ảnh)...",
            quiz_essay_screenshot_captured: `Chụp ảnh màn hình cho câu hỏi tự luận (${details.textQuestionCount || 1} câu)`,
            quiz_vision_analysis_start: "Chụp ảnh màn hình gửi AI Vision phân tích tình trạng giao diện...",
            quiz_vision_decision_received: `AI Vision: ${details.action || "none"} -> "${details.targetText || ''}" (${details.reason || ''})`.trim(),
            quiz_vision_action_clicked: `AI Vision tự động bấm: "${details.targetText || ''}"`,
            quiz_vision_action_failed: `Không tìm thấy nút "${details.targetText || ''}" trên trang`,
            quiz_open_view_feedback_to_learn: "Phát hiện điểm chưa đạt, mở View feedback để học lỗi sai & gợi ý từ Coursera",
            quiz_feedback_inspected: `Đã lưu lại toàn bộ nội dung/gợi ý phản hồi của khung feedback (${details.questionCount || 0} câu)`,
            quiz_feedback_back_clicked: "Quay lại màn hình tổng kết bài quiz",
            quiz_attempt_locked: `Bài quiz bị khóa lượt làm (24h/hết lượt thử): ${details.reason || ""}`.trim(),
            quiz_luna_autofill_start: `Luna đang lấy đáp án để tự điền (${details.unresolvedCount || 0} câu)`,
            quiz_luna_autofill_cancelled: "Đã tắt tự điền qua Luna; bỏ qua đáp án đang chờ",
            quiz_scroll_range_unlocked: "Đã tự động scroll toàn bộ trang & mở khóa vùng cuộn để đọc đầy đủ nội dung câu hỏi",
            quiz_assignment_context_found: "Đã trích xuất hướng dẫn/ngữ cảnh bài tập để gửi kèm AI",
            quiz_click_start: "Nhấn Start quiz",
            quiz_click_modal_continue: 'Bấm "Continue" trên hộp thoại Start new attempt',
            quiz_accept_honor_code: 'Check "I understand and agree"',
            quiz_click_submit: "Submit quiz",
            quiz_confirm_submit: "Confirm submit",
            quiz_submit_blocked_by_quality_gate: `Chặn submit: chưa điền đủ (${details.unansweredCount || 0} câu) hoặc có cảnh báo lỗi`,
            quiz_confirm_blocked_unanswered_in_dialog: "Hủy popup submit: Coursera phát hiện còn câu hỏi chưa điền",
            quiz_quality_gate_passed: `Kiểm tra chất lượng đạt chuẩn: toàn bộ ${details.totalQuestions || 0} câu hỏi đã được điền hợp lệ`,
            wait_quiz_result: `Chờ ${details.seconds || 0}s để nhận kết quả`,
            quiz_result_passed: "Quiz đã pass",
            quiz_result_failed: "Quiz không pass",
            quiz_click_next_item: 'Chọn "Next item" trở về',
            quiz_click_continue: 'Chọn "Continue"',
            quiz_retry_attempt: `Làm lại quiz lần ${details.attemptNumber || 1}/${(details.maxRetries || 0) + 1} (lần trước: ${details.previousScore || 'chưa đạt'})`,
            quiz_memory_updated: `Ghi nhớ kết quả quiz (${details.recordedCount || 0} câu, lần ${details.totalAttempts || 1}: ${details.scorePercent !== null && details.scorePercent !== undefined ? details.scorePercent + '%' : (details.finalState || '')})`,
            quiz_memory_prefilled: `Áp dụng đáp án đúng đã ghi nhớ cho ${details.resolvedCount || 0}/${details.totalQuestions || 0} câu hỏi`,
            quiz_memory_avoided_wrong: `Tránh đáp án sai đã ghi nhớ cho "${details.question ? details.question.slice(0, 30) + '...' : ''}"`,
            quiz_memory_avoided_wrong_multi: `Loại bỏ đáp án sai đã ghi nhớ (${details.avoidedWrong || ''})`,
            quiz_loop_detected_altering_combination: "Phát hiện tổ hợp từng bị 0 điểm, tự động đổi phương án khác để tránh lặp",
            quiz_previous_attempt_attached: `Đính kèm kết quả lần trước (${details.previousScore || 'chưa đạt'}) và toàn bộ đáp án cũ vào AI`,
            peer_tab_click_my_submission: "Chuyển sang tab My submission để làm bài nộp",
            peer_submission_start: `Bắt đầu làm bài tự luận / nộp bài (${title})`,
            peer_submission_filled: `Đã điền tiêu đề và ${details.filledCount || 0} phần bài làm`,
            peer_submission_submitted: "Đã nộp bài peer assignment thành công",
            quiz_run_skipped: `${title} => bỏ qua`,
            quiz_run_finished: "Hoàn thành quiz run",
            quiz_run_aborted: `Dừng quiz run: ${details.message || ""}`.trim(),
            quiz_error: `Lỗi: ${details.message || ""}`.trim(),
            runner_error: `Lỗi: ${details.message || ""}`.trim(),
        };

        return eventMap[entry.eventName] || entry.message || entry.eventName || "";
    }

    function flattenCourseStructure(payload) {
        const modules = extractModules(payload);
        const items = [];

        modules.forEach((module) => {
            const moduleId = module.id || module.moduleId || module.slug || "";
            const moduleTitle = module.name || module.title || module.moduleTitle || "";

            const moduleItems = extractModuleItems(module);
            moduleItems.forEach((item, index) => {
                const flattened = flattenItem(item, moduleId, moduleTitle, index);
                if (flattened) {
                    items.push(flattened);
                }
            });
        });

        return dedupeItems(items);
    }

    function extractModules(payload) {
        if (!payload || typeof payload !== "object") {
            return [];
        }

        const linked = payload.linked || {};
        const directModules =
            linked["onDemandModules.v1"] ||
            linked["onDemandModules"] ||
            payload.modules ||
            payload.elements ||
            [];

        if (Array.isArray(directModules) && directModules.length) {
            return directModules;
        }

        return collectObjects(payload).filter((entry) => {
            if (!entry || typeof entry !== "object") {
                return false;
            }

            const candidates = [
                entry.elements,
                entry.items,
                entry.contentSummaries,
                entry.moduleItems,
            ];

            return candidates.some((candidate) => Array.isArray(candidate) && candidate.length);
        });
    }

    function extractModuleItems(module) {
        const collections = [
            module.elements,
            module.items,
            module.contentSummaries,
            module.moduleItems,
        ];

        for (const collection of collections) {
            if (Array.isArray(collection) && collection.length) {
                return collection;
            }
        }

        return [];
    }

    function flattenItem(item, moduleId, moduleTitle, fallbackIndex) {
        if (!item || typeof item !== "object") {
            return null;
        }

        const title = item.name || item.title || item.label || `Item ${fallbackIndex + 1}`;
        const path = resolveItemPath(item);

        if (!path) {
            return null;
        }

        return {
            id: item.id || item.slug || path,
            title,
            path,
            type: guessItemType(path, title),
            moduleId,
            moduleTitle,
        };
    }

    function resolveItemPath(item) {
        const candidates = [
            item.path,
            item.url,
            item.href,
            item.definition && item.definition.url,
            item.contentSummary && item.contentSummary.url,
            item.contentSummary && item.contentSummary.path,
            item.contentSummary &&
                item.contentSummary.definition &&
                item.contentSummary.definition.url,
            item.content && item.content.url,
        ];

        for (const candidate of candidates) {
            const normalized = normalizePath(candidate);
            if (normalized && normalized.includes("/learn/")) {
                return normalized;
            }
        }

        return "";
    }

    function dedupeItems(items) {
        const seen = new Set();
        return items.filter((item) => {
            if (!item.path || seen.has(item.path)) {
                return false;
            }

            seen.add(item.path);
            return true;
        });
    }

    function collectObjects(value, bucket = []) {
        if (!value || typeof value !== "object") {
            return bucket;
        }

        if (Array.isArray(value)) {
            value.forEach((entry) => collectObjects(entry, bucket));
            return bucket;
        }

        bucket.push(value);
        Object.values(value).forEach((entry) => collectObjects(entry, bucket));
        return bucket;
    }

    function normalizeVisionDecision(decision = {}) {
        if (!decision || typeof decision !== "object") {
            return { action: "none", targetText: "", targetSelector: "", reason: "" };
        }
        const action = String(decision.action || "none").toLowerCase().trim();
        const validActions = ["click", "wait", "refresh", "none"];
        return {
            action: validActions.includes(action) ? action : "none",
            targetText: String(decision.targetText || decision.buttonText || "").trim(),
            targetSelector: String(decision.targetSelector || "").trim(),
            reason: String(decision.reason || "").trim(),
        };
    }

    function isMatchingClickableText(elementText, targetText) {
        const elem = String(elementText || "").replace(/\s+/g, " ").trim().toLowerCase();
        const target = String(targetText || "").replace(/\s+/g, " ").trim().toLowerCase();
        if (!elem || !target) return false;
        if (elem === target) return true;
        if (elem.startsWith(target) || elem.endsWith(target)) return true;
        if (target.length >= 3 && elem.includes(target)) return true;
        return false;
    }

    function classifyOptionFeedback(text, selected) {
        const value = String(text || "");
        if (/should not be selected|incorrect option/i.test(value)) return "incorrect";
        // Question-level explanations often say "Try again ... Correct answer: X".
        // The negative verdict belongs to the selected choice; don't let the later
        // answer-reveal phrase relabel that same choice as correct.
        if (/try again|not quite|incorrect answer|wrong answer|not correct/i.test(value)) {
            return selected ? "incorrect" : "correct";
        }
        if (/should be selected|correct answer\s*:/i.test(value)) return "correct";
        if (/nice work|that's correct|that’s correct/i.test(value)) return selected ? "correct" : "unknown";
        return "unknown";
    }

    function collectKnownWrongOptions(memory, previousQuestion, questionType) {
        const knownWrong = memory && Array.isArray(memory.knownWrongOptions)
            ? [...memory.knownWrongOptions]
            : [];
        if (previousQuestion && Array.isArray(previousQuestion.specificWrongOptions)) {
            knownWrong.push(...previousQuestion.specificWrongOptions);
        }
        // A zero-point checkbox combination proves that the combination failed,
        // not that every member option was wrong.
        if (questionType === "single_choice" || questionType === "mcq") {
            if (Array.isArray(memory?.wrongAttempts)) {
                memory.wrongAttempts.forEach((attempt) => {
                    knownWrong.push(...(Array.isArray(attempt.options) ? attempt.options : [attempt.options]));
                });
            }
            if (previousQuestion && previousQuestion.status === "incorrect") {
                knownWrong.push(...(previousQuestion.chosenOptions || []));
            }
        }
        return [...new Map(knownWrong.filter(Boolean).map((option) => [String(option).trim().toLowerCase(), option])).values()];
    }

    function filterConfirmedOptions(memory, previousQuestion, questionType) {
        const confirmed = memory && Array.isArray(memory.confirmedCorrectOptions)
            ? memory.confirmedCorrectOptions
            : [];
        const knownWrong = collectKnownWrongOptions(memory, previousQuestion, questionType);
        return confirmed.filter((option) => !knownWrong.some((wrong) => isOptionMatching(wrong, option)));
    }

    function resolveConfirmedOptionIndexes(options, memory, questionType) {
        if (!Array.isArray(options) || !memory) return [];
        if (questionType === "multi_select" && memory.confirmedCompleteSet !== true) return [];
        const confirmed = filterConfirmedOptions(memory, null, questionType);
        const indexes = options.reduce((matches, option, index) => {
            if (confirmed.some((answer) => isOptionMatching(option, answer))) matches.push(index);
            return matches;
        }, []);
        if (questionType === "multi_select" && indexes.length !== confirmed.length) return [];
        return questionType === "single_choice" || questionType === "mcq" ? indexes.slice(0, 1) : indexes;
    }

    async function sendFullFeedback({ text, send }) {
        if (!text || !String(text).trim()) throw new Error("Feedback page is empty.");
        const fullText = String(text);
        const chunkSize = 4000;
        const maxChunks = 4;
        const chunkCount = Math.ceil(fullText.length / chunkSize);
        if (chunkCount > maxChunks) {
            throw new Error(`Feedback dài ${fullText.length} ký tự; đã lưu đầy đủ nhưng vượt giới hạn gửi an toàn ${maxChunks} phần.`);
        }
        const parts = [];
        for (let offset = 0; offset < fullText.length; offset += chunkSize) {
            parts.push(fullText.slice(offset, offset + chunkSize));
        }
        const notes = [];
        for (let index = 0; index < parts.length; index++) {
            notes.push(await send(parts[index], index, parts.length));
        }
        return notes;
    }

    function copyRenderedQuestionText(container, doc = document, win = window) {
        if (!container) return "";
        const selection = win.getSelection();
        if (!selection) return "";
        const previous = Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i).cloneRange());
        try {
            const range = doc.createRange();
            range.selectNodeContents(container);
            selection.removeAllRanges();
            selection.addRange(range);
            return selection.toString().trim();
        } finally {
            selection.removeAllRanges();
            previous.forEach((range) => selection.addRange(range));
        }
    }

    async function solveQuizTextFirst({ prompt, solve, capture, onFallback = () => {} }) {
        const validate = (answers) => {
            if (!Array.isArray(answers) || !answers.length) throw new Error("AI returned no answers.");
            return answers;
        };
        try {
            return validate(await solve(prompt, {}));
        } catch (error) {
            if (/CHATGPT_|PRO_|NOT_LOGGED_IN|SEND_BUTTON|SEND_NOT_CONFIRMED/.test(error?.message || "")) throw error;
            onFallback(error);
            const captured = await capture();
            const screenshotUrls = Array.isArray(captured) ? captured.filter(Boolean) : (captured ? [captured] : []);
            if (!screenshotUrls.length) throw error;
            return validate(await solve(prompt, { screenshotUrl: screenshotUrls[0], screenshotUrls }));
        }
    }

    function resolveAssignmentTransition({ readyState, text = "", elapsedMs = 0, stableForMs = 0 } = {}) {
        if (elapsedMs >= 8000 && readyState === "complete" && hasUsableQuizPageText(text) && stableForMs >= 3000) return "ready";
        return elapsedMs >= 45000 ? "timeout" : "wait";
    }

    function resolveQuizPageLoadState({ readyState, text = "", elapsedMs = 0, timeoutMs = 30000 } = {}) {
        if (readyState === "complete" && hasUsableQuizPageText(text)) return "ready";
        return elapsedMs >= timeoutMs ? "timeout" : "wait";
    }

    function hasUsableQuizPageText(text) {
        const value = String(text || "").replace(/\s+/g, " ").trim();
        return value.length >= 40 || /ready to start.*(?:activity|quiz|assignment)|\b(?:start|resume)\s+(?:assignment|quiz)\b|\byour grade\b/i.test(value);
    }

    const api = {
        classifyOptionFeedback,
        collectKnownWrongOptions,
        filterConfirmedOptions,
        resolveConfirmedOptionIndexes,
        sendFullFeedback,
        resolveAssignmentTransition,
        copyRenderedQuestionText,
        solveQuizTextFirst,
        resolveQuizPageLoadState,
        DEFAULT_PASSING_PERCENT,
        buildCourseMaterialsUrl,
        buildPreviousAttemptReport,
        buildRunnerLogEntry,
        buildRunnerLogMessage,
        checkQuizSubmissionQualityGates,
        classifyQuizStateText,
        classifyReviewStatus,
        describeRunnerLogEntry,
        extractCourseSlug,
        extractGradePercentage,
        extractItemId,
        extractPassingThreshold,
        extractPointsFromText,
        flattenCourseStructure,
        formatMemoryForPrompt,
        formatQuestionPreviousAttempt,
        formatRunnerLogExport,
        getItemSlug,
        guessItemType,
        inferSidebarCompletionSignals,
        isCancelActionLabel,
        isContinueActionLabel,
        isEligibleQuizItem,
        isEligibleQuizRunItem,
        isMatchingClickableText,
        isOptionMatching,
        isPathSkipped,
        isPeerAssignmentSubmitted,
        isQuizAttemptLocked,
        isRetryActionLabel,
        isSameOptionCombination,
        isStartActionLabel,
        isSubmitActionLabel,
        isSubmitConfirmDialogBlocked,
        isTextQuestionAnswered,
        isUnansweredNoticeText,
        isUngradedAppItem,
        matchesItemPath,
        mergeQuestionMemory,
        normalizeOptionText,
        normalizeQuestionKey,
        normalizeQuizRetryCount,
        normalizeQuizResultSettleSeconds,
        normalizePath,
        normalizeVisionDecision,
        pickFirstIncomplete,
        pickFirstIncompleteQuiz,
        recordQuizAttemptHistory,
        resolveAttemptRelayState,
        resolveStartActionState,
        resolveSolverFillState,
        shouldTreatExistingAttemptAsPassed,
        shouldTreatQuizStateAsFinal,
    };

    if (typeof module !== "undefined" && module.exports) {
        module.exports = api;
    } else {
        global.CourseRunnerHelpers = api;
    }
})(typeof window !== "undefined" ? window : globalThis);
