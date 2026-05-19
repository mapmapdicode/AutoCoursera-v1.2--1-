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

    function normalizeQuizResultSettleSeconds(value, fallback = 4) {
        const parsed = Number(value);
        if (!Number.isFinite(parsed)) {
            return fallback;
        }

        return Math.min(120, Math.max(1, Math.round(parsed)));
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

    function pickFirstIncomplete(items, completionMap) {
        return items.find((item) => completionMap.get(item.path) !== true) || null;
    }

    function isEligibleQuizItem(item) {
        if (!item || item.type !== "quiz") {
            return false;
        }

        const value = `${item.path || ""} ${item.title || ""}`.toLowerCase();

        if (/(programming|peer|discussion|lecture|reading|supplement|review)/.test(value)) {
            return false;
        }

        return /(quiz|practice|graded|assignment-submission|attempt)/.test(value);
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

                if (skippedPaths.has(item.path)) {
                    return false;
                }

                return completionMap.get(item.path) !== true;
            }) || null
        );
    }

    function inferSidebarCompletionSignals({ ariaLabel = "", text = "", hasSuccessIcon = false } = {}) {
        if (hasSuccessIcon) {
            return true;
        }

        const value = `${ariaLabel} ${text}`.trim().toLowerCase();
        if (!value) {
            return null;
        }

        if (/(not submitted|not started|incomplete|pending)/.test(value)) {
            return false;
        }

        if (/(completed|grade:|passed|success)/.test(value)) {
            return true;
        }

        return null;
    }

    function isSubmitActionLabel(label) {
        const value = String(label || "").trim().toLowerCase();
        if (!value) {
            return false;
        }

        return /^(submit|check|finish|turn in|send answer)/.test(value);
    }

    function isContinueActionLabel(label) {
        const value = String(label || "").trim().toLowerCase();
        if (!value) {
            return false;
        }

        return /^(continue|next|go to next|next item|continue to next)/.test(value);
    }

    function isStartActionLabel(label) {
        const value = String(label || "").trim().toLowerCase();
        if (!value) {
            return false;
        }

        return /^(start|begin|open quiz|start quiz)/.test(value);
    }

    function classifyQuizStateText(text) {
        const value = String(text || "").trim().toLowerCase();
        if (!value) {
            return "pending";
        }

        if (
            /(haven't submitted|have not submitted|not submitted yet|not submitted|your grade\s*--|grade\s*--|resume\b|start quiz|begin quiz)/.test(value)
        ) {
            return "pending";
        }

        if (
            /(congratulations|you passed|passed this|completed this|grade received|you passed this assignment|you passed this quiz)/.test(value)
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
            /(haven't submitted|have not submitted|not submitted yet|not submitted|your grade\s*--|grade\s*--|resume\b|we keep your highest score)/.test(textValue)
        ) {
            return false;
        }

        return (
            /(congratulations|you passed this assignment|you passed this quiz|you passed this)/.test(textValue) ||
            /\byour grade\b[\s\S]{0,80}\b\d{1,3}%/.test(textValue)
        );
    }

    function resolveStartActionState({
        hasStartButton,
        hasQuizWorkControls = false,
        startClickedAt,
        now,
        transitionTimeoutMs,
    }) {
        if (hasQuizWorkControls) {
            return "gone";
        }

        if (!hasStartButton) {
            return "gone";
        }

        if (!startClickedAt) {
            return "click";
        }

        if (now - startClickedAt >= transitionTimeoutMs) {
            return "timeout";
        }

        return "wait";
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
            quiz_click_start: "Nhấn Start quiz",
            quiz_accept_honor_code: 'Check "I understand and agree"',
            quiz_click_submit: "Submit quiz",
            quiz_confirm_submit: "Confirm submit",
            wait_quiz_result: `Chờ ${details.seconds || 0}s để nhận kết quả`,
            quiz_result_passed: "Quiz đã pass",
            quiz_result_failed: "Quiz không pass",
            quiz_click_next_item: 'Chọn "Next item" trở về',
            quiz_click_continue: 'Chọn "Continue"',
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

    const api = {
        buildCourseMaterialsUrl,
        buildRunnerLogEntry,
        buildRunnerLogMessage,
        classifyQuizStateText,
        describeRunnerLogEntry,
        flattenCourseStructure,
        formatRunnerLogExport,
        guessItemType,
        inferSidebarCompletionSignals,
        isContinueActionLabel,
        isEligibleQuizItem,
        isEligibleQuizRunItem,
        isStartActionLabel,
        isSubmitActionLabel,
        isUngradedAppItem,
        normalizeQuizResultSettleSeconds,
        normalizePath,
        pickFirstIncomplete,
        pickFirstIncompleteQuiz,
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
