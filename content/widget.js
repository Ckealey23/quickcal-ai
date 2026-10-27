(() => {
  const HOST_ID = "quickcal-ai-host";
  const STATE_KEY = "__quickcalAi";
  const previewApi = globalThis.QuickCalPreview;
  const INPUT_PLACEHOLDER = "Coffee with Alex tomorrow at 10 AM";
  const FOLLOW_PLACEHOLDER = "Tell me what to change\u2026";

  function paintHost(host, visible, expanded) {
    host.dataset.open = visible ? "true" : "false";
    const layoutApi = globalThis.QuickCalLayout;
    const natural = layoutApi ? layoutApi.naturalWidth(expanded) : (expanded ? 440 : 456);
    const scale = widgetScale > 0 ? widgetScale : 1;
    const width = Math.round(natural * scale);
    const placed = typeof widgetLeft === "number" && typeof widgetTop === "number";
    host.style.cssText = [
      "position:fixed",
      placed ? "left:" + widgetLeft + "px" : "right:16px",
      placed ? "top:" + widgetTop + "px" : "bottom:16px",
      placed ? "right:auto" : "left:auto",
      placed ? "bottom:auto" : "top:auto",
      "z-index:2147483647",
      "width:" + width + "px",
      "height:auto",
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
    if (shell) {
      shell.style.zoom = String(scale);
      shell.style.width = natural + "px";
    }
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
  if (current && existing) return;
  if (current) current.destroy();
  if (existing) existing.remove();
  if (!document.documentElement) return;

  const host = document.createElement("div");
  host.id = HOST_ID;
  const shadow = host.attachShadow({ mode: "open" });

  const shell = document.createElement("div");
  shell.className = "shell";

  const dragHandle = document.createElement("div");
  dragHandle.className = "drag-handle";
  dragHandle.setAttribute("aria-hidden", "true");

  function resizeControl(corner) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "resize resize-" + corner;
    button.dataset.corner = corner;
    button.setAttribute("aria-label", "Resize QuickCalAI");
    button.title = "Resize QuickCalAI";
    if (corner === "nw") {
      const mark = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      mark.setAttribute("viewBox", "0 0 12 12");
      mark.setAttribute("width", "12");
      mark.setAttribute("height", "12");
      mark.setAttribute("aria-hidden", "true");
      const shaft = document.createElementNS("http://www.w3.org/2000/svg", "path");
      shaft.setAttribute("d", "M8.5 8.5 L3.5 3.5");
      const head = document.createElementNS("http://www.w3.org/2000/svg", "path");
      head.setAttribute("d", "M3.5 6.7 V3.5 H6.7");
      [shaft, head].forEach((part) => {
        part.setAttribute("fill", "none");
        part.setAttribute("stroke", "#8aa4d6");
        part.setAttribute("stroke-width", "1.5");
        part.setAttribute("stroke-linecap", "round");
        part.setAttribute("stroke-linejoin", "round");
        mark.appendChild(part);
      });
      button.appendChild(mark);
    }
    return button;
  }

  const resizeNw = resizeControl("nw");
  const resizeNe = resizeControl("ne");
  const resizeSw = resizeControl("sw");
  const resizeSe = resizeControl("se");

  const dismissButton = document.createElement("button");
  dismissButton.type = "button";
  dismissButton.className = "dismiss";
  dismissButton.setAttribute("aria-label", "Close QuickCal");
  dismissButton.title = "Close QuickCal";
  const closeMark = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  closeMark.setAttribute("viewBox", "0 0 12 12");
  closeMark.setAttribute("width", "12");
  closeMark.setAttribute("height", "12");
  closeMark.setAttribute("aria-hidden", "true");
  const closePath = document.createElementNS("http://www.w3.org/2000/svg", "path");
  closePath.setAttribute("d", "M3 3 L9 9 M9 3 L3 9");
  closePath.setAttribute("fill", "none");
  closePath.setAttribute("stroke", "currentColor");
  closePath.setAttribute("stroke-width", "1.5");
  closePath.setAttribute("stroke-linecap", "round");
  closeMark.appendChild(closePath);
  dismissButton.appendChild(closeMark);

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
  micButton.setAttribute("aria-label", "Start voice input");
  micButton.title = "Start voice input";

  const micIcon = document.createElement("img");
  micIcon.src = chrome.runtime.getURL("assets/mic.svg");
  micIcon.alt = "";
  micIcon.width = 18;
  micIcon.height = 18;
  micIcon.draggable = false;
  const micMark = document.createElement("span");
  micMark.className = "mic-mark";
  micMark.hidden = true;
  micButton.append(micIcon, micMark);

  const listening = document.createElement("div");
  listening.className = "listening";
  listening.hidden = true;
  const recDot = document.createElement("span");
  recDot.className = "rec-dot";
  recDot.setAttribute("aria-hidden", "true");
  const listeningLabel = document.createElement("span");
  listeningLabel.className = "listening-label";
  listeningLabel.textContent = "Listening";
  const elapsed = document.createElement("span");
  elapsed.className = "elapsed";
  elapsed.textContent = "0:00";
  const discardButton = document.createElement("button");
  discardButton.type = "button";
  discardButton.className = "discard";
  discardButton.textContent = "Discard";
  discardButton.hidden = true;
  listening.append(recDot, listeningLabel, elapsed, discardButton);

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
  const remindersLine = document.createElement("p");
  remindersLine.className = "meta";
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

  const cancelButton = document.createElement("button");
  cancelButton.type = "button";
  cancelButton.className = "action";
  cancelButton.textContent = "Cancel";
  cancelButton.hidden = true;

  actions.append(retryButton, connectButton, viewLink, newButton, cancelButton);
  body.append(creatingLine, successRow, summary, zoneLine, recurrenceLine, seriesLine, locationLine, remindersLine, noteLine, questionList, saveError, rule, actions);
  bar.append(input, listening, dismissButton, micButton);
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
  const selectionChoice = document.createElement("div");
  selectionChoice.className = "selection-choice";
  selectionChoice.hidden = true;
  const useSelection = document.createElement("button");
  useSelection.type = "button";
  useSelection.className = "use-selection";
  useSelection.textContent = "Use selection";
  const keepDraft = document.createElement("button");
  keepDraft.type = "button";
  keepDraft.className = "keep-draft";
  keepDraft.textContent = "Keep draft";
  selectionChoice.append(useSelection, keepDraft);
  const panel = document.createElement("div");
  panel.className = "panel";
  panel.append(resizeNw, resizeNe, resizeSw, resizeSe, card);
  shell.append(dragHandle, panel, status, selectionChoice, connectRoute, healthRetry);

  const stylesheet = document.createElement("link");
  stylesheet.rel = "stylesheet";
  stylesheet.href = chrome.runtime.getURL("content/widget.css");
  shadow.append(stylesheet, shell);

  const shared = !!(chrome.storage && chrome.storage.session);
  const incognito = !!(chrome.extension && chrome.extension.inIncognitoContext);
  let open = !shared;
  let widgetScale = 1;
  let widgetLeft = null;
  let widgetTop = null;
  let sharedSessionId = "";
  let sharedClaim = 0;
  let sharedInputSeq = 0;
  let applyingRemote = false;
  let inputDirty = false;
  let inputFlight = false;
  let queuedRemote = null;
  let allowFocus = !shared;
  let dragging = null;
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
  let clarification = null;
  const startupApi = globalThis.QuickCalStartup;
  const session = startupApi.createSession();
  let healthPump = null;
  let connection = null;
  let voicePhase = "idle";
  let voiceSession = 0;
  let voiceGeneration = 0;
  let voiceStartedAt = 0;
  let voiceTimer = 0;
  let typedDraft = "";
  let pendingSelection = "";
  let selectionHold = false;
  const seenSelections = new Set();

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
    selectionHold = false;
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
    remindersLine.textContent = view.remindersText || "";
    remindersLine.hidden = !view.remindersText;
    noteLine.textContent = view.durationDefaulted ? "1-hour default" : "";
    noteLine.hidden = !view.durationDefaulted;
  }

  function hideActions() {
    retryButton.hidden = true;
    connectButton.hidden = true;
    viewLink.hidden = true;
    newButton.hidden = true;
    cancelButton.hidden = true;
    viewLink.removeAttribute("href");
    rule.hidden = true;
    actions.hidden = true;
  }

  function showInputMode() {
    mode = "input";
    draftEvent = null;
    body.hidden = true;
    card.classList.remove("expanded");
    card.classList.remove("clarifying");
    dismissButton.hidden = false;
    input.placeholder = INPUT_PLACEHOLDER;
    input.setAttribute("aria-label", "Event description");
    host.dataset.mode = "input";
  }

  function showCard(event) {
    const view = previewApi.previewModel(event);
    card.classList.add("expanded");
    body.hidden = false;
    dismissButton.hidden = false;
    fillDetails(view);
    fillList(questionList, view.questions);
    host.dataset.mode = mode;
    return view;
  }

  function draftFromEvent(event) {
    return {
      title: event.title || null,
      date: event.date || null,
      startTime: event.startTime || null,
      endTime: event.endTime || null,
      timeZone: event.timeZone,
      location: event.location || null,
      recurrence: event.recurrence || null,
      reminders: event.reminders || null,
    };
  }

  function isScheduleQuestion(question) {
    return /what date should|which date|what time does this event start/i.test(question);
  }

  function clarificationPrompt(event) {
    const questions = [];
    (event.clarificationQuestions || []).forEach((question) => {
      if (typeof question !== "string") return;
      const trimmed = question.trim();
      if (trimmed && questions.indexOf(trimmed) === -1) questions.push(trimmed);
    });
    const special = questions.filter((question) => !isScheduleQuestion(question));
    if (special.length) return { question: special[0], placeholder: "Your answer" };
    if (!event.date && !event.startTime) return { question: "What date and time?", placeholder: "Tuesday at 8 PM" };
    if (!event.date) return { question: "What date?", placeholder: "Tuesday" };
    if (!event.startTime) return { question: "What time?", placeholder: "8 PM" };
    return { question: questions[0] || "What should be clarified?", placeholder: "Your answer" };
  }

  function showClarifying(event, sourceText) {
    mode = "clarifying";
    const originalText = clarification && clarification.originalText ? clarification.originalText : sourceText;
    clarification = { originalText: originalText, draft: draftFromEvent(event) };
    draftEvent = null;
    clearStatus();
    successRow.hidden = true;
    creatingLine.hidden = true;
    showSaveError("");
    showCard(event);
    const prompt = clarificationPrompt(event);
    fillList(questionList, [prompt.question]);
    hideActions();
    newButton.hidden = false;
    cancelButton.hidden = false;
    rule.hidden = false;
    actions.hidden = false;
    card.classList.add("clarifying");
    input.value = "";
    input.placeholder = prompt.placeholder;
    input.setAttribute("aria-label", "Answer");
    host.dataset.mode = "clarifying";
    if (allowFocus) input.focus();
  }

  function showCreating(event) {
    mode = "creating";
    clarification = null;
    card.classList.remove("clarifying");
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
    cancelButton.hidden = true;
    rule.hidden = false;
    actions.hidden = false;
    if (allowFocus) {
      if (disconnected) connectButton.focus();
      else retryButton.focus();
    }
  }

  function showSaved(result) {
    mode = "saved";
    clarification = null;
    card.classList.remove("clarifying");
    savedRecord = result;
    draftEvent = null;
    card.classList.add("expanded");
    body.hidden = false;
    dismissButton.hidden = false;
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
      remindersText: result.remindersText || "",
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
    input.setAttribute("aria-label", "Event description");
    cancelButton.hidden = true;
    host.dataset.mode = "saved";
    if (allowFocus) input.focus();
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
        remindersText: savedRecord.remindersText || "",
      });
    }
    fillList(questionList, event.clarificationQuestions || []);
    showSaveError("");
    host.dataset.mode = "saved";
  }

  function render() {
    paintHost(host, styled && open, mode !== "input");
    if (allowFocus && styled && open && (mode === "input" || mode === "clarifying") && !pending && !saving && voicePhase === "idle") focusInput();
  }

  function resetConversation() {
    requestGeneration += 1;
    saveGeneration += 1;
    pending = false;
    saving = false;
    clarification = null;
    savedRecord = null;
    draftEvent = null;
    draftText = "";
    input.value = "";
    showInputMode();
    clearStatus();
    hideActions();
    pendingSelection = "";
    selectionChoice.hidden = true;
    connectRoute.hidden = true;
    healthRetry.hidden = true;
    showSaveError("");
    creatingLine.hidden = true;
    successRow.hidden = true;
  }

  function setOpen(next) {
    if (shared) {
      if (!next && voicePhase !== "idle") cancelVoice();
      return chrome.runtime.sendMessage({ type: "quickcal-widget", action: next ? "show" : "dismiss" }).then((result) => {
        if (!alive) return result;
        if (result && result.session) {
          applyRemote(result.session, !!next && !!result.session.visible);
          if (result.session.visible) prepareOpenTab();
        } else {
          showStatus("QuickCalAI could not update the shared session.", true);
          render();
        }
        return result;
      }).catch(() => {
        if (!alive) return null;
        showStatus("QuickCalAI could not update the shared session.", true);
        render();
        return null;
      });
    }
    if (!next) {
      if (voicePhase !== "idle") cancelVoice();
      resetConversation();
      session.noteClosed();
      open = false;
      render();
      return Promise.resolve();
    }
    allowFocus = true;
    open = true;
    prepareOpenTab();
    render();
    return Promise.resolve();
  }

  function prepareOpenTab() {
    if (session.phase() !== "ready") {
      const step = session.begin(Date.now());
      if (step.status && !input.value.trim() && mode === "input" && !selectionHold) showStatus(step.status, false);
      pumpHealth();
    }
    checkConnection();
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
      reminders: savedRecord.reminders || null,
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
        reminders: result.reminders || null,
        remindersText: result.remindersText || "",
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
        reminders: result.reminders || null,
        remindersText: result.remindersText || "",
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
    if (shared) {
      const fresh = submitFresh;
      submitFresh = false;
      submitShared(text, fresh);
      return;
    }
    const generation = requestGeneration + 1;
    requestGeneration = generation;
    const editing = mode === "saved" && savedRecord;
    const answering = mode === "clarifying" && clarification;
    const clarificationContext = answering
      ? { originalText: clarification.originalText, draft: clarification.draft }
      : null;
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
        timeZone: answering && clarificationContext.draft.timeZone
          ? clarificationContext.draft.timeZone
          : editing
            ? savedRecord.timeZone
            : Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      };
      if (answering) message.clarification = clarificationContext;
      else if (editing) message.currentEvent = currentEventPayload();
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
      if (!editing && !clarification) showInputMode();
      else if (editing) creatingLine.hidden = true;
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
      } else if (answering) {
        showStatus(
          result && typeof result.error === "string"
            ? result.error
            : "QuickCalAI could not read that answer.",
          true
        );
        if (result && (result.state === "disconnected" || result.state === "unapproved")) {
          connectRoute.hidden = false;
        }
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
      else showClarifying(result.event, text);
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

  function rememberSelection(operationId) {
    seenSelections.add(operationId);
    if (seenSelections.size > 30) seenSelections.delete(seenSelections.values().next().value);
  }

  function dismissSelectionChoice() {
    pendingSelection = "";
    selectionChoice.hidden = true;
  }

  function showSelectionStatus(message) {
    selectionHold = true;
    showStatus(message, true);
  }

  function selectionBusy() {
    return pending || saving || voicePhase !== "idle";
  }

  function discardClarification() {
    requestGeneration += 1;
    pending = false;
    clarification = null;
    savedRecord = null;
    input.value = "";
    chrome.runtime.sendMessage({ type: "quickcal-calendar", action: "new" }).catch(() => {});
    if (shared) chrome.runtime.sendMessage({ type: "quickcal-widget", action: "reset" }).catch(() => {});
    showInputMode();
    clearStatus();
    render();
  }

  async function beginNewEvent(text) {
    dismissSelectionChoice();
    selectionHold = false;
    clarification = null;
    savedRecord = null;
    showInputMode();
    input.value = text;
    submitFresh = true;
    try {
      await chrome.runtime.sendMessage({ type: "quickcal-calendar", action: "new" });
    } catch (error) {
      // A failed clear still starts a new event because this submission has no saved record.
    }
    if (!alive || !open || input.value.trim() !== text) return;
    submit(text);
  }

  function acceptSelection(message) {
    const plan = globalThis.QuickCalSelection.planSelection({
      operationId: message && message.operationId,
      text: message && message.text,
      tooLong: !!(message && message.tooLong),
      maxLength: globalThis.QuickCalSelection.MAX_TEXT_LENGTH,
      seen: seenSelections,
      busy: selectionBusy(),
      draft: input.value.trim().length > 0 || mode === "clarifying",
    });
    if (plan.action === "ignore") return { ok: true, ignored: true };
    rememberSelection(plan.operationId);
    const start = () => {
      if (!alive || (shared && !open)) return;
      if (plan.action === "tooLong" || plan.action === "busy") {
        showSelectionStatus(plan.message);
        return;
      }
      if (plan.action === "confirm") {
        pendingSelection = plan.text;
        selectionChoice.hidden = false;
        showStatus(plan.message, false);
        return;
      }
      beginNewEvent(plan.text);
    };
    if (!open) {
      const opening = setOpen(true);
      if (open) start();
      else Promise.resolve(opening).then(() => start());
    } else {
      start();
    }
    return { ok: true, action: plan.action === "submit" ? "submit" : plan.action };
  }

  let submitFresh = false;

  function sessionStorageKey() {
    return incognito ? "quickcalWidgetSessionIncognito" : "quickcalWidgetSession";
  }

  function claimLeader() {
    if (!shared || !open) return Promise.resolve(null);
    return chrome.runtime.sendMessage({ type: "quickcal-widget", action: "claim" }).then((result) => {
      if (!result || !result.session || !alive) return result || null;
      sharedClaim = result.session.claim || 0;
      sharedSessionId = result.session.sessionId || sharedSessionId;
      if (typeof result.session.inputSeq === "number" && result.session.inputSeq > sharedInputSeq) {
        sharedInputSeq = result.session.inputSeq;
      }
      return result;
    }).catch(() => {
      console.info("QuickCalAI: could not update the shared session.");
      return null;
    });
  }

  function publishInput(attempt) {
    if (!shared || applyingRemote) return;
    inputDirty = true;
    if (document.visibilityState !== "visible") return;
    if (!sharedSessionId || inputFlight) return;
    const tries = attempt || 0;
    inputFlight = true;
    inputDirty = false;
    const text = input.value;
    const seq = sharedInputSeq + 1;
    const claim = sharedClaim;
    const sessionId = sharedSessionId;
    chrome.runtime.sendMessage({
      type: "quickcal-widget",
      action: "patch",
      sessionId: sessionId,
      claim: claim,
      seq: seq,
      input: text,
    }).then((result) => {
      inputFlight = false;
      if (!alive) return;
      if (!result || !result.session) {
        showStatus("QuickCalAI could not update the shared session.", true);
        render();
        return;
      }
      sharedSessionId = result.session.sessionId || sharedSessionId;
      sharedClaim = result.session.claim || 0;
      if (typeof result.session.inputSeq === "number") sharedInputSeq = result.session.inputSeq;
      const focused = shadow.activeElement === input || document.visibilityState === "visible";
      if (result.accepted) {
        if (input.value !== text || inputDirty) publishInput(0);
        return;
      }
      if (!result.session.visible || result.session.sessionId !== sessionId) {
        inputDirty = false;
        applyRemote(result.session, false);
        return;
      }
      if (focused && input.value !== (result.session.input || "") && tries < 1) {
        claimLeader().then(() => {
          inputDirty = true;
          publishInput(tries + 1);
        });
        return;
      }
      inputDirty = false;
      applyRemote(result.session, false);
    }).catch(() => {
      inputFlight = false;
      if (!alive) return;
      showStatus("QuickCalAI could not update the shared session.", true);
      render();
    });
  }

  function publishLayout() {
    if (!shared) return;
    chrome.runtime.sendMessage({
      type: "quickcal-widget",
      action: "layout",
      layout: { scale: widgetScale, left: widgetLeft, top: widgetTop },
    }).catch(() => {
      console.info("QuickCalAI: could not save the shared panel position.");
    });
  }

  function viewportSize() {
    return { width: window.innerWidth, height: window.innerHeight };
  }

  function applyLayout(layout, force) {
    if (!layout || (dragging && !force)) return;
    const api = globalThis.QuickCalLayout;
    if (layout.scale > 0) widgetScale = layout.scale;
    widgetLeft = typeof layout.left === "number" ? layout.left : null;
    widgetTop = typeof layout.top === "number" ? layout.top : null;
    if (!api || widgetLeft == null || widgetTop == null) return;
    const rect = host.getBoundingClientRect();
    const clamped = api.clampPosition(widgetLeft, widgetTop, rect.width || 1, rect.height || 1, viewportSize());
    widgetLeft = clamped.left;
    widgetTop = clamped.top;
  }

  function applyRemote(state, focus) {
    if (!state || !!state.incognito !== !!incognito) return;
    applyingRemote = true;
    allowFocus = !!focus;
    try {
      sharedSessionId = state.sessionId || sharedSessionId;
      sharedClaim = state.claim || 0;
      if (typeof state.inputSeq === "number" && state.inputSeq >= sharedInputSeq) sharedInputSeq = state.inputSeq;
      if (state.layout) applyLayout(state.layout, true);
      const remoteSeq = typeof state.inputSeq === "number" ? state.inputSeq : 0;
      if (remoteSeq > sharedInputSeq) sharedInputSeq = remoteSeq;
      if (state.voice && state.voice.phase && state.voice.phase !== "idle") {
        voiceSession = state.voice.sessionId || voiceSession;
        voicePhase = state.voice.phase;
        if (state.voice.startedAt) voiceStartedAt = state.voice.startedAt;
        paintVoice();
        if (voicePhase === "recording") startVoiceClock(true);
        else stopVoiceTimer();
      } else if (voicePhase !== "idle") {
        resetVoiceUi(false);
      }
      if (!state.visible) {
        open = false;
        inputDirty = false;
        clarification = null;
        savedRecord = null;
        draftEvent = null;
        draftText = "";
        input.value = "";
        showInputMode();
        clearStatus();
        hideActions();
        render();
        return;
      }
      open = true;
      const focused = shadow.activeElement === input;
      const keepTyped = focused && inputDirty && input.value !== (state.input || "");
      if (state.mode === "clarifying" && state.event) {
        clarification = state.clarification;
        showClarifying(state.event, state.clarification && state.clarification.originalText);
        if (!keepTyped) input.value = state.input || "";
        if (state.statusText) showStatus(state.statusText, !!state.statusError);
      } else if (state.mode === "failed") {
        draftEvent = state.draftEvent || state.event;
        showFailed(state.statusText || "QuickCalAI could not save this event.", false);
        if (!keepTyped) input.value = state.input || "";
      } else if (state.mode === "creating" && state.event) {
        showCreating(state.event);
        if (!keepTyped) input.value = state.input || "";
      } else if (state.mode === "saved" && state.savedRecord) {
        showSaved(state.savedRecord);
        if (state.event && state.event.needsClarification) showEditQuestion(state.event);
        if (!keepTyped) input.value = state.input || "";
        if (state.statusText) showSaveError(state.statusText);
      } else {
        showInputMode();
        if (!keepTyped) input.value = state.input || "";
        if (state.statusText) showStatus(state.statusText, !!state.statusError);
      }
      if (!keepTyped) inputDirty = false;
      render();
    } finally {
      applyingRemote = false;
      allowFocus = false;
      const pending = queuedRemote;
      queuedRemote = null;
      if (pending && pending.revision !== state.revision) applyRemote(pending, false);
      else if (inputDirty && shadow.activeElement === input) publishInput();
    }
  }

  async function hydrateShared() {
    if (!shared) return;
    let result = null;
    try {
      result = await chrome.runtime.sendMessage({ type: "quickcal-widget", action: "snapshot" });
    } catch (error) {
      console.info("QuickCalAI: could not read the shared session. " + (error && error.message ? error.message : "The shared session did not respond."));
      return;
    }
    if (!alive) return;
    if (!result || !result.session) {
      console.info("QuickCalAI: the shared session did not respond, so this page will not start a separate conversation.");
      return;
    }
    applyRemote(result.session, false);
    if (!open) return;
    prepareOpenTab();
  }

  function submitShared(text, fresh) {
    const operationId = typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : "op-" + Date.now();
    pending = true;
    showStatus(mode === "saved" ? "Updating event\u2026" : "Reading your event\u2026", false);
    render();
    chrome.runtime.sendMessage({
      type: "quickcal-widget",
      action: "submit",
      text: text,
      fresh: !!fresh,
      sessionId: sharedSessionId,
      operationId: operationId,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    }).then((result) => {
      pending = false;
      if (!alive) return;
      if (result && result.ignored) {
        clearStatus();
        render();
        return;
      }
      if (result && result.session) applyRemote(result.session, true);
      else {
        showStatus(result && result.error ? result.error : "QuickCalAI could not read that event.", true);
        render();
      }
    }).catch(() => {
      pending = false;
      if (!alive) return;
      showStatus("QuickCalAI could not reach QuickCal. Try again.", true);
      render();
    });
  }

  function onPointerDown(event) {
    if (event.button != null && event.button !== 0) return;
    const corner = event.currentTarget && event.currentTarget.dataset ? event.currentTarget.dataset.corner : "";
    const rect = host.getBoundingClientRect();
    if (corner) {
      dragging = {
        kind: "resize",
        corner: corner,
        pointerId: event.pointerId,
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        scale: widgetScale || 1,
      };
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch (error) {
        // A synthetic pointer can still resize without capture.
      }
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (event.target.closest && event.target.closest("button, input, a, textarea")) return;
    dragging = {
      kind: "move",
      pointerId: event.pointerId,
      dx: event.clientX - rect.left,
      dy: event.clientY - rect.top,
    };
    try {
      dragHandle.setPointerCapture(event.pointerId);
    } catch (error) {
      // A synthetic pointer can still move the panel without capture.
    }
    event.preventDefault();
  }

  function onPointerMove(event) {
    if (!dragging || event.pointerId !== dragging.pointerId) return;
    const api = globalThis.QuickCalLayout;
    if (!api) return;
    if (dragging.kind === "move") {
      const rect = host.getBoundingClientRect();
      const next = api.clampPosition(event.clientX - dragging.dx, event.clientY - dragging.dy, rect.width, rect.height, viewportSize());
      widgetLeft = next.left;
      widgetTop = next.top;
      allowFocus = false;
      render();
      return;
    }
    const scaled = api.scaleFromCorner(dragging, { x: event.clientX, y: event.clientY }, dragging.corner, viewportSize());
    widgetScale = scaled.scale;
    widgetLeft = scaled.left;
    widgetTop = scaled.top;
    allowFocus = false;
    render();
  }

  function onPointerUp(event) {
    if (!dragging || event.pointerId !== dragging.pointerId) return;
    dragging = null;
    publishLayout();
  }

  function onResizeKey(event) {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown" && event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const api = globalThis.QuickCalLayout;
    if (!api) return;
    event.preventDefault();
    const delta = event.key === "ArrowUp" || event.key === "ArrowRight" ? 0.08 : -0.08;
    const rect = host.getBoundingClientRect();
    const baseWidth = rect.width / (widgetScale || 1);
    const baseHeight = Math.max(1, rect.height / (widgetScale || 1));
    widgetScale = api.clampScale((widgetScale || 1) + delta, baseWidth, baseHeight, viewportSize());
    const origin = api.defaultOrigin(baseWidth * widgetScale, baseHeight * widgetScale, viewportSize());
    if (widgetLeft == null || widgetTop == null) {
      widgetLeft = origin.left;
      widgetTop = origin.top;
    }
    allowFocus = false;
    render();
    publishLayout();
  }

  function onRuntimeMessage(message, sender, sendResponse) {
    if (message && message.type === "quickcal-widget") {
      if (message.action === "ping") {
        sendResponse({ ok: true, open: open });
        return false;
      }
      if (message.action === "toggle") {
        const opening = !open;
        Promise.resolve(setOpen(opening)).then((result) => {
          sendResponse({ ok: !!(result && result.session) || !shared, session: result && result.session });
        });
        return true;
      }
      if (message.action === "focus") {
        allowFocus = true;
        if (open) focusInput();
        allowFocus = false;
        sendResponse({ ok: true });
        return false;
      }
      if (message.action === "render" && message.session) {
        applyRemote(message.session, false);
        sendResponse({ ok: true });
        return false;
      }
      if (message.session) applyRemote(message.session, false);
      sendResponse({ ok: true });
      return false;
    }
    if (message && message.type === "quickcal-selection") {
      try {
        sendResponse(acceptSelection(message));
      } catch (error) {
        sendResponse({ ok: true, ignored: true });
      }
      return false;
    }
    onVoiceMessage(message);
  }

  function onInputKeyDown(event) {
    if (event.key !== "Enter") return;
    if (event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    event.stopPropagation();
    if (pending || saving || voicePhase === "recording" || voicePhase === "review" || voicePhase === "transcribing" || voicePhase === "permission") return;
    if (voicePhase === "held") cancelVoice();
    const text = input.value.trim();
    if (!text) return;
    submit(text);
  }

  function formatElapsed(ms) {
    const total = Math.min(60, Math.max(0, Math.floor(ms / 1000)));
    const seconds = total % 60;
    return Math.floor(total / 60) + ":" + String(seconds).padStart(2, "0");
  }

  function stopVoiceTimer() {
    if (voiceTimer) clearInterval(voiceTimer);
    voiceTimer = 0;
  }

  function paintVoice() {
    const active = voicePhase === "recording" || voicePhase === "review" || voicePhase === "permission" || voicePhase === "transcribing";
    listening.hidden = !active;
    input.hidden = active;
    discardButton.hidden = voicePhase !== "review";
    bar.classList.toggle("recording", voicePhase === "recording");
    bar.classList.toggle("review", voicePhase === "review");
    micIcon.hidden = voicePhase !== "idle" && voicePhase !== "held";
    micMark.hidden = voicePhase === "idle" || voicePhase === "held";
    micButton.disabled = pending || saving || voicePhase === "transcribing" || voicePhase === "permission";
    if (voicePhase === "recording") {
      listeningLabel.textContent = "Listening";
      micMark.textContent = "Stop";
      micButton.setAttribute("aria-label", "Stop and submit recording");
      micButton.title = "Stop and submit recording";
    } else if (voicePhase === "review") {
      listeningLabel.textContent = "Recording stopped";
      micMark.textContent = "Submit";
      micButton.setAttribute("aria-label", "Submit recording");
      micButton.title = "Submit recording";
    } else if (voicePhase === "transcribing") {
      listeningLabel.textContent = "Transcribing";
      elapsed.textContent = "";
      micButton.setAttribute("aria-label", "Transcribing");
    } else if (voicePhase === "permission") {
      listeningLabel.textContent = "Allow microphone";
      elapsed.textContent = "";
      micButton.setAttribute("aria-label", "Waiting for microphone access");
    } else if (voicePhase === "held") {
      micButton.setAttribute("aria-label", "Try transcription again");
      micButton.title = "Try transcription again";
    } else {
      micButton.setAttribute("aria-label", "Start voice input");
      micButton.title = "Start voice input";
    }
  }

  function restoreTypedDraft() {
    input.value = typedDraft;
  }

  function resetVoiceUi(restore) {
    stopVoiceTimer();
    voicePhase = "idle";
    voiceSession = 0;
    if (restore) restoreTypedDraft();
    paintVoice();
  }

  async function sendVoice(action) {
    return chrome.runtime.sendMessage({
      type: "quickcal-voice",
      action: action,
      sessionId: voiceSession,
    });
  }

  function cancelVoice() {
    if (voicePhase === "idle") return;
    const sessionId = voiceSession;
    voiceGeneration += 1;
    resetVoiceUi(true);
    chrome.runtime.sendMessage({ type: "quickcal-voice", action: "cancel", sessionId: sessionId }).catch(() => {});
  }

  function startVoiceClock(keepStart) {
    stopVoiceTimer();
    if (!keepStart) voiceStartedAt = Date.now();
    elapsed.textContent = "0:00";
    voiceTimer = setInterval(() => {
      if (voicePhase !== "recording") return;
      elapsed.textContent = formatElapsed(Date.now() - voiceStartedAt);
    }, 200);
  }

  async function startVoice() {
    if (pending || saving || voicePhase !== "idle") return;
    dismissSelectionChoice();
    if (connection && connection.connected === false) {
      showStatus("Connect Google Calendar to use QuickCalAI.", true);
      connectRoute.hidden = false;
      return;
    }
    typedDraft = input.value;
    voiceGeneration += 1;
    const generation = voiceGeneration;
    micButton.disabled = true;
    let result;
    try {
      result = await sendVoice("start");
    } catch (error) {
      result = { ok: false, error: "QuickCalAI could not reach the microphone." };
    }
    if (!alive || generation !== voiceGeneration) return;
    if (!result || result.ignored) return;
    if (!result.ok) {
      resetVoiceUi(true);
      showStatus(result.error || "QuickCalAI could not reach the microphone.", true);
      return;
    }
    voiceSession = result.sessionId || 0;
    voicePhase = result.phase || "recording";
    paintVoice();
    if (voicePhase === "recording") startVoiceClock();
    else if (voicePhase === "permission") {
      showStatus("Allow the microphone in the QuickCalAI tab.", false);
    }
  }

  async function submitRecording() {
    if (voicePhase !== "recording" && voicePhase !== "review" && voicePhase !== "held") return;
    const generation = voiceGeneration + 1;
    voiceGeneration = generation;
    const sessionId = voiceSession;
    const action = voicePhase === "held" ? "retry" : "stop";
    voicePhase = "transcribing";
    stopVoiceTimer();
    paintVoice();
    showStatus("Transcribing\u2026", false);
    let result;
    try {
      result = await sendVoice(action);
    } catch (error) {
      result = { ok: false, error: "QuickCalAI could not reach QuickCal. Try again.", phase: "held" };
    }
    if (!alive || generation !== voiceGeneration || sessionId !== voiceSession) return;
    if (!result || result.ignored) return;
    if (result.ok && typeof result.text === "string" && result.text.trim()) {
      const text = result.text.trim();
      resetVoiceUi(false);
      input.value = text;
      clearStatus();
      await submit(text);
      return;
    }
    voicePhase = result && result.phase === "held" ? "held" : "idle";
    voiceSession = voicePhase === "held" ? sessionId : 0;
    restoreTypedDraft();
    paintVoice();
    showStatus(result && result.error ? result.error : "QuickCalAI could not transcribe that recording.", true);
    if (result && result.state === "disconnected") connectRoute.hidden = false;
  }

  function onVoiceMessage(message) {
    if (!message || message.type !== "quickcal-voice") return;
    if (message.sessionId && voiceSession && message.sessionId !== voiceSession) return;
    if (!alive || !open) return;
    if (message.cancelled || (message.phase === "idle" && message.ok === true && !message.text)) {
      if (voicePhase === "idle") return;
      resetVoiceUi(true);
      return;
    }
    if (message.phase === "recording") {
      voiceSession = message.sessionId || voiceSession;
      voicePhase = "recording";
      if (message.startedAt) voiceStartedAt = message.startedAt;
      clearStatus();
      paintVoice();
      startVoiceClock(!!message.startedAt);
      return;
    }
    if (message.phase === "review") {
      voicePhase = "review";
      stopVoiceTimer();
      elapsed.textContent = "1:00";
      paintVoice();
      showStatus("Recording reached 1 minute. Submit it or discard it.", false);
      return;
    }
    if (message.ok === false && message.error) {
      const retain = message.phase === "held";
      voicePhase = retain ? "held" : "idle";
      if (!retain) voiceSession = 0;
      restoreTypedDraft();
      paintVoice();
      showStatus(message.error, true);
    }
  }

  function onVisible() {
    if (!alive || !open) return;
    if (document.visibilityState === "visible") {
      checkConnection();
      if (shared) {
        claimLeader().then(() => {
          if (inputDirty) publishInput(0);
        });
      }
    }
  }

  function destroy() {
    if (!alive) return;
    alive = false;
    requestGeneration += 1;
    saveGeneration += 1;
    document.removeEventListener("keydown", onEscape, true);
    document.removeEventListener("visibilitychange", onVisible);
    chrome.runtime.onMessage.removeListener(onRuntimeMessage);
    if (!shared && voicePhase !== "idle") {
      chrome.runtime.sendMessage({ type: "quickcal-voice", action: "cancel", sessionId: voiceSession }).catch(() => {});
      stopVoiceTimer();
    }
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
    discardClarification();
  });
  cancelButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    discardClarification();
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
  micButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (voicePhase === "recording" || voicePhase === "review" || voicePhase === "held") submitRecording();
    else if (voicePhase === "idle") startVoice();
  });
  discardButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    cancelVoice();
    clearStatus();
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
  useSelection.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const text = pendingSelection;
    if (!text || selectionBusy()) return;
    beginNewEvent(text);
  });
  keepDraft.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    dismissSelectionChoice();
    if (status.textContent === "Replace your current text with the selection?") clearStatus();
  });
  input.addEventListener("keydown", onInputKeyDown);
  input.addEventListener("input", () => {
    if (!selectionChoice.hidden) {
      dismissSelectionChoice();
      if (status.className === "status") clearStatus();
    }
    if (pending && mode !== "saved") {
      requestGeneration += 1;
      pending = false;
      clearStatus();
    }
    if (!status.hidden && status.className.indexOf("error") !== -1) clearStatus();
    inputDirty = true;
    publishInput();
  });
  input.addEventListener("focus", claimLeader);
  window.addEventListener("focus", claimLeader);
  dragHandle.addEventListener("pointerdown", onPointerDown);
  [resizeNw, resizeNe, resizeSw, resizeSe].forEach((button) => {
    button.addEventListener("pointerdown", onPointerDown);
    button.addEventListener("keydown", onResizeKey);
  });
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("resize", () => {
    const api = globalThis.QuickCalLayout;
    if (!api || !styled) return;
    const rect = host.getBoundingClientRect();
    const baseWidth = rect.width / (widgetScale || 1);
    const baseHeight = Math.max(1, rect.height / (widgetScale || 1));
    widgetScale = api.clampScale(widgetScale || 1, baseWidth, baseHeight, viewportSize());
    const width = baseWidth * widgetScale;
    const height = baseHeight * widgetScale;
    const origin = widgetLeft == null || widgetTop == null
      ? api.defaultOrigin(width, height, viewportSize())
      : api.clampPosition(widgetLeft, widgetTop, width, height, viewportSize());
    widgetLeft = origin.left;
    widgetTop = origin.top;
    allowFocus = false;
    render();
    if (document.visibilityState === "visible") publishLayout();
  });
  if (shared && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "session") return;
      const change = changes[sessionStorageKey()];
      if (!change || !change.newValue) return;
      if (applyingRemote) {
        queuedRemote = change.newValue;
        return;
      }
      applyRemote(change.newValue, false);
    });
  }

  async function restoreActive() {
    let result;
    try {
      result = await chrome.runtime.sendMessage({ type: "quickcal-calendar", action: "active" });
    } catch (error) {
      return;
    }
    if (!alive || !open || mode !== "input" || input.value.trim() || pending || saving || selectionHold) return;
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
    if ((needsAccount || needsApproval) && session.phase() !== "waking" && !selectionHold) {
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
        if (result && result.incompatible) {
          session.noteClosed();
          showStatus(result.error || "QuickCalAI's hosted parser is out of date. Deploy the current backend, then reload the extension.", true);
          healthRetry.hidden = true;
          return;
        }
        const step = session.healthResult(!!(result && result.ok), Date.now());
        if (step.status) {
          if (!selectionHold) showStatus(step.status, !!step.retry);
        } else if (!selectionHold && (!connection || connection.connected !== false)) clearStatus();
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
    if (shared) {
      hydrateShared();
      return;
    }
    restoreActive();
    const step = session.begin(Date.now());
    if (step.status && !selectionHold) showStatus(step.status, false);
    pumpHealth();
    checkConnection();
  });

  stylesheet.addEventListener("error", () => {
    console.info("QuickCalAI: the input bar styles failed to load.");
    destroy();
  });

  document.addEventListener("keydown", onEscape, true);
  document.addEventListener("visibilitychange", onVisible);
  chrome.runtime.onMessage.addListener(onRuntimeMessage);
  paintVoice();
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
