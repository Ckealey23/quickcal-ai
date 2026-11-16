(function (root) {
  const STORAGE_KEY = "quickcalOnboarding";
  const WELCOME_SEEN_KEY = "quickcalWelcomeSeen";
  const SUPPRESS_KEY = "quickcalCalendarSuppressed";
  const DRAFT_KEY = "quickcalDraftEvent";
  const STEPS = [
    "overview",
    "demo-event",
    "demo-availability",
    "demo-task",
    "demo-documents",
    "connect",
  ];
  const DEMO_STEPS = STEPS.filter((step) => step.indexOf("demo-") === 0);
  const VERSION = 2;
  // Fixed fictional “today” so weekday labels stay consistent in every demo.
  const DEMO_TODAY = "Wednesday, March 11, 2026";

  const CAPABILITIES = [
    {
      id: "event",
      title: "Create events",
      copy: "Turn everyday language into calendar events.",
    },
    {
      id: "availability",
      title: "Find a time",
      copy: "Find openings across your calendars.",
    },
    {
      id: "task",
      title: "Create tasks",
      copy: "Turn to-dos into Google Tasks.",
    },
    {
      id: "documents",
      title: "Import from documents",
      copy: "Find dates in a document and choose what to add.",
    },
  ];

  const DEMOS = {
    "demo-event": {
      id: "demo-event",
      title: "Create an event",
      progress: "1 of 4 examples",
      description:
        "Example: QuickCal turns “Meeting with Joe tomorrow at 8 AM.” into a calendar event for Thursday, March 12, 8:00–9:00 AM.",
      prompt: "Meeting with Joe tomorrow at 8 AM.",
    },
    "demo-availability": {
      id: "demo-availability",
      title: "Find a time",
      progress: "2 of 4 examples",
      description:
        "Example: QuickCal searches Wednesday afternoon openings and schedules “Project sync” for 2:00–2:30 PM.",
      prompt: "Find 30 minutes Wednesday afternoon.",
      eventTitle: "Project sync",
    },
    "demo-task": {
      id: "demo-task",
      title: "Create a task",
      progress: "3 of 4 examples",
      description:
        "Example: QuickCal creates a Google Task titled “Call Joe” due Thursday, March 12.",
      prompt: "Remind me to call Joe tomorrow.",
    },
    "demo-documents": {
      id: "demo-documents",
      title: "Import from documents",
      progress: "4 of 4 examples",
      description:
        "Example: Course syllabus.pdf is reviewed for exams. You choose which dates to add before anything is saved.",
      fileName: "Course syllabus.pdf",
      prompt: "Find all exams.",
      items: [
        { title: "Midterm exam", dateText: "Monday, April 6, 2026", timeText: "10:00–11:30 AM" },
        { title: "Lab practical", dateText: "Wednesday, April 22, 2026", timeText: "2:00–4:00 PM" },
        { title: "Final exam", dateText: "Friday, May 15, 2026", timeText: "1:00–4:00 PM" },
      ],
    },
  };

  function blank() {
    return {
      version: VERSION,
      completed: false,
      step: "overview",
      exampleIndex: 0,
      pendingSelection: "",
      migrated: false,
    };
  }

  function migrateLegacyStep(step) {
    if (step === "welcome") return "overview";
    if (step === "examples") return "demo-event";
    return step;
  }

  function normalizeStep(step) {
    const migrated = migrateLegacyStep(step);
    return STEPS.indexOf(migrated) >= 0 ? migrated : "overview";
  }

  function demoIndex(step) {
    return DEMO_STEPS.indexOf(normalizeStep(step));
  }

  function normalize(raw) {
    if (!raw || typeof raw !== "object") return blank();
    const next = blank();
    next.version = VERSION;
    next.completed = raw.completed === true;
    next.step = normalizeStep(raw.step);
    next.exampleIndex =
      Number.isInteger(raw.exampleIndex) && raw.exampleIndex >= 0 ? raw.exampleIndex : 0;
    if (next.exampleIndex >= DEMO_STEPS.length) next.exampleIndex = 0;
    // Keep exampleIndex aligned with the current demo step when possible.
    const aligned = demoIndex(next.step);
    if (aligned >= 0) next.exampleIndex = aligned;
    next.pendingSelection =
      typeof raw.pendingSelection === "string" ? raw.pendingSelection.slice(0, 2000) : "";
    next.migrated = raw.migrated === true;
    return next;
  }

  // Established installs already opened the old welcome page, connected Google,
  // or saved a draft. Do not force them through the new in-widget tour.
  function shouldMigrateAsComplete(store) {
    if (!store || typeof store !== "object") return false;
    const existing = store[STORAGE_KEY];
    if (existing && existing.completed === true) return true;
    if (store[WELCOME_SEEN_KEY] === true) return true;
    if (store[SUPPRESS_KEY] === false) return true;
    if (store[DRAFT_KEY]) return true;
    return false;
  }

  function sessionView(record, extras) {
    const source = normalize(record);
    const patch = extras && typeof extras === "object" ? extras : {};
    const step = normalizeStep(patch.step || source.step);
    return {
      active: patch.active === true,
      replay: patch.replay === true,
      step: step,
      exampleIndex: demoIndex(step) >= 0 ? demoIndex(step) : source.exampleIndex,
      connectState: typeof patch.connectState === "string" ? patch.connectState : "",
      connectMessage: typeof patch.connectMessage === "string" ? patch.connectMessage : "",
      selectedExample: typeof patch.selectedExample === "string" ? patch.selectedExample : "",
    };
  }

  function isBusyConversation(state) {
    if (!state || !state.visible) return false;
    if (state.onboarding && state.onboarding.active) return false;
    if (state.operation) return true;
    if (state.doc) return true;
    if (state.batch) return true;
    if (state.lookup) return true;
    if (state.mode && state.mode !== "input" && state.mode !== "saved") return true;
    return false;
  }

  function nextStep(step) {
    const index = STEPS.indexOf(normalizeStep(step));
    if (index < 0 || index >= STEPS.length - 1) return "connect";
    return STEPS[index + 1];
  }

  function previousStep(step) {
    const index = STEPS.indexOf(normalizeStep(step));
    if (index <= 0) return "overview";
    return STEPS[index - 1];
  }

  root.QuickCalOnboarding = {
    STORAGE_KEY: STORAGE_KEY,
    WELCOME_SEEN_KEY: WELCOME_SEEN_KEY,
    SUPPRESS_KEY: SUPPRESS_KEY,
    DRAFT_KEY: DRAFT_KEY,
    STEPS: STEPS,
    DEMO_STEPS: DEMO_STEPS,
    CAPABILITIES: CAPABILITIES,
    DEMOS: DEMOS,
    DEMO_TODAY: DEMO_TODAY,
    VERSION: VERSION,
    blank: blank,
    normalize: normalize,
    normalizeStep: normalizeStep,
    shouldMigrateAsComplete: shouldMigrateAsComplete,
    sessionView: sessionView,
    isBusyConversation: isBusyConversation,
    nextStep: nextStep,
    previousStep: previousStep,
    demoIndex: demoIndex,
  };
})(typeof globalThis !== "undefined" ? globalThis : self);
