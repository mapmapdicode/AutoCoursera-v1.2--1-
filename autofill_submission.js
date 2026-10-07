(() => {
    const titleText = "Predicting Customer Churn for a Subscription-Based Telecom Company (ConnectCo)";
    
    const fullSubmissionText = `# Initiating a Data Science Project: Customer Churn Prediction

## 1. Business Issue / Problem Statement
ConnectCo is a mid-sized telecom provider with approximately 500,000 active residential mobile and broadband subscribers. Over the past 12 months, monthly subscriber churn has increased from 1.5% to 2.4%, resulting in an estimated annual loss of $9.2 million in recurring revenue. The Customer Acquisition Cost (CAC) is roughly five times the cost of retaining an existing subscriber. Currently, customer retention relies on reactive outreach (contacting customers only after a cancellation request is logged), at which point customer save-rates fall below 12%.

**Key Business Question:**
Can we accurately predict which residential subscribers are at high risk of cancelling their service within the next 60 days, allowing our retention team to execute timely, targeted intervention offers?

**Data Science Problem Formulation:**
This is framed as a supervised binary classification problem. The target variable is binary: Churned within 60 days (1 = Yes, 0 = No). The features comprise historical usage trends, customer service ticket history, billing patterns, contract tenure, and demographic metadata. The model outputs a probability risk score (0.0 to 1.0) for each active subscriber along with local feature importance (SHAP values) indicating the primary churn drivers.

---

## 2. Suitability for a Data Science Solution
The problem is exceptionally well-suited for data science based on the following criteria:
1. **Clear, Measurable Objective:** Churn is unambiguously recorded via service cancellation events and disconnect dates.
2. **Abundant Historical Data:** Over 36 months of longitudinal CRM records, network call detail records (CDRs), support ticket histories, and monthly billing logs exist for training and validation.
3. **Complex, Non-Linear Patterns:** Churn signals involve complex interactions between declining usage trends, unresolved support tickets, and pricing changes that human heuristics cannot reliably detect.
4. **Actionable Output:** Retention managers can directly consume ranked risk lists to deploy targeted incentives (plan upgrades, loyalty discounts, priority support).
5. **Demonstrable Business ROI:** Reducing churn by just 0.3 percentage points preserves over $1.1 million in annual revenue, far exceeding projected implementation and operational costs (~$220,000).
6. **Repeatable Process:** Model scoring can be scheduled as a recurring monthly batch pipeline rather than a one-off diagnostic.

---

## 3. Stakeholders and Needs
- **VP of Customer Experience (Executive Sponsor):** Requires measurable reduction in churn rate, executive KPI dashboards, and positive return on investment (ROI).
- **Customer Retention Team Manager (Primary End-User):** Needs weekly/monthly prioritized lists of at-risk customers, interpretable risk drivers, and integration with customer management workflows.
- **Marketing Team:** Requires identification of high-risk customer segments to design compelling retention packages and promotional offers.
- **Finance & Revenue Assurance:** Needs validation of net revenue retained versus the cost of retention offers and model development.
- **IT & Data Engineering:** Requires well-defined data pipelines, scalable ETL jobs, data security compliance, and low-latency access to model artifacts.
- **Data Protection Officer / Legal:** Requires compliance with data privacy regulations (GDPR/CCPA), transparent customer consent, and prevention of discriminatory features.
- **Data Science & Analytics Team:** Requires clean data feeds, stakeholder domain knowledge, and clear acceptance criteria.

---

## 4. Objectives and Success Criteria (KPIs)
**Business KPIs:**
- Reduce monthly residential churn from 2.4% to 2.0% within 6 months post-deployment.
- Increase retention campaign conversion (save-rate) from 12% to at least 20%.
- Maintain customer retention spend within approved marketing budget parameters.

**Data Science / Technical KPIs:**
- Area Under the ROC Curve (ROC-AUC) >= 0.80 on out-of-time test sets.
- Recall >= 70% within the top 10% highest-risk predicted customer decile.
- Explainability: Produce the top 3 contributing factors (SHAP values) for each flagged customer.
- Scalability: Complete batch scoring of all 500,000 subscribers within 3 hours.

---

## 5. Project Scope, Constraints & Assumptions
- **In-Scope:** Postpaid residential mobile and broadband customers; 36 months of historical data; supervised predictive model and explainability pipeline; monthly scoring batch job; executive and operational dashboards; an 8-week randomized controlled A/B pilot.
- **Out-of-Scope:** B2B/enterprise corporate accounts; prepaid pay-as-you-go subscribers; designing retention offers (owned by Marketing); real-time sub-second inference.
- **Assumptions & Constraints:** Data across CRM, Billing, and Support systems can be accurately joined via a unified Customer ID; protected demographic attributes (race, gender, religion) are excluded to prevent algorithmic bias; project completion to MVP in 16 weeks with 2 Data Scientists and 1 Data Engineer.

---

## 6. Data Requirements & Governance
- **Data Sources:** CRM (tenure, contract type, plan tiers); Billing (monthly invoice amounts, payment delays, overage fees); Network Usage (data consumption trends, dropped calls); Customer Support (ticket counts, complaint categories, time-to-resolution); Churn History (cancellation timestamps and reasons).
- **Data Governance & Ethics:** De-identification of personally identifiable information (PII); strict role-based access control (RBAC); algorithmic bias auditing across age bands and geographic clusters; regular monitoring for data drift and concept drift with quarterly model retraining.

---

## 7. Phased Implementation (CRISP-DM / POC & MVP)
- **Phase 1: Proof of Concept (Weeks 1-6):** Historical data extraction, exploratory data analysis (EDA), data cleaning, baseline modeling (Logistic Regression vs. XGBoost), offline validation against past 6 months. Milestone: Go/No-Go executive review.
- **Phase 2: MVP Development (Weeks 7-12):** Automated ETL pipeline, model registry, SHAP explainability integration, operational dashboard deployment.
- **Phase 3: Pilot & Validation (Weeks 13-16):** Randomized controlled A/B test with 25,000 customers. Treatment group receives model-driven outreach; control group receives standard reactive outreach. Final review and full rollout sign-off.`;

    function updateReactInput(element, value) {
        if (!element) return;
        element.focus();
        
        if (element.isContentEditable) {
            element.innerText = value;
            element.dispatchEvent(new Event('input', { bubbles: true }));
            element.dispatchEvent(new Event('change', { bubbles: true }));
            return;
        }

        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype, "value"
        )?.set;
        const nativeTextAreaValueSetter = Object.getOwnPropertyDescriptor(
            window.HTMLTextAreaElement.prototype, "value"
        )?.set;

        if (element.tagName === "TEXTAREA" && nativeTextAreaValueSetter) {
            nativeTextAreaValueSetter.call(element, value);
        } else if (element.tagName === "INPUT" && nativeInputValueSetter) {
            nativeInputValueSetter.call(element, value);
        } else {
            element.value = value;
        }

        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
        element.dispatchEvent(new Event("blur", { bubbles: true }));
    }

    // 1. Fill Title
    const titleInput = document.querySelector('input[name*="title" i], input[id*="title" i], input[placeholder*="title" i], input[type="text"]:not([id*="search" i])');
    if (titleInput) {
        updateReactInput(titleInput, titleText);
        console.log("Filled Title successfully.");
    }

    // 2. Fill Textareas or Rich Text Editors
    const textareas = Array.from(document.querySelectorAll('textarea, div[contenteditable="true"], div[role="textbox"]'));
    if (textareas.length === 1) {
        updateReactInput(textareas[0], fullSubmissionText);
        console.log("Filled single submission textarea successfully.");
    } else if (textareas.length > 1) {
        textareas.forEach((box, idx) => {
            updateReactInput(box, fullSubmissionText);
            console.log(`Filled textarea #${idx + 1}`);
        });
    }

    // 3. Tick honor code / agreement checkboxes
    const checkboxes = document.querySelectorAll('input[type="checkbox"]');
    checkboxes.forEach((cb) => {
        if (!cb.checked) {
            cb.click();
            cb.dispatchEvent(new Event('change', { bubbles: true }));
            console.log("Checked honor code agreement.");
        }
    });

    console.log("Autofill completed! Please review and click 'Submit' button when ready.");
    alert("Đã tự động điền bài thành công! Bạn hãy kiểm tra lại và bấm Submit.");
})();
