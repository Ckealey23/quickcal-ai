(() => {
  const HOST_ID = "quickcal-ai-host";
  const STATE_KEY = "__quickcalAi";
  const previewApi = globalThis.QuickCalPreview;
  const INPUT_PLACEHOLDER = "Coffee with Alex tomorrow at 10 AM";
  const FOLLOW_PLACEHOLDER = "Tell me what to change\u2026";

  function paintHost(host, visible, expanded) {
    host.dataset.open = visible ? "true" : "false";
    const width = expanded ? "min(440px, calc(100% - 32px))" : "min(456px, calc(100% - 32px))";
    host.style.cssText = [
      "position:fixed",
      "right:16px",
      "bottom:16px",
      "z-index:2147483647",
      "width:" + width,
      "margin:0",
      "padding:0",
      "border:0",
      "outline:none",
      "box-shadow:none",
      "background:transparent",
      "box-sizing:border-box",
      "pointer-events:none",
      "display:" + (visible ? "block" : "none"),
    ].join(" !important;") + " !important;";
  }

  function safeCalendarLink(value) {
    if (typeof value !== "string") return "";
    try {
      const url = new URL(value);
      const calendarHost =
        url.hostname === "calendar.google.com" ||
        (url.hostname === "www.google.com" && url.pathname.indexOf("/calendar/") === 0);
      if (url.protocol !== "https:" || !calendarHost) return "";
      return url.href;
    } catch (error) {
      return "";
    }
  }

  const current = globalThis[STATE_KEY];
  const existing = document.getElementById(HOST_ID);
  if (current && existing) {
    current.toggle();
    return;
  }
  if (current) current.destroy();
  if (existing) existing.remove();
  if (!document.documentElement) return;

  const host = document.createElement("div");
  host.id = HOST_ID;
  const shadow = host.attachShadow({ mode: "open" });

  const shell = document.createElement("div");
  shell.className = "shell";

  const dismissButton = document.createElement("button");
  dismissButton.type = "button";
  dismissButton.className = "dismiss";
  dismissButton.setAttribute("aria-label", "Hide QuickCalAI");
  dismissButton.title = "Hide QuickCalAI";
  const chevron = document.createElement("img");
  chevron.src = chrome.runtime.getURL("assets/chevron.svg");
  chevron.alt = "";
  chevron.width = 12;
  chevron.height = 12;
  chevron.draggable = false;
  dismissButton.appendChild(chevron);

  const card = document.createElement("section");
  card.className = "card";

  const bar = document.createElement("div");
  bar.className = "bar";

  const input = document.createElement("input");
  input.id = "quickcal-input";
  input.type = "text";
  input.className = "input";
  input.placeholder = INPUT_PLACEHOLDER;
  input.setAttribute("aria-label", "Event description");
  input.autocomplete = "off";

  const micButton = document.createElement("button");
  micButton.type = "button";
  micButton.className = "mic";
  micButton.disabled = true;
  micButton.setAttribute("aria-label", "Voice input coming soon");
  micButton.title = "Voice input coming soon";

  const micIcon = document.createElement("img");
  micIcon.src = chrome.runtime.getURL("assets/mic.svg");
  micIcon.alt = "";
  micIcon.width = 18;
  micIcon.height = 18;
  micIcon.draggable = false;
  micButton.appendChild(micIcon);

  const body = document.createElement("div");
  body.className = "body";
  body.hidden = true;

  const creatingLine = document.createElement("p");
  creatingLine.className = "creating";
  creatingLine.hidden = true;
  creatingLine.textContent = "Creating event\u2026";
  const successRow = document.createElement("div");
  successRow.className = "success";
  successRow.hidden = true;
  const successMark = document.createElement("span");
  successMark.className = "success-mark";
  const successIcon = document.createElement("img");
  successIcon.src = chrome.runtime.getURL("assets/check.svg");
  successIcon.alt = "";
  successIcon.width = 11;
  successIcon.height = 11;
  successMark.appendChild(successIcon);
  const successText = document.createElement("p");
  successText.textContent = "Event successfully created";
  successRow.append(successMark, successText);

  const summary = document.createElement("div");
  summary.className = "summary";
  const eventTitle = document.createElement("p");
  eventTitle.id = "quickcal-event-title";
  eventTitle.className = "event-title";

  function detail(file, width, height) {
    const wrap = document.createElement("div");
    wrap.className = "detail";
    const chip = document.createElement("span");
    chip.className = "chip";
    const icon = document.createElement("img");
    icon.src = chrome.runtime.getURL(file);
    icon.alt = "";
    icon.width = width;
    icon.height = height;
    icon.draggable = false;
    const text = document.createElement("span");
    chip.appendChild(icon);
    wrap.append(chip, text);
    return { wrap: wrap, text: text };
  }

  const dateDetail = detail("assets/calendar.svg", 12, 12);
  const timeDetail = detail("assets/clock.svg", 12, 12);
  const divider = document.createElement("span");
  divider.className = "v-divider";
  const schedule = document.createElement("div");
  schedule.className = "schedule";
  schedule.append(dateDetail.wrap, divider, timeDetail.wrap);
  summary.append(eventTitle, schedule);

  const zoneLine = document.createElement("p");
  zoneLine.className = "meta";
  const recurrenceLine = document.createElement("p");
  recurrenceLine.className = "meta";
  const seriesLine = document.createElement("p");
  seriesLine.className = "meta";
  const locationLine = document.createElement("p");
  locationLine.className = "meta";
  const noteLine = document.createElement("p");
  noteLine.className = "note";
  const questionList = document.createElement("ul");
  questionList.className = "questions";
  const saveError = document.createElement("p");
  saveError.className = "save-error";
  saveError.hidden = true;
  saveError.setAttribute("role", "status");
  const rule = document.createElement("div");
  rule.className = "rule";
  const actions = document.createElement("div");
  actions.className = "actions";

  const retryButton = document.createElement("button");
  retryButton.type = "button";
  retryButton.className = "action";
  retryButton.textContent = "Try again";
  retryButton.hidden = true;

  const connectButton = document.createElement("button");
  connectButton.type = "button";
  connectButton.className = "action";
  connectButton.textContent = "Connect Google Calendar";
  connectButton.hidden = true;

  const viewLink = document.createElement("a");
  viewLink.className = "action";
  viewLink.textContent = "View in Google Calendar";
  viewLink.target = "_blank";
  viewLink.rel = "noopener noreferrer";
  viewLink.hidden = true;

  const newButton = document.createElement("button");
  newButton.type = "button";
  newButton.className = "action";
  newButton.textContent = "New event";
  newButton.hidden = true;

  actions.append(retryButton, connectButton, viewLink, newButton);
  body.append(creatingLine, successRow, summary, zoneLine, recurrenceLine, seriesLine, locationLine, noteLine, questionList, saveError, rule, actions);
  bar.append(input, dismissButton, micButton);
  card.append(bar, body);
  card.setAttribute("aria-labelledby", "quickcal-event-title");

  const status = document.createElement("p");
  status.className = "status";
  status.hidden = true;
  status.setAttribute("role", "status");
  const connectRoute = document.createElement("button");
  connectRoute.type = "button";
  connectRoute.className = "connect-route";
  connectRoute.textContent = "Connect Google Calendar";
  connectRoute.hidden = true;
  const healthRetry = document.createElement("button");
  healthRetry.type = "button";
  healthRetry.className = "health-retry";
  healthRetry.textContent = "Try again";
  healthRetry.hidden = true;
  shell.append(card, status, connectRoute, healthRetry);

  const stylesheet = document.createElement("link");
  stylesheet.rel = "stylesheet";
  stylesheet.href = chrome.runtime.getURL("content/widget.css");
  shadow.append(stylesheet, shell);

  let open = true;
  let styled = false;
  let alive = true;
  let pending = false;
  let saving = false;
  let requestGeneration = 0;
  let saveGeneration = 0;
  let mode = "input";
  let draftEvent = null;
  let draftText = "";
  let savedRecord = null;
  const startupApi = globalThis.QuickCalStartup;
  const session = startupApi.createSession();
  let healthPump = null;
  let connection = null;

  function focusInput() {
    input.focus();
  }

  function clearList(list) {
    while (list.firstChild) list.removeChild(list.firstChild);
  }

  function fillList(list, lines) {
    clearList(list);
    lines.forEach((line) => {
      const item = document.createElement("li");
      item.textContent = line;
      list.appendChild(item);
    });
    list.hidden = lines.length === 0;
  }

  function showStatus(message, isError) {
    status.hidden = false;
    status.textContent = message;
    status.className = isError ? "status error" : "status";
  }

  function clearStatus() {
    status.hidden = true;
    status.textContent = "";
    status.className = "status";
  }

  function showSaveError(message) {
    saveError.hidden = !message;
    saveError.textContent = message || "";
  }

  function fillDetails(view) {
    eventTitle.textContent = view.title || "";
    eventTitle.hidden = !view.title;
    dateDetail.text.textContent = view.date || "";
    timeDetail.text.textContent = view.time || "";
    dateDetail.wrap.hidden = !view.date;
    timeDetail.wrap.hidden = !view.time;
    divider.hidden = !(view.date && view.time);
    schedule.hidden = !(view.date || view.time);
    zoneLine.textContent = view.timeZone || "";
    zoneLine.hidden = !view.timeZone;
    recurrenceLine.textContent = view.recurrenceText || "";
    recurrenceLine.hidden = !view.recurrenceText;
    seriesLine.textContent = view.seriesEndText || "";
    seriesLine.hidden = !view.seriesEndText;
    locationLine.textContent = view.location || "";
    locationLine.hidden = !view.location;
    noteLine.textContent = view.durationDefaulted ? "1-hour default" : "";
    noteLine.hidden = !view.durationDefaulted;
  }

  function hideActions() {
    retryButton.hidden = true;
    connectButton.hidden = true;
    viewLink.hidden = true;
    newButton.hidden = true;
    viewLink.removeAttribute("href");
    rule.hidden = true;
    actions.hidden = true;
  }

  function showInputMode() {
    mode = "input";
    draftEvent = null;
    body.hidden = true;
    card.classList.remove("expanded");
    dismissButton.hidden = false;
    input.placeholder = INPUT_PLACEHOLDER;
    host.dataset.mode = "input";
  }

  function showCard(event) {
    const view = previewApi.previewModel(event);
    card.classList.add("expanded");
    body.hidden = false;
    dismissButton.hidden = true;
    fillDetails(view);
    fillList(questionList, view.questions);
    host.dataset.mode = mode;
    return view;
  }

  function showClarifying(event) {
    mode = "clarifying";
    draftEvent = null;
    clearStatus();
    successRow.hidden = true;
    creatingLine.hidden = true;
    showSaveError("");
    showCard(event);
    hideActions();
  }

  function showCreating(event) {
    mode = "creating";
    draftEvent = event;
    draftText = input.value.trim();
    clearStatus();
    successRow.hidden = true;
    creatingLine.hidden = false;
    creatingLine.textContent = "Creating event\u2026";
    showSaveError("");
    fillList(questionList, []);
    showCard(event);
    hideActions();
  }

  function showFailed(message, disconnected) {
    mode = "failed";
    creatingLine.hidden = true;
    successRow.hidden = true;
    showSaveError(message);
    showCard(draftEvent || {});
    fillList(questionList, []);
    retryButton.hidden = !!disconnected;
    connectButton.hidden = !disconnected;
    viewLink.hidden = true;
    newButton.hidden = true;
    rule.hidden = false;
    actions.hidden = false;
    if (disconnected) connectButton.focus();
    else retryButton.focus();
  }

  function showSaved(result) {
    mode = "saved";
    savedRecord = result;
    draftEvent = null;
    card.classList.add("expanded");
    body.hidden = false;
    dismissButton.hidden = true;
    creatingLine.hidden = true;
    successRow.hidden = false;
    fillDetails({
      title: result.summary,
      date: result.dateText,
      time: result.timeText,
      timeZone: result.timeZone,
      location: result.location || "",
      durationDefaulted: false,
      recurrenceText: result.recurrenceText || "",
      seriesEndText: result.seriesEndText || "",
    });
    fillList(questionList, []);
    showSaveError("");
    retryButton.hidden = true;
    connectButton.hidden = true;
    viewLink.hidden = false;
    viewLink.href = result.htmlLink;
    newButton.hidden = false;
    rule.hidden = false;
    actions.hidden = false;
    input.value = "";
    input.placeholder = FOLLOW_PLACEHOLDER;
    host.dataset.mode = "saved";
    input.focus();
  }

  function showEditQuestion(event) {
    mode = "saved";
    creatingLine.hidden = true;
    successRow.hidden = false;
    if (savedRecord) {
      fillDetails({
        title: savedRecord.summary,
        date: savedRecord.dateText,
        time: savedRecord.timeText,
        timeZone: savedRecord.timeZone,
        location: savedRecord.location || "",
        durationDefaulted: false,
        recurrenceText: savedRecord.recurrenceText || "",
        seriesEndText: savedRecord.seriesEndText || "",
      });
    }
    fillList(questionList, event.clarificationQuestions || []);
    showSaveError("");
    host.dataset.mode = "saved";
  }

  function render() {
    paintHost(host, styled && open, mode !== "input");
    if (styled && open && mode === "input" && !pending && !saving) focusInput();
  }

  function setOpen(next) {
    if (!next) {
      requestGeneration += 1;
      pending = false;
      clearStatus();
      session.noteClosed();
      connectRoute.hidden = true;
      healthRetry.hidden = true;
    } else {
      if (session.phase() !== "ready") {
        const step = session.begin(Date.now());
        if (step.status) showStatus(step.status, false);
        pumpHealth();
      }
      checkConnection();
    }
    open = next;
    render();
  }

  function onEscape(event) {
    if (event.key !== "Escape" || host.dataset.open !== "true") return;
    event.preventDefault();
    event.stopPropagation();
    setOpen(false);
  }

  function currentEventPayload() {
    if (!savedRecord) return null;
    return {
      title: savedRecord.title || savedRecord.summary,
      date: savedRecord.date,
      endDate: savedRecord.endDate || savedRecord.date,
      startTime: savedRecord.startTime,
      endTime: savedRecord.endTime,
      timeZone: savedRecord.timeZone,
      location: savedRecord.location || null,
      recurrence: savedRecord.recurrence || null,
    };
  }

  async function saveDraft() {
    if (saving || pending || !draftEvent || draftEvent.needsClarification) return;
    const generation = saveGeneration + 1;
    saveGeneration = generation;
    const text = draftText;
    saving = true;
    showCreating(draftEvent);

    let result;
    try {
      result = await chrome.runtime.sendMessage({
        type: "quickcal-calendar",
        action: "create",
        event: draftEvent,
      });
    } catch (error) {
      result = { ok: false, error: "QuickCalAI could not save this event." };
    }

    if (!alive || generation !== saveGeneration) return;

    saving = false;
    const link = result && safeCalendarLink(result.htmlLink);
    if (result && result.ok === true && link) {
      showSaved({
        summary: result.summary,
        dateText: result.dateText,
        timeText: result.timeText,
        timeZone: result.timeZone,
        htmlLink: link,
        title: result.title || result.summary,
        date: result.date,
        endDate: result.endDate,
        startTime: result.startTime,
        endTime: result.endTime,
        location: result.location || null,
        recurrence: result.recurrence || null,
        recurrenceText: result.recurrenceText || "",
        seriesEndText: result.seriesEndText || "",
      });
      render();
      return;
    }

    showFailed(
      result && typeof result.error === "string" ? result.error : "QuickCalAI could not save this event.",
      !!(result && result.state === "disconnected")
    );
    render();
  }

  async function saveEdit(event) {
    if (saving || !savedRecord) return;
    const generation = saveGeneration + 1;
    saveGeneration = generation;
    const previous = savedRecord;
    const text = input.value.trim();
    saving = true;
    creatingLine.hidden = false;
    creatingLine.textContent = "Updating event\u2026";
    showSaveError("");

    let result;
    try {
      result = await chrome.runtime.sendMessage({
        type: "quickcal-calendar",
        action: "update",
        event: event,
      });
    } catch (error) {
      result = { ok: false, error: "QuickCalAI could not update this event." };
    }

    if (!alive || generation !== saveGeneration) return;
    saving = false;
    creatingLine.hidden = true;
    const link = result && safeCalendarLink(result.htmlLink);
    if (result && result.ok === true && link) {
      showSaved({
        summary: result.summary,
        dateText: result.dateText,
        timeText: result.timeText,
        timeZone: result.timeZone,
        htmlLink: link,
        title: result.title || result.summary,
        date: result.date,
        endDate: result.endDate,
        startTime: result.startTime,
        endTime: result.endTime,
        location: result.location || null,
        recurrence: result.recurrence || null,
        recurrenceText: result.recurrenceText || "",
        seriesEndText: result.seriesEndText || "",
      });
      render();
      return;
    }
    savedRecord = previous;
    showSaved(previous);
    input.value = text;
    showSaveError(
      result && typeof result.error === "string" ? result.error : "QuickCalAI could not update this event."
    );
    if (result && result.state === "disconnected") {
      viewLink.hidden = true;
      newButton.hidden = true;
      connectButton.hidden = false;
      savedRecord = null;
    }
    render();
  }

  async function submit(text, fromWarmup) {
    if (pending || saving) return;
    if (!fromWarmup && session.phase() !== "ready") {
      const decision = session.requestParse(text, Date.now());
      if (decision.status) showStatus(decision.status, !!decision.retry);
      healthRetry.hidden = !decision.retry;
      if (session.phase() === "waking") pumpHealth();
      render();
      return;
    }
    const generation = requestGeneration + 1;
    requestGeneration = generation;
    const editing = mode === "saved" && savedRecord;
    pending = true;
    if (!editing) showStatus("Reading your event\u2026", false);
    else {
      creatingLine.hidden = false;
      creatingLine.textContent = "Updating event\u2026";
    }
    render();

    let result;
    try {
      const message = {
        type: "quickcal-parse",
        text: text,
        timeZone: editing ? savedRecord.timeZone : Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      };
      if (editing) message.currentEvent = currentEventPayload();
      result = await chrome.runtime.sendMessage(message);
    } catch (error) {
      result = {
        ok: false,
        error: "QuickCalAI could not reach QuickCal. Try again.",
      };
    }

    if (!alive || generation !== requestGeneration || input.value.trim() !== text) {
      if (generation === requestGeneration) pending = false;
      return;
    }
    if (!open) {
      pending = false;
      if (!editing) showInputMode();
      else creatingLine.hidden = true;
      clearStatus();
      return;
    }

    pending = false;
    if (!result || result.ok !== true || !result.event) {
      if (editing) {
        creatingLine.hidden = true;
        showSaveError(
          result && typeof result.error === "string"
            ? result.error
            : "QuickCalAI could not read that change."
        );
      } else {
        showInputMode();
        showStatus(
          result && typeof result.error === "string"
            ? result.error
            : "QuickCalAI could not read that event.",
          true
        );
        if (result && (result.state === "disconnected" || result.state === "unapproved")) {
          connectRoute.hidden = false;
        }
      }
      render();
      return;
    }

    const view = previewApi.previewModel(result.event);
    if (!view.saveable) {
      if (editing) showEditQuestion(result.event);
      else showClarifying(result.event);
      render();
      return;
    }
    if (editing) {
      await saveEdit(result.event);
      return;
    }
    draftEvent = result.event;
    draftText = text;
    await saveDraft();
  }

  function onInputKeyDown(event) {
    if (event.key !== "Enter") return;
    if (event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    event.stopPropagation();
    if (pending || saving) return;
    const text = input.value.trim();
    if (!text) return;
    submit(text);
  }

  function onVisible() {
    if (!alive || !open || document.visibilityState !== "visible") return;
    checkConnection();
  }

  function destroy() {
    if (!alive) return;
    alive = false;
    requestGeneration += 1;
    saveGeneration += 1;
    document.removeEventListener("keydown", onEscape, true);
    document.removeEventListener("visibilitychange", onVisible);
    host.remove();
    if (globalThis[STATE_KEY] && globalThis[STATE_KEY].destroy === destroy) {
      delete globalThis[STATE_KEY];
    }
  }

  dismissButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    setOpen(false);
  });
  retryButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    saveDraft();
  });
  newButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    savedRecord = null;
    chrome.runtime.sendMessage({ type: "quickcal-calendar", action: "new" });
    input.value = "";
    showInputMode();
    render();
  });
  connectButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    chrome.runtime.sendMessage({ type: "quickcal-calendar", action: "open-settings" });
  });
  connectRoute.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    chrome.runtime.sendMessage({ type: "quickcal-calendar", action: "open-settings" });
  });
  healthRetry.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (pending || saving) return;
    session.retry(Date.now());
    healthRetry.hidden = true;
    showStatus(globalThis.QuickCalStartup.CONNECTING, false);
    pumpHealth();
  });
  input.addEventListener("keydown", onInputKeyDown);
  input.addEventListener("input", () => {
    if (pending && mode !== "saved") {
      requestGeneration += 1;
      pending = false;
      clearStatus();
    }
    if (!status.hidden && status.className.indexOf("error") !== -1) clearStatus();
  });

  async function restoreActive() {
    let result;
    try {
      result = await chrome.runtime.sendMessage({ type: "quickcal-calendar", action: "active" });
    } catch (error) {
      return;
    }
    if (!alive || !open || mode !== "input" || input.value.trim() || pending || saving) return;
    if (result && result.event && safeCalendarLink(result.event.htmlLink)) showSaved(result.event);
  }

  async function checkConnection() {
    let result;
    try {
      result = await chrome.runtime.sendMessage({ type: "quickcal-calendar", action: "status" });
    } catch (error) {
      return;
    }
    if (!alive || !open) return;
    connection = result;
    const needsAccount = result && result.connected === false;
    const needsApproval = result && result.connected === true && result.quickcalReady === false && result.message;
    connectRoute.hidden = !(needsAccount || needsApproval);
    if ((needsAccount || needsApproval) && session.phase() !== "waking") {
      showStatus(
        needsAccount ? "Connect Google Calendar to use QuickCalAI." : result.message,
        true
      );
    } else if (!needsAccount && !needsApproval && status.textContent === "Connect Google Calendar to use QuickCalAI.") {
      clearStatus();
    }
    if (mode === "failed" && !saving && draftEvent && !connectButton.hidden && result && result.connected === true) {
      showSaveError("");
      connectButton.hidden = true;
      retryButton.hidden = false;
    }
  }

  async function pumpHealth() {
    if (healthPump || !startupApi) return;
    const run = (async () => {
      while (alive && open && session.phase() === "waking") {
        let result = { ok: false };
        try {
          result = await chrome.runtime.sendMessage({ type: "quickcal-backend", action: "health" });
        } catch (error) {
          result = { ok: false };
        }
        if (!alive || !open || session.phase() !== "waking") return;
        const step = session.healthResult(!!(result && result.ok), Date.now());
        if (step.status) showStatus(step.status, !!step.retry);
        else if (!connection || connection.connected !== false) clearStatus();
        healthRetry.hidden = !step.retry;
        if (step.parse && step.text && input.value.trim() === step.text) await submit(step.text, true);
        if (step.done) {
          if (connection && connection.connected === false) {
            showStatus("Connect Google Calendar to use QuickCalAI.", true);
            connectRoute.hidden = false;
          } else if (connection && connection.quickcalReady === false && connection.message) {
            showStatus(connection.message, true);
            connectRoute.hidden = false;
          }
          return;
        }
        if (step.waitMs) await new Promise((resolve) => setTimeout(resolve, step.waitMs));
      }
    })();
    healthPump = run;
    run.finally(() => {
      if (healthPump === run) healthPump = null;
    });
  }

  stylesheet.addEventListener("load", () => {
    styled = true;
    render();
    restoreActive();
    const step = session.begin(Date.now());
    if (step.status) showStatus(step.status, false);
    pumpHealth();
    checkConnection();
  });

  stylesheet.addEventListener("error", () => {
    console.info("QuickCalAI: the input bar styles failed to load.");
    destroy();
  });

  document.addEventListener("keydown", onEscape, true);
  document.addEventListener("visibilitychange", onVisible);
  document.documentElement.appendChild(host);
  host.dataset.mode = "input";
  render();

  globalThis[STATE_KEY] = {
    toggle() {
      setOpen(!open);
    },
    destroy,
  };
})();
