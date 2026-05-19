(function () {
    const helpers = window.CourseRunnerHelpers;

    if (!helpers) {
        console.error("Course runner helpers are missing.");
        return;
    }

    const {
        buildCourseMaterialsUrl,
        buildRunnerLogEntry,
        buildRunnerLogMessage,
        classifyQuizStateText,
        flattenCourseStructure,
        guessItemType,
        inferSidebarCompletionSignals,
        isContinueActionLabel,
        isUngradedAppItem,
        isStartActionLabel,
        isSubmitActionLabel,
        normalizeQuizResultSettleSeconds,
        normalizePath,
        pickFirstIncompleteQuiz,
        resolveAttemptRelayState,
        resolveStartActionState,
        resolveSolverFillState,
        shouldTreatQuizStateAsFinal,
    } = helpers;

    const RUN_MODE_FULL = "full";
    const RUN_MODE_QUIZ = "quiz";
    const LESSON_TIMEOUT_MS = 15000;
    const QUIZ_TIMEOUT_MS = 120000;
    const RESUME_DELAY_MS = 1500;
    const POLL_INTERVAL_MS = 1500;
    const DEFAULT_QUIZ_RESULT_SETTLE_SECONDS = 4;
    const QUIZ_RESULT_SETTLE_MS = DEFAULT_QUIZ_RESULT_SETTLE_SECONDS * 1000;
    const ATTEMPT_RELAY_DELAY_MS = 3000;
    const APP_ITEM_STEP_DELAY_MS = 4000;
    const START_TRANSITION_TIMEOUT_MS = 6000;
    const SOLVER_FILL_MIN_WAIT_MS = 8000;
    const SOLVER_FILL_STABLE_MS = 5000;
    const SOLVER_FILL_TIMEOUT_MS = 60000;
    const LOG_LIMIT = 500;
    const LIFECYCLE_MARKER_KEY = "autocoursera:lastLifecycle";

    let courseMaterialsCache = null;
    let hasFetchedCourseMaterials = false;
    let tabIdPromise = null;
    const processingModes = new Set();
    const resumeTimers = new Map();
    let logWriteQueue = Promise.resolve();

    window.addEventListener("message", handleInterceptedMessage);
    window.addEventListener("error", handleWindowError);
    window.addEventListener("unhandledrejection", handleUnhandledRejection);
    chrome.runtime.onMessage.addListener(handleRuntimeMessage);
    registerLifecycleDiagnostics();
    scheduleResume(RUN_MODE_FULL, "bootstrap");
    scheduleResume(RUN_MODE_QUIZ, "bootstrap");

    function handleInterceptedMessage(event) {
        if (event.source !== window || !event.data || !event.data.url) {
            return;
        }

        if (String(event.data.url).includes("/ondemandcoursematerials.v2/?q=slug")) {
            courseMaterialsCache = event.data.response;
            logRunner("course_materials_captured", {
                url: event.data.url,
            });
        }
    }

    function handleWindowError(event) {
        logRunnerError("runner_error", event.error || event.message || "Unknown window error", {
            source: event.filename,
            line: event.lineno,
            column: event.colno,
        });
    }

    function handleUnhandledRejection(event) {
        logRunnerError("runner_error", event.reason || "Unhandled promise rejection");
    }

    function handleRuntimeMessage(message, sender, sendResponse) {
        if (!message) {
            return;
        }

        if (message.type === "makeDoneAll") {
            startFullRun(message)
                .then((result) => sendResponse(result))
                .catch((error) => sendResponse({ ok: false, error: error.message }));
            return true;
        }

        if (message.type === "makeQuizAll") {
            startQuizRun(message)
                .then((result) => sendResponse(result))
                .catch((error) => sendResponse({ ok: false, error: error.message }));
            return true;
        }

        if (message.type === "resumeMakeDoneAll") {
            scheduleResume(RUN_MODE_FULL, "background");
            sendResponse({ ok: true });
            return;
        }

        if (message.type === "resumeMakeQuizAll") {
            scheduleResume(RUN_MODE_QUIZ, "background");
            sendResponse({ ok: true });
            return;
        }

        if (message.type === "getMakeDoneAllStatus") {
            getRunState(RUN_MODE_FULL)
                .then((state) => sendResponse(state || { active: false }))
                .catch((error) => sendResponse({ active: false, error: error.message }));
            return true;
        }

        if (message.type === "getMakeQuizAllStatus") {
            getRunState(RUN_MODE_QUIZ)
                .then((state) => sendResponse(state || { active: false }))
                .catch((error) => sendResponse({ active: false, error: error.message }));
            return true;
        }
    }

    async function startFullRun(options) {
        const slug = deriveCourseSlug();
        if (!slug) {
            throw new Error("Open a Coursera course page first.");
        }

        await clearPersistentLogs();

        const state = {
            active: true,
            courseSlug: slug,
            currentItemId: null,
            currentItemPath: null,
            processing: false,
            forcedQuiz: false,
            previousQuizSetting: null,
            completedPaths: [],
            skippedPaths: [],
            skipLog: [],
            status: "running",
            lastStatus: "Running",
            includeQuizzesWhenPossible: options.includeQuizzesWhenPossible !== false,
            skipUnsupported: options.skipUnsupported !== false,
            updatedAt: Date.now(),
        };

        await saveRunState(RUN_MODE_FULL, state);
        logRunner("run_started", {
            slug,
            includeQuizzesWhenPossible: state.includeQuizzesWhenPossible,
            skipUnsupported: state.skipUnsupported,
        });
        scheduleResume(RUN_MODE_FULL, "start");
        return { ok: true };
    }

    async function startQuizRun() {
        const slug = deriveCourseSlug();
        if (!slug) {
            throw new Error("Open a Coursera course page first.");
        }

        await clearPersistentLogs();

        const state = {
            active: true,
            courseSlug: slug,
            currentQuizId: null,
            currentQuizPath: null,
            processing: false,
            forcedQuiz: false,
            previousQuizSetting: null,
            completedPaths: [],
            skippedPaths: [],
            skipLog: [],
            status: "running",
            lastStatus: "Running quizzes",
            updatedAt: Date.now(),
        };

        await saveRunState(RUN_MODE_QUIZ, state);
        logRunner("quiz_run_started", {
            slug,
        });
        scheduleResume(RUN_MODE_QUIZ, "start");
        return { ok: true };
    }

    function scheduleResume(mode, reason) {
        clearTimeout(resumeTimers.get(mode));

        const eventName =
            mode === RUN_MODE_QUIZ ? "quiz_resume_scheduled" : "resume_scheduled";
        logRunner(eventName, { reason });

        const timer = setTimeout(() => {
            processRun(mode, reason).catch((error) => {
                console.error(`Failed to process ${mode} run:`, error);
            });
        }, RESUME_DELAY_MS);

        resumeTimers.set(mode, timer);
    }

    async function processRun(mode, reason) {
        if (processingModes.has(mode)) {
            return;
        }

        processingModes.add(mode);

        try {
            const state = await getRunState(mode);
            if (!state || !state.active) {
                return;
            }

            await updateRunState(mode, { processing: true });

            const currentPath = normalizePath(window.location.pathname);
            logRunner(mode === RUN_MODE_QUIZ ? "quiz_process_run" : "process_run", {
                reason,
                slug: state.courseSlug,
                currentPath,
            }, { mode });

            if (deriveCourseSlug() !== state.courseSlug) {
                await updateRunState(mode, {
                    status: "waitingForPage",
                    lastStatus: "Waiting for course page...",
                });
                return;
            }

            const courseItems = await getOrderedCourseItems(state.courseSlug);
            if (!courseItems.length) {
                await updateRunState(mode, {
                    status: "waitingForPage",
                    lastStatus: "Waiting for course outline...",
                });
                scheduleResume(mode, "waiting-for-outline");
                return;
            }

            const completionMap = buildEffectiveCompletionMap(courseItems, state);
            const skippedPaths = new Set(state.skippedPaths || []);
            if (mode === RUN_MODE_QUIZ) {
                logQuizScan(courseItems, completionMap, skippedPaths);
            }
            const nextItem = pickNextItemForMode(mode, courseItems, completionMap, skippedPaths);
            const nextItemIsApp =
                mode === RUN_MODE_QUIZ && isUngradedAppItem(nextItem);

            if (!nextItem) {
                await finishRun(
                    mode,
                    mode === RUN_MODE_QUIZ ? "Quiz run done" : "Done"
                );
                return;
            }

            logRunner(
                nextItemIsApp
                    ? "next_pending_app_item"
                    : mode === RUN_MODE_QUIZ ? "next_pending_quiz" : "next_pending_item",
                summarizeItem(nextItem),
                { mode }
            );

            if (!matchesItemPath(currentPath, nextItem.path)) {
                await updateRunState(mode, {
                    ...currentItemPatch(mode, nextItem),
                    status: "waitingForPage",
                    lastStatus:
                        nextItemIsApp
                            ? `Opening app item ${nextItem.title}`
                            : mode === RUN_MODE_QUIZ
                            ? `Opening quiz ${nextItem.title}`
                            : `Opening ${nextItem.title}`,
                });
                logRunner("navigate_to_item", summarizeItem(nextItem), { mode });
                logRunner("wait_page_load", { seconds: getResumeDelaySeconds() }, { mode });
                navigateTo(nextItem.path, mode);
                return;
            }

            await updateRunState(mode, {
                ...currentItemPatch(mode, nextItem),
                status: "running",
                lastStatus:
                    nextItemIsApp
                        ? `Running app item ${nextItem.title}`
                        : mode === RUN_MODE_QUIZ
                        ? `Running quiz ${nextItem.title}`
                        : `Running ${nextItem.title}`,
            });

            if (nextItemIsApp) {
                await handleUngradedAppItem(mode, nextItem);
            } else if (mode === RUN_MODE_QUIZ || isQuizItem(nextItem, currentPath)) {
                await handleQuizItem(mode, nextItem);
            } else {
                await handleLessonItem(nextItem);
            }
        } catch (error) {
            console.error(
                mode === RUN_MODE_QUIZ
                    ? "Quiz-run orchestration error:"
                    : "Full-run orchestration error:",
                error
            );
            logRunnerError(
                mode === RUN_MODE_QUIZ ? "quiz_error" : "runner_error",
                error,
                { mode }
            );
            await abortRun(mode, error.message || "Unexpected error");
        } finally {
            const currentState = await getRunState(mode);
            if (currentState && currentState.active) {
                await updateRunState(mode, { processing: false });
            }
            processingModes.delete(mode);
        }
    }

    async function handleLessonItem(item) {
        logRunner("lesson_start", summarizeItem(item));
        const relayResult = await relayTabMessage("bypass");
        if (!relayResult.ok) {
            throw new Error(relayResult.error || "Unable to trigger partial completion.");
        }

        const outcome = await waitForPendingShift(item, LESSON_TIMEOUT_MS);
        logRunner("lesson_outcome", {
            ...summarizeItem(item),
            outcome: outcome.kind,
        });
        await handleOutcome(RUN_MODE_FULL, outcome, item, "Lesson timeout");
    }

    async function handleQuizItem(mode, item) {
        const state = await getRunState(mode);
        if (!state || !state.active) {
            return;
        }

        logRunner("quiz_start", summarizeItem(item));

        if (mode === RUN_MODE_FULL && !state.includeQuizzesWhenPossible) {
            logRunner("quiz_skipped_by_config", summarizeItem(item));
            await skipItem(mode, item, "Skipped quiz by configuration.");
            return;
        }

        const settings = await storageGet(["key"]);
        if (!settings.key) {
            logRunner(
                mode === RUN_MODE_QUIZ ? "quiz_run_skipped" : "quiz_skipped_missing_key",
                {
                    ...summarizeItem(item),
                    reason: "Skipped quiz: missing API key.",
                }
            );
            await skipItem(mode, item, "Skipped quiz: missing API key.");
            return;
        }

        await ensureQuizModeEnabled(mode, state);

        const currentPath = normalizePath(window.location.pathname);
        if (!/\/attempt$/.test(currentPath)) {
            const attemptPath = findAttemptPath(item.path);
            if (attemptPath && attemptPath !== currentPath) {
                await updateRunState(mode, {
                    status: "waitingForPage",
                    lastStatus: `Opening quiz ${item.title}`,
                });
                logRunner(
                    mode === RUN_MODE_QUIZ ? "quiz_run_open_attempt" : "quiz_open_attempt",
                    {
                        ...summarizeItem(item),
                        attemptPath,
                    },
                    { mode }
                );
                logRunner("wait_page_load", { seconds: getResumeDelaySeconds() }, { mode });
                navigateTo(attemptPath, mode);
                return;
            }
        }

        await updateRunState(mode, {
            status: "waitingForQuiz",
            lastStatus: `Preparing quiz ${item.title}`,
        });

        const submissionOutcome = await waitForQuizSubmission(mode, item, QUIZ_TIMEOUT_MS);
        logRunner("quiz_submission_outcome", {
            ...summarizeItem(item),
            outcome: submissionOutcome.kind,
            reason: submissionOutcome.reason,
        }, { mode });
        await handleQuizOutcome(mode, submissionOutcome, item);
    }

    async function handleUngradedAppItem(mode, item) {
        const state = await getRunState(mode);
        if (!state || !state.active) {
            return;
        }

        logRunner("app_item_start", summarizeItem(item), { mode });
        await updateRunState(mode, {
            status: "running",
            lastStatus: `Running app item ${item.title}`,
        });

        const agreementCheckbox = findAppAgreementCheckbox();
        if (!agreementCheckbox) {
            await skipAppItem(
                mode,
                item,
                "Ungraded app item agreement checkbox was not found."
            );
            return;
        }

        const agreementAlreadyChecked = Boolean(agreementCheckbox.checked);
        if (!agreementAlreadyChecked) {
            clickCheckbox(agreementCheckbox);
        }
        logRunner("app_item_accept_agreement", {
            ...summarizeItem(item),
            alreadyChecked: agreementAlreadyChecked,
        }, { mode });
        logRunner("app_item_wait_before_launch", {
            ...summarizeItem(item),
            seconds: getAppItemStepDelaySeconds(),
        }, { mode });
        await delay(APP_ITEM_STEP_DELAY_MS);

        const launchButton = findLaunchAppButton();
        if (!launchButton || isButtonDisabled(launchButton)) {
            await skipAppItem(
                mode,
                item,
                "Ungraded app item launch button was not available."
            );
            return;
        }

        safeClick(launchButton);
        logRunner("app_item_launch_clicked", summarizeItem(item), { mode });
        logRunner("app_item_wait_after_launch", {
            ...summarizeItem(item),
            seconds: getAppItemStepDelaySeconds(),
        }, { mode });
        await updateRunState(mode, {
            lastStatus: `Launched app item ${item.title}`,
        });
        await delay(APP_ITEM_STEP_DELAY_MS);

        const outcome = await waitForCompletionShift(mode, item);
        if (outcome) {
            await handleOutcome(mode, outcome, item, "Ungraded app item timeout");
            return;
        }

        await skipAppItem(
            mode,
            item,
            "Ungraded app item launched but was not marked complete."
        );
    }

    async function skipAppItem(mode, item, reason) {
        logRunner("app_item_skipped", {
            ...summarizeItem(item),
            reason,
        }, { mode });
        await skipItem(mode, item, reason);
    }

    async function handleOutcome(mode, outcome, item, timeoutReason) {
        if (outcome.kind === "done") {
            await finishRun(
                mode,
                mode === RUN_MODE_QUIZ ? "Quiz run done" : "Done"
            );
            return;
        }

        if (outcome.kind === "moved") {
            if (outcome.nextItem && !matchesItemPath(normalizePath(location.pathname), outcome.nextItem.path)) {
                navigateTo(outcome.nextItem.path, mode);
            }
            return;
        }

        await skipItem(mode, item, timeoutReason);
    }

    async function waitForPendingShift(currentItem, timeoutMs) {
        const startedAt = Date.now();

        while (Date.now() - startedAt < timeoutMs) {
            const state = await getRunState(RUN_MODE_FULL);
            if (!state || !state.active) {
                return { kind: "done" };
            }

            const items = await getOrderedCourseItems(state.courseSlug);
            if (!items.length) {
                await delay(POLL_INTERVAL_MS);
                continue;
            }

            const nextItem = pickNextItemForMode(
                RUN_MODE_FULL,
                items,
                buildEffectiveCompletionMap(items, state),
                new Set(state.skippedPaths || [])
            );

            if (!nextItem) {
                return { kind: "done" };
            }

            const currentPath = normalizePath(location.pathname);
            if (!matchesItemPath(currentPath, currentItem.path) || nextItem.path !== currentItem.path) {
                return { kind: "moved", nextItem };
            }

            await delay(POLL_INTERVAL_MS);
        }

        return { kind: "timeout" };
    }

    async function skipItem(mode, item, reason) {
        const state = await getRunState(mode);
        if (!state || !state.active) {
            return;
        }

        const skippedPaths = Array.from(new Set([...(state.skippedPaths || []), item.path]));
        const skipLog = [
            ...(state.skipLog || []),
            {
                path: item.path,
                title: item.title,
                reason,
                timestamp: Date.now(),
            },
        ];

        await updateRunState(mode, {
            skippedPaths,
            skipLog,
            status: "skipping",
            lastStatus: reason,
        });

        if (mode === RUN_MODE_QUIZ && !isUngradedAppItem(item)) {
            logRunner("quiz_run_skipped", {
                ...summarizeItem(item),
                reason,
            });
        }

        const items = await getOrderedCourseItems(state.courseSlug);
        const nextItem = pickNextItemForMode(
            mode,
            items,
            buildEffectiveCompletionMap(items, state),
            new Set(skippedPaths)
        );

        if (!nextItem) {
            await finishRun(
                mode,
                mode === RUN_MODE_QUIZ ? "Quiz run done" : "Done"
            );
            return;
        }

        navigateTo(nextItem.path, mode);
    }

    async function waitForQuizSubmission(mode, currentItem, timeoutMs) {
        const startedAt = Date.now();
        const quizResultSettleMs = await getQuizResultSettleMs();
        let attemptRelayed = false;
        let attemptRelayedAt = 0;
        let answerBaseline = null;
        let solverFillReady = false;
        let solverFillWaitLogged = false;
        let solverFillLastSignature = "";
        let solverFillLastChangedAt = 0;
        let submissionClicked = false;
        let confirmClicked = false;
        let submitConfirmedAt = 0;
        let startClickedAt = 0;
        let quizControlsReadyAt = 0;
        let attemptRelayDelayLogged = false;
        let waitingForQuizControlsLogged = false;

        while (Date.now() - startedAt < timeoutMs) {
            const state = await getRunState(mode);
            if (!state || !state.active) {
                return { kind: "done" };
            }

            const completionOutcome = await waitForCompletionShift(mode, currentItem);
            if (completionOutcome) {
                return completionOutcome;
            }

            const pageText = cleanText(document.body && document.body.textContent);
            const quizState = classifyQuizStateText(pageText);
            const nextButton = findNextItemButton();
            const startButton = findStartQuizButton();
            const agreementCheckbox = findHonorCodeCheckbox();
            const submitButton = findActionButton(isSubmitActionLabel);
            const hasQuizWorkControls = Boolean(agreementCheckbox || submitButton);

            if (shouldTreatQuizStateAsFinal(quizState, submissionClicked) && quizState === "passed") {
                await markItemCompleted(mode, currentItem);
                logRunner("quiz_result_passed", summarizeItem(currentItem));
                if (nextButton && hasQuizResultSettled(submitConfirmedAt, quizResultSettleMs)) {
                    logRunner("quiz_click_next_item", summarizeItem(currentItem));
                    activateNextItem(nextButton);
                    logRunner("wait_page_load", { seconds: getResumeDelaySeconds() }, { mode });
                    await delay(POLL_INTERVAL_MS);
                }

                const continueClicked =
                    hasQuizResultSettled(submitConfirmedAt, quizResultSettleMs) &&
                    clickFirstMatchingButton(isContinueActionLabel);
                if (continueClicked) {
                    logRunner("quiz_click_continue", summarizeItem(currentItem));
                    await updateRunState(mode, {
                        lastStatus: `Continuing after ${currentItem.title}`,
                    });
                }

                const passedOutcome = await waitForCompletionShift(mode, currentItem);
                if (passedOutcome) {
                    return passedOutcome;
                }

                await delay(POLL_INTERVAL_MS);
                continue;
            }

            if (shouldTreatQuizStateAsFinal(quizState, submissionClicked) && quizState === "failed") {
                logRunner("quiz_result_failed", summarizeItem(currentItem));
                return { kind: "failed", reason: "Quiz submitted but did not pass." };
            }

            const startAction = resolveStartActionState({
                hasStartButton: Boolean(startButton && !isButtonDisabled(startButton)),
                hasQuizWorkControls,
                startClickedAt,
                now: Date.now(),
                transitionTimeoutMs: START_TRANSITION_TIMEOUT_MS,
            });

            if (startAction === "click") {
                logRunner("quiz_dom_snapshot", buildQuizDomSnapshot("before_start_click", currentItem), { mode });
                safeClick(startButton);
                startClickedAt = Date.now();
                waitingForQuizControlsLogged = false;
                logRunner("quiz_click_start", summarizeItem(currentItem), { mode });
                logRunner("wait_page_load", {
                    seconds: Math.ceil(START_TRANSITION_TIMEOUT_MS / 1000),
                }, { mode });
                await updateRunState(mode, {
                    lastStatus: `Started quiz ${currentItem.title}`,
                });
                await delay(POLL_INTERVAL_MS);
                continue;
            }

            if (startAction === "wait") {
                await delay(POLL_INTERVAL_MS);
                continue;
            }

            if (startAction === "timeout") {
                logRunner("quiz_dom_snapshot", buildQuizDomSnapshot("start_transition_timeout", currentItem), { mode });
                logRunnerWarn("quiz_error", {
                    ...summarizeItem(currentItem),
                    message: "Start button did not transition to quiz content.",
                });
                return {
                    kind: "failed",
                    reason: "Start button did not transition to quiz content.",
                };
            }

            if (!attemptRelayed && !hasQuizWorkControls) {
                quizControlsReadyAt = 0;
                attemptRelayDelayLogged = false;
                if (!waitingForQuizControlsLogged) {
                    logRunner("quiz_dom_snapshot", buildQuizDomSnapshot("waiting_for_quiz_controls", currentItem), { mode });
                    waitingForQuizControlsLogged = true;
                }

                await delay(POLL_INTERVAL_MS);
                continue;
            }

            if (!attemptRelayed && !quizControlsReadyAt) {
                quizControlsReadyAt = Date.now();
            }

            if (
                !attemptRelayed &&
                resolveAttemptRelayState({
                    controlsReadyAt: quizControlsReadyAt,
                    now: Date.now(),
                    delayMs: ATTEMPT_RELAY_DELAY_MS,
                }) === "wait"
            ) {
                if (!attemptRelayDelayLogged) {
                    logRunner("quiz_wait_attempt_relay", {
                        ...summarizeItem(currentItem),
                        seconds: Math.ceil(ATTEMPT_RELAY_DELAY_MS / 1000),
                    }, { mode });
                    attemptRelayDelayLogged = true;
                }

                await delay(POLL_INTERVAL_MS);
                continue;
            }

            if (!attemptRelayed) {
                logRunner("quiz_dom_snapshot", buildQuizDomSnapshot("before_attempt_relay", currentItem), { mode });
                answerBaseline = getQuizAnswerProgress();
                solverFillLastSignature = answerBaseline.signature;
                solverFillLastChangedAt = Date.now();
                const relayResult = await relayTabMessage("attempt");
                if (!relayResult.ok) {
                    console.warn("Quiz relay reported an error:", relayResult.error);
                    logRunnerWarn("quiz_error", {
                        ...summarizeItem(currentItem),
                        message: relayResult.error || "Quiz relay reported an error.",
                    });
                }

                attemptRelayed = true;
                attemptRelayedAt = Date.now();
                logRunner("quiz_attempt_relayed", {
                    ...summarizeItem(currentItem),
                    relayOk: relayResult.ok,
                    relayError: relayResult.error,
                }, { mode });
                logRunner("quiz_dom_snapshot", buildQuizDomSnapshot("after_attempt_relay", currentItem), { mode });
                await updateRunState(mode, {
                    lastStatus: `Solving quiz ${currentItem.title}`,
                });
                await delay(POLL_INTERVAL_MS);
                continue;
            }

            if (!solverFillReady) {
                const answerProgress = getQuizAnswerProgress();
                const now = Date.now();

                if (answerProgress.signature !== solverFillLastSignature) {
                    solverFillLastSignature = answerProgress.signature;
                    solverFillLastChangedAt = now;
                    logRunner("quiz_solver_fill_progress", {
                        ...summarizeItem(currentItem),
                        answeredCount: answerProgress.answeredCount,
                    }, { mode });
                }

                const fillState = resolveSolverFillState({
                    baselineAnsweredCount: answerBaseline ? answerBaseline.answeredCount : 0,
                    baselineSignature: answerBaseline ? answerBaseline.signature : "",
                    currentAnsweredCount: answerProgress.answeredCount,
                    currentSignature: answerProgress.signature,
                    relayedAt: attemptRelayedAt,
                    lastChangedAt: solverFillLastChangedAt,
                    now,
                    minWaitMs: SOLVER_FILL_MIN_WAIT_MS,
                    stableMs: SOLVER_FILL_STABLE_MS,
                    timeoutMs: SOLVER_FILL_TIMEOUT_MS,
                });

                if (fillState === "timeout") {
                    logRunner("quiz_dom_snapshot", buildQuizDomSnapshot("solver_fill_timeout", currentItem), { mode });
                    logRunnerWarn("quiz_error", {
                        ...summarizeItem(currentItem),
                        message: "AI did not fill any detectable answer before timeout.",
                    });
                    return {
                        kind: "failed",
                        reason: "AI did not fill any detectable answer before timeout.",
                    };
                }

                if (fillState === "wait") {
                    if (!solverFillWaitLogged) {
                        logRunner("quiz_wait_solver_fill", {
                            ...summarizeItem(currentItem),
                            answeredCount: answerProgress.answeredCount,
                            seconds: Math.ceil(SOLVER_FILL_TIMEOUT_MS / 1000),
                        }, { mode });
                        solverFillWaitLogged = true;
                    }

                    await delay(POLL_INTERVAL_MS);
                    continue;
                }

                solverFillReady = true;
                logRunner("quiz_solver_fill_ready", {
                    ...summarizeItem(currentItem),
                    answeredCount: answerProgress.answeredCount,
                }, { mode });
                await delay(500);
                continue;
            }

            if (agreementCheckbox && !agreementCheckbox.checked) {
                clickCheckbox(agreementCheckbox);
                logRunner("quiz_accept_honor_code", summarizeItem(currentItem));
                await updateRunState(mode, {
                    lastStatus: `Accepted honor code for ${currentItem.title}`,
                });
                await delay(500);
                continue;
            }

            if (submissionClicked && !confirmClicked) {
                const confirmSubmitButton = findConfirmSubmitButton();
                if (confirmSubmitButton && !isButtonDisabled(confirmSubmitButton)) {
                    logRunner("quiz_dom_snapshot", buildQuizDomSnapshot("before_confirm_submit", currentItem), { mode });
                    safeClick(confirmSubmitButton);
                    confirmClicked = true;
                    submitConfirmedAt = Date.now();
                    logRunner("quiz_confirm_submit", summarizeItem(currentItem));
                    logRunner("wait_quiz_result", {
                        seconds: getQuizResultDelaySeconds(quizResultSettleMs),
                    }, { mode });
                    await updateRunState(mode, {
                        lastStatus: `Confirmed submit for ${currentItem.title}`,
                    });
                    await delay(POLL_INTERVAL_MS);
                    continue;
                }

                await delay(POLL_INTERVAL_MS);
                continue;
            }

            if (!submissionClicked && submitButton && !isButtonDisabled(submitButton)) {
                logRunner("quiz_dom_snapshot", buildQuizDomSnapshot("before_submit_click", currentItem), { mode });
                safeClick(submitButton);
                submissionClicked = true;
                logRunner("quiz_click_submit", summarizeItem(currentItem));
                await updateRunState(mode, {
                    lastStatus: `Submitted quiz ${currentItem.title}`,
                });
                await delay(POLL_INTERVAL_MS);
                continue;
            }

            await delay(POLL_INTERVAL_MS);
        }

        return { kind: "timeout" };
    }

    async function waitForCompletionShift(mode, currentItem) {
        const state = await getRunState(mode);
        if (!state || !state.active) {
            return { kind: "done" };
        }

        const items = await getOrderedCourseItems(state.courseSlug);
        if (!items.length) {
            return null;
        }

        const nextItem = pickNextItemForMode(
            mode,
            items,
            buildEffectiveCompletionMap(items, state),
            new Set(state.skippedPaths || [])
        );

        if (!nextItem) {
            return { kind: "done" };
        }

        const currentPath = normalizePath(location.pathname);
        if (!matchesItemPath(currentPath, currentItem.path) || nextItem.path !== currentItem.path) {
            return { kind: "moved", nextItem };
        }

        return null;
    }

    async function handleQuizOutcome(mode, outcome, item) {
        if (outcome.kind === "failed") {
            await skipItem(mode, item, outcome.reason);
            return;
        }

        await handleOutcome(mode, outcome, item, "Quiz timeout");
    }

    async function finishRun(mode, message) {
        const state = await getRunState(mode);
        if (state) {
            await restoreQuizMode(mode, state);
        }

        await clearRunState(mode);
        logRunner(mode === RUN_MODE_QUIZ ? "quiz_run_finished" : "run_finished", { message });
        console.log(
            mode === RUN_MODE_QUIZ ? "Quiz run finished:" : "Full run finished:",
            message
        );
    }

    async function abortRun(mode, message) {
        const state = await getRunState(mode);
        if (state) {
            await restoreQuizMode(mode, state);
        }

        await clearRunState(mode);
        logRunner(mode === RUN_MODE_QUIZ ? "quiz_run_aborted" : "run_aborted", { message });
        console.error(
            mode === RUN_MODE_QUIZ ? "Quiz run aborted:" : "Full run aborted:",
            message
        );
    }

    async function ensureQuizModeEnabled(mode, state) {
        if (state.forcedQuiz) {
            return;
        }

        const settings = await storageGet(["quiz"]);
        await storageSet({ quiz: true });
        logRunner("quiz_mode_forced_on", {
            previousQuizSetting: Boolean(settings.quiz),
        });
        await updateRunState(mode, {
            forcedQuiz: true,
            previousQuizSetting: Boolean(settings.quiz),
        });
    }

    async function restoreQuizMode(mode, state) {
        if (!state.forcedQuiz) {
            return;
        }

        await storageSet({ quiz: Boolean(state.previousQuizSetting) });
        logRunner("quiz_mode_restored", {
            restoredQuizSetting: Boolean(state.previousQuizSetting),
        });
        await updateRunState(mode, {
            forcedQuiz: false,
        });
    }

    async function markItemCompleted(mode, item) {
        const state = await getRunState(mode);
        if (!state || !state.active || !item || !item.path) {
            return;
        }

        const completedPaths = Array.from(
            new Set([...(state.completedPaths || []), item.path])
        );

        await updateRunState(mode, {
            completedPaths,
        });
    }

    async function getOrderedCourseItems(slug) {
        const domItems = extractCourseItemsFromDom(slug);
        if (domItems.length) {
            return domItems;
        }

        const payload = await getCourseMaterials(slug);
        return flattenCourseStructure(payload);
    }

    function extractCourseItemsFromDom(slug) {
        const anchors = Array.from(document.querySelectorAll(`a[href*="/learn/${slug}/"]`));
        const items = [];
        const seen = new Set();

        anchors.forEach((anchor) => {
            const path = normalizePath(anchor.href);
            if (!path || seen.has(path)) {
                return;
            }

            if (!path.startsWith(`/learn/${slug}/`)) {
                return;
            }

            if (!/(lecture|supplement|video|reading|quiz|exam|assignment|peer|practice|programming|discussion|review|ungradedlti|lti)/i.test(path)) {
                return;
            }

            const container = anchor.closest("li, [role='treeitem'], [class], [data-testid]");
            const title = cleanText(anchor.textContent) || cleanText(container && container.textContent) || path;
            const completed = inferCompletion(container);

            seen.add(path);
            items.push({
                id: path,
                title,
                path,
                type: guessItemType(path, title),
                completed,
                moduleId: "",
                moduleTitle: "",
            });
        });

        return items;
    }

    function inferCompletion(node) {
        if (!node) {
            return null;
        }

        const anchor = node.matches && node.matches("a[href]") ? node : node.querySelector("a[href]");
        const ariaLabel = cleanText(
            (anchor && anchor.getAttribute && anchor.getAttribute("aria-label")) || ""
        );
        const text = cleanText(node.textContent);
        const hasSuccessIcon = Boolean(
            node.querySelector('[data-testid="learn-item-success-icon"]')
        );

        const signalCompletion = inferSidebarCompletionSignals({
            ariaLabel,
            text,
            hasSuccessIcon,
        });
        if (typeof signalCompletion === "boolean") {
            return signalCompletion;
        }

        if (
            node.querySelector(
                "[aria-label*='completed' i], [title*='completed' i], [data-testid*='completed' i], [class*='completed'], [class*='Complete']"
            )
        ) {
            return true;
        }

        if (
            node.querySelector(
                "[aria-label*='incomplete' i], [title*='incomplete' i], [data-testid*='incomplete' i]"
            )
        ) {
            return false;
        }

        const normalizedText = text.toLowerCase();
        if (/(completed|done|passed)/.test(normalizedText)) {
            return true;
        }

        return null;
    }

    async function getCourseMaterials(slug) {
        if (courseMaterialsCache) {
            logRunner("course_materials_cache_hit", { slug });
            return courseMaterialsCache;
        }

        if (hasFetchedCourseMaterials) {
            return null;
        }

        hasFetchedCourseMaterials = true;
        logRunner("course_materials_fetch", { slug });
        const response = await fetch(buildCourseMaterialsUrl(slug), {
            credentials: "include",
        });

        if (!response.ok) {
            throw new Error("Failed to fetch course structure.");
        }

        courseMaterialsCache = await response.json();
        return courseMaterialsCache;
    }

    function buildCompletionMap(items) {
        const completionMap = new Map();
        items.forEach((item) => {
            if (typeof item.completed === "boolean") {
                completionMap.set(item.path, item.completed);
            }
        });
        return completionMap;
    }

    function buildEffectiveCompletionMap(items, state) {
        const completionMap = buildCompletionMap(items);
        const completedPaths = Array.isArray(state && state.completedPaths)
            ? state.completedPaths
            : [];

        completedPaths.forEach((path) => {
            completionMap.set(path, true);
        });

        return completionMap;
    }

    function pickNextPendingItem(items, completionMap, skippedPaths) {
        return (
            items.find((item) => !skippedPaths.has(item.path) && completionMap.get(item.path) !== true) ||
            null
        );
    }

    function pickNextItemForMode(mode, items, completionMap, skippedPaths) {
        if (mode === RUN_MODE_QUIZ) {
            return pickFirstIncompleteQuiz(items, completionMap, skippedPaths);
        }

        return pickNextPendingItem(items, completionMap, skippedPaths);
    }

    function currentItemPatch(mode, item) {
        if (mode === RUN_MODE_QUIZ) {
            return {
                currentQuizId: item.id,
                currentQuizPath: item.path,
            };
        }

        return {
            currentItemId: item.id,
            currentItemPath: item.path,
        };
    }

    function isQuizItem(item, currentPath) {
        return item.type === "quiz" || /\/attempt$/.test(currentPath);
    }

    function findAttemptPath(itemPath) {
        const currentPath = normalizePath(location.pathname);
        if (/\/attempt$/.test(currentPath)) {
            return currentPath;
        }

        const explicitAttemptLink = document.querySelector("a[href*='/attempt']");
        if (explicitAttemptLink && matchesItemPath(explicitAttemptLink.href, itemPath)) {
            return normalizePath(explicitAttemptLink.href);
        }

        return `${normalizePath(itemPath)}/attempt`;
    }

    function matchesItemPath(currentPath, itemPath) {
        const normalizedCurrent = normalizePath(currentPath);
        const normalizedItem = normalizePath(itemPath);
        return normalizedCurrent === normalizedItem || normalizedCurrent === `${normalizedItem}/attempt`;
    }

    function navigateTo(path, mode = RUN_MODE_FULL) {
        const target = normalizePath(path);
        if (target && target !== normalizePath(location.pathname)) {
            logRunner("navigate", {
                from: normalizePath(location.pathname),
                to: target,
            }, { mode });
            window.location.assign(target);
        }
    }

    function deriveCourseSlug() {
        const match = normalizePath(location.pathname).match(/^\/learn\/([^/]+)/);
        return match ? match[1] : "";
    }

    function cleanText(value) {
        return (value || "").replace(/\s+/g, " ").trim();
    }

    function findActionButton(predicate) {
        const buttons = Array.from(
            document.querySelectorAll("button, [role='button'], input[type='button'], input[type='submit']")
        );

        return buttons.find((button) => {
            const label = getButtonLabel(button);
            return predicate(label);
        }) || null;
    }

    function findStartQuizButton() {
        return (
            document.querySelector('[data-testid="CoverPageActionButton"]') ||
            findActionButton(isStartActionLabel)
        );
    }

    function findHonorCodeCheckbox() {
        return (
            document.querySelector('[data-testid="agreement-standalone-checkbox"] input[type="checkbox"]') ||
            document.querySelector('[data-testid="agreement-checkbox"] input[type="checkbox"]') ||
            document.querySelector("#agreement-checkbox-base")
        );
    }

    function findAppAgreementCheckbox() {
        const honorCheckbox = findHonorCodeCheckbox();
        if (honorCheckbox) {
            return honorCheckbox;
        }

        return Array.from(document.querySelectorAll('input[type="checkbox"]'))
            .find((input) => {
                const label = input.closest && input.closest("label");
                const container = input.closest && input.closest(".rc-HonorCodeAgreement, [data-testid*='agreement' i]");
                const value = cleanText(
                    `${label ? label.textContent : ""} ${container ? container.textContent : ""}`
                ).toLowerCase();

                return /use this app responsibly|agree/.test(value);
            }) || null;
    }

    function findLaunchAppButton() {
        return (
            document.querySelector('form[data-testid="lti-launch-form"] button[type="submit"]') ||
            findActionButton(isLaunchAppActionLabel)
        );
    }

    function isLaunchAppActionLabel(label) {
        const value = String(label || "").trim().toLowerCase();
        return /^launch app\b/.test(value) || /^launch\b/.test(value);
    }

    function findConfirmSubmitButton() {
        return (
            document.querySelector('[data-testid="dialog-submit-button"]') ||
            document.querySelector('[data-testid="SubmitDialog__controls"] button')
        );
    }

    function findNextItemButton() {
        return (
            document.querySelector('[data-testid="TopBannerCTAButton"]') ||
            findActionButton(isContinueActionLabel)
        );
    }

    function clickFirstMatchingButton(predicate) {
        const button = findActionButton(predicate);
        if (!button || isButtonDisabled(button)) {
            return false;
        }

        safeClick(button);
        return true;
    }

    function getButtonLabel(button) {
        return cleanText(
            button.innerText ||
            button.textContent ||
            button.value ||
            button.getAttribute("aria-label") ||
            button.getAttribute("title")
        );
    }

    function isButtonDisabled(button) {
        return Boolean(
            button.disabled ||
            button.getAttribute("aria-disabled") === "true" ||
            button.classList.contains("disabled")
        );
    }

    function safeClick(button) {
        button.scrollIntoView({ block: "center", inline: "center" });
        button.click();
    }

    function clickCheckbox(input) {
        input.scrollIntoView({ block: "center", inline: "center" });
        if (typeof input.click === "function") {
            input.click();
        } else {
            input.checked = true;
            input.dispatchEvent(new Event("change", { bubbles: true }));
        }
    }

    function activateNextItem(button) {
        const href = button.getAttribute && button.getAttribute("href");
        if (href) {
            navigateTo(href, RUN_MODE_QUIZ);
            return;
        }

        safeClick(button);
    }

    function delay(ms) {
        return new Promise((resolve) => {
            setTimeout(resolve, ms);
        });
    }

    function hasQuizResultSettled(submitConfirmedAt, quizResultSettleMs = QUIZ_RESULT_SETTLE_MS) {
        return submitConfirmedAt > 0 && Date.now() - submitConfirmedAt >= quizResultSettleMs;
    }

    function getQuizAnswerProgress() {
        const entries = [];
        const controls = Array.from(
            document.querySelectorAll(
                "input, textarea, select, [role='radio'], [role='checkbox'], [contenteditable='true']"
            )
        );

        controls.forEach((control, index) => {
            if (
                isHonorCodeControl(control) ||
                (isHiddenControl(control) && !isNativeChoiceControl(control))
            ) {
                return;
            }

            const entry = getAnsweredControlSignature(control, index);
            if (entry) {
                entries.push(entry);
            }
        });

        return {
            answeredCount: entries.length,
            signature: entries.join("|"),
        };
    }

    function getAnsweredControlSignature(control, index) {
        const tagName = String(control.tagName || "").toLowerCase();
        const type = String(control.type || "").toLowerCase();
        const identity =
            control.name ||
            control.id ||
            control.getAttribute("aria-labelledby") ||
            control.getAttribute("aria-label") ||
            index;

        if (tagName === "input" && (type === "radio" || type === "checkbox")) {
            return control.checked ? `${identity}:${control.value || "checked"}` : "";
        }

        if (tagName === "input") {
            if (["button", "submit", "reset", "hidden", "search"].includes(type)) {
                return "";
            }

            const value = cleanText(control.value);
            return value ? `${identity}:${value}` : "";
        }

        if (tagName === "textarea") {
            const value = cleanText(control.value);
            return value ? `${identity}:${value}` : "";
        }

        if (tagName === "select") {
            const value = cleanText(control.value);
            return value ? `${identity}:${value}` : "";
        }

        if (
            (control.getAttribute("role") === "radio" ||
                control.getAttribute("role") === "checkbox") &&
            control.getAttribute("aria-checked") === "true"
        ) {
            return `${identity}:${cleanText(control.textContent) || "checked"}`;
        }

        if (control.getAttribute("contenteditable") === "true") {
            const value = cleanText(control.textContent);
            return value ? `${identity}:${value}` : "";
        }

        return "";
    }

    function isNativeChoiceControl(control) {
        const tagName = String(control.tagName || "").toLowerCase();
        const type = String(control.type || "").toLowerCase();
        return tagName === "input" && (type === "radio" || type === "checkbox");
    }

    function isHonorCodeControl(control) {
        const closestAgreement =
            control.closest &&
            control.closest(
                '[data-testid*="agreement" i], [id*="agreement" i], [class*="agreement" i]'
            );
        if (closestAgreement) {
            return true;
        }

        const value = cleanText(
            [
                control.id,
                control.name,
                control.getAttribute && control.getAttribute("aria-label"),
                control.closest && cleanText(control.closest("label")?.textContent),
            ].join(" ")
        ).toLowerCase();

        return /(honor|pledge|agreement|agree|understand)/.test(value);
    }

    function isHiddenControl(control) {
        if (control.type === "hidden") {
            return true;
        }

        if (control.offsetParent !== null) {
            return false;
        }

        const style = window.getComputedStyle(control);
        return style.display === "none" || style.visibility === "hidden";
    }

    function summarizeItem(item) {
        return {
            title: item && item.title,
            path: item && item.path,
            type: item && item.type,
        };
    }

    function buildQuizDomSnapshot(stage, item) {
        const startButton = findStartQuizButton();
        const submitButton = findActionButton(isSubmitActionLabel);
        const confirmButton = findConfirmSubmitButton();
        const nextButton = findNextItemButton();
        const checkbox = findHonorCodeCheckbox();
        const pageText = cleanText(document.body && document.body.textContent);

        return {
            ...summarizeItem(item),
            stage,
            href: location.href,
            readyState: document.readyState,
            visibilityState: document.visibilityState,
            quizState: classifyQuizStateText(pageText),
            hasStartButton: Boolean(startButton),
            startLabel: startButton ? getButtonLabel(startButton) : "",
            startDisabled: startButton ? isButtonDisabled(startButton) : false,
            hasSubmitButton: Boolean(submitButton),
            submitLabel: submitButton ? getButtonLabel(submitButton) : "",
            submitDisabled: submitButton ? isButtonDisabled(submitButton) : false,
            hasConfirmButton: Boolean(confirmButton),
            confirmLabel: confirmButton ? getButtonLabel(confirmButton) : "",
            confirmDisabled: confirmButton ? isButtonDisabled(confirmButton) : false,
            hasNextButton: Boolean(nextButton),
            nextLabel: nextButton ? getButtonLabel(nextButton) : "",
            nextDisabled: nextButton ? isButtonDisabled(nextButton) : false,
            hasAgreementCheckbox: Boolean(checkbox),
            agreementChecked: Boolean(checkbox && checkbox.checked),
        };
    }

    function registerLifecycleDiagnostics() {
        emitBootstrapDiagnostics();

        window.addEventListener("beforeunload", () => {
            persistLifecycleMarker("beforeunload");
        });

        window.addEventListener("pagehide", (event) => {
            persistLifecycleMarker("pagehide", {
                persisted: Boolean(event.persisted),
            });
        });

        document.addEventListener("visibilitychange", () => {
            if (document.visibilityState === "hidden") {
                persistLifecycleMarker("visibility_hidden");
            }
        });
    }

    function emitBootstrapDiagnostics() {
        if (!shouldLogLifecyclePath()) {
            clearLifecycleMarker();
            return;
        }

        logRunner("page_bootstrap", {
            href: location.href,
            navigationType: getNavigationType(),
            readyState: document.readyState,
            visibilityState: document.visibilityState,
        }, { mode: inferContextMode() });

        const previousLifecycle = readLifecycleMarker();
        if (previousLifecycle) {
            logRunner("page_previous_lifecycle", previousLifecycle, {
                mode: inferContextMode(),
            });
            clearLifecycleMarker();
        }
    }

    function persistLifecycleMarker(eventName, details = {}) {
        if (!shouldLogLifecyclePath()) {
            return;
        }

        try {
            sessionStorage.setItem(
                LIFECYCLE_MARKER_KEY,
                JSON.stringify({
                    eventName,
                    href: location.href,
                    pathname: normalizePath(location.pathname),
                    timestamp: new Date().toISOString(),
                    ...details,
                })
            );
        } catch (error) {
            console.warn("Failed to persist lifecycle marker:", error);
        }
    }

    function readLifecycleMarker() {
        try {
            const raw = sessionStorage.getItem(LIFECYCLE_MARKER_KEY);
            if (!raw) {
                return null;
            }

            return JSON.parse(raw);
        } catch (error) {
            console.warn("Failed to read lifecycle marker:", error);
            return null;
        }
    }

    function clearLifecycleMarker() {
        try {
            sessionStorage.removeItem(LIFECYCLE_MARKER_KEY);
        } catch (error) {
            console.warn("Failed to clear lifecycle marker:", error);
        }
    }

    function shouldLogLifecyclePath(pathname = location.pathname) {
        return /\/assignment-submission\/|\/ungradedlti\/|\/attempt$/.test(normalizePath(pathname));
    }

    function getNavigationType() {
        const navigationEntries =
            typeof performance.getEntriesByType === "function"
                ? performance.getEntriesByType("navigation")
                : [];
        return navigationEntries[0] && navigationEntries[0].type
            ? navigationEntries[0].type
            : "unknown";
    }

    function inferContextMode() {
        return shouldLogLifecyclePath() ? RUN_MODE_QUIZ : RUN_MODE_FULL;
    }

    function logQuizScan(items, completionMap, skippedPaths) {
        for (const item of items) {
            const details = summarizeItem(item);

            if (skippedPaths.has(item.path)) {
                logRunner("quiz_scan_item", {
                    ...details,
                    decision: "skip_already_skipped",
                });
                continue;
            }

            if (!helpers.isEligibleQuizRunItem(item)) {
                logRunner("quiz_scan_item", {
                    ...details,
                    decision: "skip_non_quiz",
                });
                continue;
            }

            if (completionMap.get(item.path) === true) {
                logRunner("quiz_scan_item", {
                    ...details,
                    decision: "skip_done",
                });
                continue;
            }

            logRunner("quiz_scan_item", {
                ...details,
                decision: isUngradedAppItem(item) ? "start_app_item" : "start_quiz",
            });
            return;
        }
    }

    function logRunner(eventName, details, context = {}) {
        const entry = buildLogEntry(eventName, details, context);

        console.log(entry.message);
        appendPersistentLog(entry);
    }

    function logRunnerWarn(eventName, details) {
        const entry = buildLogEntry(eventName, details, { level: "warn" });
        console.warn(entry.message);
        appendPersistentLog(entry);
    }

    function logRunnerError(eventName, error, details = {}) {
        const entry = buildLogEntry(
            eventName,
            {
                ...details,
                message: formatErrorMessage(error),
            },
            { level: "error", mode: details.mode }
        );
        console.error(entry.message, error);
        appendPersistentLog(entry);
    }

    function buildLogEntry(eventName, details, context = {}) {
        return buildRunnerLogEntry(eventName, details, {
            level: context.level || "info",
            mode: context.mode || inferLogMode(eventName),
            path: context.path || normalizePath(location.pathname),
        });
    }

    function inferLogMode(eventName) {
        return /^(quiz|app_item|next_pending_app_item)/.test(eventName) ? RUN_MODE_QUIZ : RUN_MODE_FULL;
    }

    function getResumeDelaySeconds() {
        return Math.ceil(RESUME_DELAY_MS / 1000);
    }

    async function getQuizResultSettleMs() {
        const settings = await storageGet(["quizResultSettleSeconds"]);
        const seconds = normalizeQuizResultSettleSeconds(
            settings.quizResultSettleSeconds,
            DEFAULT_QUIZ_RESULT_SETTLE_SECONDS
        );
        return seconds * 1000;
    }

    function getQuizResultDelaySeconds(quizResultSettleMs = QUIZ_RESULT_SETTLE_MS) {
        return Math.ceil(quizResultSettleMs / 1000);
    }

    function getAppItemStepDelaySeconds() {
        return Math.ceil(APP_ITEM_STEP_DELAY_MS / 1000);
    }

    function appendPersistentLog(entry) {
        logWriteQueue = logWriteQueue
            .then(async () => {
                const tabId = await getTabId();
                const storageKey = getRunnerLogStorageKey(tabId);
                const result = await storageGet([storageKey]);
                const entries = Array.isArray(result[storageKey]) ? result[storageKey] : [];
                const nextEntries = [...entries, entry].slice(-LOG_LIMIT);
                await storageSet({
                    [storageKey]: nextEntries,
                });
            })
            .catch((error) => {
                const fallbackMessage = buildRunnerLogMessage("runner_error", {
                    message: `Failed to persist runner log: ${formatErrorMessage(error)}`,
                });
                console.error(fallbackMessage, error);
                console.error("Failed to persist runner log:", error);
            });
    }

    async function clearPersistentLogs() {
        const tabId = await getTabId();
        await storageRemove([getRunnerLogStorageKey(tabId)]);
    }

    async function getRunState(mode) {
        const tabId = await getTabId();
        const storageKey = getRunStorageKey(mode, tabId);
        const result = await storageGet([storageKey]);
        return result[storageKey] || null;
    }

    async function saveRunState(mode, state) {
        const tabId = await getTabId();
        const storageKey = getRunStorageKey(mode, tabId);
        await storageSet({
            [storageKey]: {
                ...state,
                updatedAt: Date.now(),
            },
        });
    }

    async function updateRunState(mode, patch) {
        const state = await getRunState(mode);
        if (!state) {
            return;
        }

        await saveRunState(mode, {
            ...state,
            ...patch,
        });
    }

    async function clearRunState(mode) {
        const tabId = await getTabId();
        await storageRemove([getRunStorageKey(mode, tabId)]);
    }

    function getRunStorageKey(mode, tabId) {
        return mode === RUN_MODE_QUIZ
            ? `quizRunState:${tabId}`
            : `fullRunState:${tabId}`;
    }

    function getRunnerLogStorageKey(tabId) {
        return `runnerLogs:${tabId}`;
    }

    function formatErrorMessage(error) {
        if (!error) {
            return "Unknown error";
        }

        if (typeof error === "string") {
            return error;
        }

        if (error instanceof Error) {
            return error.message || error.name || "Error";
        }

        if (typeof error.message === "string") {
            return error.message;
        }

        try {
            return JSON.stringify(error);
        } catch (stringifyError) {
            return String(error);
        }
    }

    function getTabId() {
        if (!tabIdPromise) {
            tabIdPromise = new Promise((resolve, reject) => {
                chrome.runtime.sendMessage({ type: "getTabId" }, (response) => {
                    if (chrome.runtime.lastError) {
                        reject(new Error(chrome.runtime.lastError.message));
                        return;
                    }

                    if (!response || typeof response.tabId !== "number") {
                        reject(new Error("Unable to resolve tab id."));
                        return;
                    }

                    resolve(response.tabId);
                });
            });
        }

        return tabIdPromise;
    }

    function relayTabMessage(payload) {
        return new Promise((resolve) => {
            chrome.runtime.sendMessage({ type: "relayTabMessage", payload }, (response) => {
                if (chrome.runtime.lastError) {
                    resolve({ ok: false, error: chrome.runtime.lastError.message });
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

    function storageRemove(keys) {
        return new Promise((resolve) => {
            chrome.storage.local.remove(keys, resolve);
        });
    }
})();
