(() => {
  const HOST_ID = "quickcal-ai-host";
  const STATE_KEY = "__quickcalAi";
  const previewApi = globalThis.QuickCalPreview;
  const INPUT_PLACEHOLDER = "Coffee with Alex tomorrow at 10 AM";
  const DOC_PLACEHOLDER = "What should I find? e.g. only exams";
  const FOLLOW_PLACEHOLDER = "Tell me what to change\u2026";
  const TASKS_SCOPE_TEXT = /QuickCalAI can create Google Tasks/i;

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

  // Use our bundled font under a private name, independent of a site's webfonts.
  const fontReady = (async () => {
    try {
      const existingFont = Array.from(document.fonts).find((font) => font.family === "QuickCalAIInter");
      if (existingFont) return await existingFont.load();
      // Fetch through the content script and use font bytes directly. This avoids
      // making the page load a font URL under its own font-src policy.
      const response = await fetch(chrome.runtime.getURL("assets/fonts/InterVariable.woff2"));
      if (!response.ok) throw new Error("Font resource unavailable");
      const font = new FontFace("QuickCalAIInter", await response.arrayBuffer(),
        { style: "normal", weight: "100 900", display: "swap" });
      document.fonts.add(font);
      return await font.load();
    } catch (error) {
      console.info("QuickCalAI: bundled font unavailable; using the widget fallback.");
      return null;
    }
  })();

  const shell = document.createElement("div");
  shell.className = "shell";

  function resizeControl(corner) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "resize resize-" + corner;
    button.dataset.corner = corner;
    button.setAttribute("aria-label", "Resize QuickCalAI");
    button.title = "Resize QuickCalAI";
    if (corner === "nw" || corner === "se") {
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

  // Layer short strokes into a violet-to-cyan tail. Normalized path lengths
  // keep the orbit smooth around the corners at every widget size.
  const orbit = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  orbit.setAttribute("class", "border-orbit");
  orbit.setAttribute("aria-hidden", "true");
  orbit.setAttribute("focusable", "false");
  for (let step = 0; step < 24; step += 1) {
    const progress = step / 23;
    const length = 24 - progress * 23;
    const stroke = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    stroke.setAttribute("x", "1");
    stroke.setAttribute("y", "1");
    stroke.setAttribute("pathLength", "100");
    stroke.setAttribute("stroke-dasharray", length + " " + (100 - length));
    stroke.style.setProperty("--orbit-offset", String(-(24 - length)) + "px");
    stroke.style.stroke = "hsl(" + (270 - progress * 80) + " 90% " + (65 - 17 * progress * progress) + "%)";
    stroke.style.strokeWidth = (0.6 + 2.2 * Math.pow(progress, 1.3)) + "px";
    stroke.style.opacity = String(0.08 + progress * 0.85);
    orbit.appendChild(stroke);
  }

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

  // The saved event's time becomes a button only after the event exists.
  const timeEdit = document.createElement("button");
  timeEdit.type = "button";
  timeEdit.className = "time-edit";
  timeEdit.hidden = true;
  timeEdit.setAttribute("aria-haspopup", "dialog");
  timeEdit.setAttribute("aria-expanded", "false");
  const timeEditText = document.createElement("span");
  const timeEditMark = document.createElement("img");
  timeEditMark.className = "time-edit-mark";
  timeEditMark.src = chrome.runtime.getURL("assets/chevron.svg");
  timeEditMark.alt = "";
  timeEditMark.width = 12;
  timeEditMark.height = 12;
  timeEditMark.draggable = false;
  timeEdit.append(timeEditText, timeEditMark);
  timeDetail.wrap.appendChild(timeEdit);

  const timeMenu = document.createElement("div");
  timeMenu.className = "time-menu";
  timeMenu.hidden = true;
  timeMenu.setAttribute("role", "dialog");
  timeMenu.setAttribute("aria-label", "Change time");
  let timeMenuState = null;

  const people = document.createElement("div");
  people.className = "people";
  people.hidden = true;
  const addPeople = document.createElement("button");
  addPeople.type = "button";
  addPeople.className = "add-people";
  addPeople.setAttribute("aria-expanded", "false");
  const personIcon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  personIcon.setAttribute("viewBox", "0 0 24 24");
  personIcon.setAttribute("width", "12");
  personIcon.setAttribute("height", "12");
  personIcon.setAttribute("aria-hidden", "true");
  const personPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
  personPath.setAttribute("d", "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M20 8v6m-3-3h6M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z");
  personPath.setAttribute("fill", "none");
  personPath.setAttribute("stroke", "currentColor");
  personPath.setAttribute("stroke-width", "2.5");
  personPath.setAttribute("stroke-linecap", "round");
  personIcon.appendChild(personPath);
  const personChip = document.createElement("span");
  personChip.className = "chip";
  personChip.appendChild(personIcon);
  addPeople.append(personChip, document.createTextNode("Add People"));
  const inviteForm = document.createElement("form");
  inviteForm.id = "quickcal-invite-form";
  inviteForm.className = "invite-form";
  inviteForm.hidden = true;
  addPeople.setAttribute("aria-controls", inviteForm.id);
  const guestEmail = document.createElement("input");
  guestEmail.type = "email";
  guestEmail.multiple = true;
  guestEmail.className = "guest-email";
  guestEmail.placeholder = "name@gmail.com";
  guestEmail.setAttribute("aria-label", "Guest email addresses");
  guestEmail.setAttribute("aria-describedby", "quickcal-invite-help");
  guestEmail.required = true;
  guestEmail.autocomplete = "email";
  const sendInvite = document.createElement("button");
  sendInvite.type = "submit";
  sendInvite.className = "send-invite";
  sendInvite.textContent = "Send";
  const inviteHelp = document.createElement("p");
  inviteHelp.id = "quickcal-invite-help";
  inviteHelp.className = "invite-help";
  inviteHelp.textContent = "Seperate emails using commas.";
  inviteForm.append(guestEmail, sendInvite, inviteHelp);
  const inviteStatus = document.createElement("p");
  inviteStatus.className = "invite-status";
  inviteStatus.hidden = true;
  inviteStatus.setAttribute("role", "status");
  const inviteScope = document.createElement("p");
  inviteScope.className = "invite-scope";
  inviteScope.textContent = "Guests will be invited to the entire series.";
  inviteScope.hidden = true;
  people.append(addPeople, inviteScope, inviteForm, inviteStatus);

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
  viewLink.textContent = "Edit in Google Calendar";
  viewLink.target = "_blank";
  viewLink.rel = "noopener noreferrer";
  viewLink.hidden = true;

  function presentTasksLink(htmlLink) {
    const link = previewApi && previewApi.tasksLink ? previewApi.tasksLink(htmlLink) : "";
    viewLink.textContent = "View in Google Tasks";
    if (link) viewLink.href = link;
    else viewLink.removeAttribute("href");
    viewLink.hidden = !link;
  }

  function savedLink(result) {
    if (!result) return "";
    if (result.kind === "task") return previewApi && previewApi.tasksLink ? previewApi.tasksLink(result.htmlLink) : "";
    return safeCalendarLink(result.htmlLink);
  }

  function presentCalendarLink(htmlLink) {
    const edit = previewApi && previewApi.calendarEditLink ? previewApi.calendarEditLink(htmlLink) : "";
    if (edit) {
      viewLink.href = edit;
      viewLink.textContent = "Edit in Google Calendar";
      viewLink.hidden = false;
      return;
    }
    const details = previewApi && previewApi.calendarViewLink ? previewApi.calendarViewLink(htmlLink) : safeCalendarLink(htmlLink);
    if (details) {
      viewLink.href = details;
      viewLink.textContent = "View in Google Calendar";
      viewLink.hidden = false;
      return;
    }
    viewLink.removeAttribute("href");
    viewLink.hidden = true;
  }

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

  const deleteButton = document.createElement("button");
  deleteButton.type = "button";
  deleteButton.className = "action";
  deleteButton.textContent = "Delete event";
  deleteButton.hidden = true;

  const addSelectedButton = document.createElement("button");
  addSelectedButton.type = "button";
  addSelectedButton.className = "action";
  addSelectedButton.textContent = "Add selected events";
  addSelectedButton.hidden = true;

  const batchList = document.createElement("div");
  batchList.className = "batch-list";
  batchList.hidden = true;
  batchList.setAttribute("role", "list");

  actions.append(retryButton, connectButton, viewLink, newButton, deleteButton, addSelectedButton, cancelButton);
  body.append(creatingLine, successRow, summary, people, zoneLine, recurrenceLine, seriesLine, locationLine, remindersLine, noteLine, questionList, batchList, saveError, rule, actions);

  function svgIcon(size, paths, viewBox) {
    const mark = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    mark.setAttribute("viewBox", viewBox || "0 0 16 16");
    mark.setAttribute("width", String(size));
    mark.setAttribute("height", String(size));
    mark.setAttribute("aria-hidden", "true");
    paths.forEach((d) => {
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", d);
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", "currentColor");
      path.setAttribute("stroke-width", "1.5");
      path.setAttribute("stroke-linecap", "round");
      path.setAttribute("stroke-linejoin", "round");
      mark.appendChild(path);
    });
    return mark;
  }

  const attachButton = document.createElement("button");
  attachButton.type = "button";
  attachButton.className = "attach";
  attachButton.setAttribute("aria-label", "Upload a document");
  attachButton.setAttribute("aria-expanded", "false");
  attachButton.title = "Upload a document";
  attachButton.appendChild(svgIcon(16, ["M13.5 7.6 8.3 12.8a3.3 3.3 0 0 1-4.7-4.7l5.6-5.6a2.2 2.2 0 0 1 3.1 3.1L6.7 11.2a1.1 1.1 0 0 1-1.6-1.6l5-5"]));
  bar.append(attachButton, input, listening, dismissButton, micButton, orbit);

  // Document panel. It unfolds from behind the bar and never moves the bar.
  const docs = document.createElement("section");
  docs.className = "docs";
  docs.hidden = true;
  docs.dataset.dir = "down";
  docs.dataset.state = "closed";
  docs.setAttribute("aria-label", "Document upload");
  const docsSheet = document.createElement("div");
  docsSheet.className = "docs-sheet";
  const docsSpacer = document.createElement("div");
  docsSpacer.className = "docs-spacer";
  const docsBody = document.createElement("div");
  docsBody.className = "docs-body";
  docsSheet.append(docsSpacer, docsBody);
  docs.appendChild(docsSheet);

  const docsInput = document.createElement("input");
  docsInput.type = "file";
  docsInput.className = "docs-input";
  docsInput.accept = ".pdf,.docx,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain";
  docsInput.tabIndex = -1;
  docsInput.hidden = true;

  const docsDrop = document.createElement("div");
  docsDrop.className = "docs-drop";
  const docsDropIcon = svgIcon(20, ["M9.5 1.75H4.25a1.5 1.5 0 0 0-1.5 1.5v9.5a1.5 1.5 0 0 0 1.5 1.5h7.5a1.5 1.5 0 0 0 1.5-1.5V5.5L9.5 1.75Z", "M9.5 1.75V5.5h3.75", "M8 11.25v-4M6.25 8.75 8 7l1.75 1.75"]);
  docsDropIcon.classList.add("docs-drop-icon");
  const docsDropTitle = document.createElement("p");
  docsDropTitle.className = "docs-drop-title";
  docsDropTitle.textContent = "Drag and drop a file here";
  const docsDropHint = document.createElement("p");
  docsDropHint.className = "docs-drop-hint";
  docsDropHint.textContent = "PDF, DOCX, or TXT \u00b7 up to 2 MB";
  const docsBrowse = document.createElement("button");
  docsBrowse.type = "button";
  docsBrowse.className = "docs-browse";
  docsBrowse.textContent = "Browse Files";
  docsDrop.append(docsDropIcon, docsDropTitle, docsDropHint, docsBrowse);

  const docsFile = document.createElement("div");
  docsFile.className = "docs-file";
  docsFile.hidden = true;
  const docsFileIcon = document.createElement("span");
  docsFileIcon.className = "docs-file-icon";
  docsFileIcon.setAttribute("aria-hidden", "true");
  const docsFileText = document.createElement("div");
  docsFileText.className = "docs-file-text";
  const docsFileName = document.createElement("p");
  docsFileName.className = "docs-file-name";
  const docsFileMeta = document.createElement("p");
  docsFileMeta.className = "docs-file-meta";
  docsFileText.append(docsFileName, docsFileMeta);
  const docsRemove = document.createElement("button");
  docsRemove.type = "button";
  docsRemove.className = "docs-link docs-remove";
  docsRemove.textContent = "Remove";
  docsFile.append(docsFileIcon, docsFileText, docsRemove);

  const docsMessage = document.createElement("p");
  docsMessage.className = "docs-message";
  docsMessage.setAttribute("role", "status");
  docsMessage.hidden = true;

  const docsPrompt = document.createElement("div");
  docsPrompt.className = "docs-prompt";
  docsPrompt.hidden = true;
  const docsPromptText = document.createElement("p");
  docsPromptText.textContent = "Type what to find in the box above and press Enter, or analyze the whole document.";
  const docsAnalyze = document.createElement("button");
  docsAnalyze.type = "button";
  docsAnalyze.className = "docs-action";
  docsAnalyze.textContent = "Analyze Document";
  docsPrompt.append(docsPromptText, docsAnalyze);

  const docsFilter = document.createElement("p");
  docsFilter.className = "docs-filter";
  docsFilter.hidden = true;

  const docsList = document.createElement("ul");
  docsList.className = "docs-items";
  docsList.hidden = true;

  const docsFooter = document.createElement("div");
  docsFooter.className = "docs-footer";
  docsFooter.hidden = true;
  const docsCreate = document.createElement("button");
  docsCreate.type = "button";
  docsCreate.className = "docs-create";
  const docsTally = document.createElement("p");
  docsTally.className = "docs-tally";
  docsFooter.append(docsCreate, docsTally);

  const docsStatusSlot = document.createElement("div");
  docsStatusSlot.className = "docs-status";

  docsBody.append(docsInput, docsDrop, docsFile, docsMessage, docsPrompt, docsFilter, docsList, docsStatusSlot, docsFooter);
  card.append(bar, body);
  card.setAttribute("aria-labelledby", "quickcal-event-title");

  const onboarding = document.createElement("section");
  onboarding.className = "onboarding";
  onboarding.hidden = true;
  onboarding.setAttribute("aria-label", "QuickCalAI welcome tour");
  const onboardingTitle = document.createElement("h2");
  onboardingTitle.className = "onboarding-title";
  const onboardingProgress = document.createElement("p");
  onboardingProgress.className = "onboarding-progress";
  onboardingProgress.hidden = true;
  const onboardingCopy = document.createElement("p");
  onboardingCopy.className = "onboarding-copy";
  const onboardingCapabilities = document.createElement("div");
  onboardingCapabilities.className = "onboarding-capabilities";
  onboardingCapabilities.hidden = true;
  const onboardingStage = document.createElement("div");
  onboardingStage.className = "onboarding-stage";
  onboardingStage.hidden = true;
  onboardingStage.setAttribute("aria-hidden", "true");
  const onboardingSr = document.createElement("p");
  onboardingSr.className = "onboarding-sr";
  onboardingSr.setAttribute("aria-live", "polite");
  const onboardingDetail = document.createElement("p");
  onboardingDetail.className = "onboarding-detail";
  onboardingDetail.hidden = true;
  onboardingDetail.setAttribute("role", "status");
  const onboardingActions = document.createElement("div");
  onboardingActions.className = "onboarding-actions";
  const onboardingBack = document.createElement("button");
  onboardingBack.type = "button";
  onboardingBack.className = "onboarding-secondary";
  onboardingBack.textContent = "Back";
  const onboardingReplay = document.createElement("button");
  onboardingReplay.type = "button";
  onboardingReplay.className = "onboarding-secondary onboarding-replay";
  onboardingReplay.textContent = "Replay";
  onboardingReplay.hidden = true;
  onboardingReplay.setAttribute("aria-label", "Replay this example");
  const onboardingSkip = document.createElement("button");
  onboardingSkip.type = "button";
  onboardingSkip.className = "onboarding-secondary onboarding-skip";
  onboardingSkip.textContent = "Skip tour";
  onboardingSkip.setAttribute("aria-label", "Skip welcome tour");
  const onboardingPrimary = document.createElement("button");
  onboardingPrimary.type = "button";
  onboardingPrimary.className = "onboarding-primary";
  onboardingPrimary.textContent = "See how it works";
  onboardingActions.append(onboardingBack, onboardingReplay, onboardingSkip, onboardingPrimary);
  onboarding.append(
    onboardingTitle,
    onboardingProgress,
    onboardingCopy,
    onboardingCapabilities,
    onboardingStage,
    onboardingSr,
    onboardingDetail,
    onboardingActions
  );

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
  panel.append(resizeNw, resizeNe, resizeSw, resizeSe, card, docs, onboarding);
  shell.append(panel, status, selectionChoice, connectRoute, healthRetry, timeMenu);

  const stylesheet = document.createElement("link");
  stylesheet.rel = "stylesheet";
  stylesheet.href = chrome.runtime.getURL("content/widget.css");
  shadow.append(stylesheet, shell);

  const shared = !!(chrome.storage && chrome.storage.session);
  // Document review lives in the shared session, so it needs session storage.
  attachButton.hidden = !shared;
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
  let suppressBarClick = false;
  let styled = false;
  let alive = true;
  let pending = false;
  let saving = false;
  let requestGeneration = 0;
  let saveGeneration = 0;
  let mode = "input";
  let onboardingState = null;
  let onboardingBusy = false;
  let onboardingDemoKey = "";
  let onboardingDemoRun = null;
  let onboardingDemoPaused = false;
  let draftEvent = null;
  let draftText = "";
  let savedRecord = null;
  let inviteEventId = "";
  let inviteSending = false;
  let inviteGeneration = 0;

  function resetInvitations() {
    inviteGeneration += 1;
    inviteSending = false;
    inviteEventId = "";
    people.hidden = true;
    inviteForm.hidden = true;
    addPeople.setAttribute("aria-expanded", "false");
    guestEmail.value = "";
    guestEmail.disabled = false;
    sendInvite.disabled = false;
    sendInvite.textContent = "Send";
    inviteStatus.hidden = true;
    inviteStatus.textContent = "";
  }

  function showInviteStatus(message, error) {
    inviteStatus.textContent = message;
    inviteStatus.className = "invite-status" + (error ? " error" : "");
    inviteStatus.hidden = !message;
  }
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
  let enterDown = false;
  let deleteArmed = false;
  let activeLookup = null;
  let activeBatch = null;
  let suppressBatchConfirm = false;
  let pendingBatchSelection = false;
  const seenSelections = new Set();
  let docState = null;
  let docLocalError = "";
  let docEditing = null;
  let docAnimTimer = 0;
  let docUploading = null;
  const docRows = new Map();

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
    zoneLine.textContent = "";
    zoneLine.hidden = true;
    recurrenceLine.textContent = view.recurrenceText || "";
    recurrenceLine.hidden = !view.recurrenceText;
    seriesLine.textContent = view.seriesEndText || "";
    seriesLine.hidden = !view.seriesEndText;
    locationLine.textContent = view.location || "";
    locationLine.hidden = !view.location;
    remindersLine.textContent = view.remindersText || "";
    remindersLine.hidden = !view.remindersText;
    noteLine.textContent = view.changeText || (view.durationDefaulted ? "1-hour default" : "");
    noteLine.hidden = !noteLine.textContent;
    syncTimeEdit();
  }

  function retimeable() {
    return !!(
      globalThis.QuickCalTimes &&
      mode === "saved" &&
      savedRecord &&
      savedRecord.kind !== "task" &&
      savedRecord.id &&
      savedRecord.startTime &&
      savedRecord.endTime
    );
  }

  function syncTimeEdit() {
    const editable = retimeable() && !timeDetail.wrap.hidden;
    timeEdit.hidden = !editable;
    timeDetail.text.hidden = editable;
    timeEditText.textContent = timeDetail.text.textContent;
    timeEdit.setAttribute("aria-label", "Change time, currently " + timeDetail.text.textContent);
    if (!editable && timeMenuState && timeMenuState.trigger === timeEdit) closeTimeMenu(false);
  }

  function closeTimeMenu(restoreFocus) {
    if (!timeMenuState) return;
    const trigger = timeMenuState.trigger;
    timeMenuState = null;
    timeMenu.hidden = true;
    clearList(timeMenu);
    trigger.setAttribute("aria-expanded", "false");
    if (restoreFocus && trigger.isConnected && !trigger.hidden) trigger.focus();
  }

  function placeTimeMenu(trigger) {
    const scale = widgetScale > 0 ? widgetScale : 1;
    const shellRect = shell.getBoundingClientRect();
    const rect = trigger.getBoundingClientRect();
    const width = timeMenu.offsetWidth;
    const height = timeMenu.offsetHeight;
    const naturalWidth = shell.offsetWidth || 456;
    const left = Math.max(8, Math.min((rect.left - shellRect.left) / scale - 6, naturalWidth - width - 8));
    const below = window.innerHeight - rect.bottom;
    const above = rect.top;
    const up = below < height * scale + 8 && above > below;
    const top = up
      ? (rect.top - shellRect.top) / scale - height - 6
      : (rect.bottom - shellRect.top) / scale + 6;
    timeMenu.style.left = Math.round(left) + "px";
    timeMenu.style.top = Math.round(top) + "px";
  }

  function onTimeOptionKey(event) {
    const option = event.target;
    if (!option || !option.classList || !option.classList.contains("time-option")) return;
    const list = option.parentNode;
    let next = null;
    if (event.key === "ArrowDown") next = option.nextElementSibling;
    else if (event.key === "ArrowUp") next = option.previousElementSibling;
    else if (event.key === "Home") next = list.firstElementChild;
    else if (event.key === "End") next = list.lastElementChild;
    else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      const lists = Array.from(timeMenu.querySelectorAll(".time-list"));
      const other = lists[lists.indexOf(list) + (event.key === "ArrowRight" ? 1 : -1)];
      if (other) next = other.querySelector('[aria-selected="true"]') || other.firstElementChild;
    } else if (event.key === "Tab") {
      const lists = Array.from(timeMenu.querySelectorAll(".time-list"));
      const index = lists.indexOf(list) + (event.shiftKey ? -1 : 1);
      if (index < 0 || index >= lists.length) {
        event.preventDefault();
        closeTimeMenu(true);
      }
      return;
    }
    if (!next) return;
    event.preventDefault();
    Array.from(next.parentNode.children).forEach((item) => { item.tabIndex = item === next ? 0 : -1; });
    next.focus();
  }

  // columns: [{ key, label, value, after }]. The pick is reported once and the
  // menu closes; the caller decides what to save.
  function openTimeMenu(trigger, columns, onPick) {
    const timesApi = globalThis.QuickCalTimes;
    if (!timesApi) return;
    if (timeMenuState && timeMenuState.trigger === trigger) {
      closeTimeMenu(true);
      return;
    }
    closeTimeMenu(false);
    const lists = [];
    columns.forEach((column) => {
      const wrap = document.createElement("div");
      wrap.className = "time-col";
      if (columns.length > 1) {
        const heading = document.createElement("p");
        heading.className = "time-col-label";
        heading.textContent = column.label;
        wrap.appendChild(heading);
      }
      const list = document.createElement("div");
      list.className = "time-list";
      list.setAttribute("role", "listbox");
      list.setAttribute("aria-label", column.label + " time");
      const choices = timesApi.options(column.value, column.after);
      choices.forEach((choice, index) => {
        const option = document.createElement("button");
        option.type = "button";
        option.className = "time-option";
        option.setAttribute("role", "option");
        option.setAttribute("aria-selected", choice.selected ? "true" : "false");
        option.tabIndex = choice.selected || (index === 0 && !choices.some((item) => item.selected)) ? 0 : -1;
        option.textContent = choice.label;
        option.dataset.value = choice.value;
        option.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          closeTimeMenu(true);
          onPick(column.key, choice.value);
        });
        list.appendChild(option);
      });
      list.addEventListener("keydown", onTimeOptionKey);
      wrap.appendChild(list);
      timeMenu.appendChild(wrap);
      lists.push(list);
    });
    timeMenuState = { trigger: trigger };
    timeMenu.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    placeTimeMenu(trigger);
    lists.forEach((list) => {
      const near = columns[lists.indexOf(list)].near;
      const chosen = list.querySelector('[aria-selected="true"]') || (near ? list.querySelector('[data-value="' + near + '"]') : null);
      if (chosen && chosen.getAttribute("aria-selected") !== "true") {
        Array.from(list.children).forEach((item) => { item.tabIndex = item === chosen ? 0 : -1; });
      }
      if (chosen) list.scrollTop = Math.max(0, chosen.offsetTop - (list.clientHeight - chosen.offsetHeight) / 2);
    });
    const first = lists[0] && (lists[0].querySelector('[tabindex="0"]') || lists[0].firstElementChild);
    if (first) first.focus({ preventScroll: true });
  }

  function onOutsidePointer(event) {
    if (!timeMenuState) return;
    const path = event.composedPath ? event.composedPath() : [];
    if (path.indexOf(timeMenu) !== -1 || path.indexOf(timeMenuState.trigger) !== -1) return;
    closeTimeMenu(false);
  }

  function hideActions() {
    retryButton.hidden = true;
    connectButton.hidden = true;
    viewLink.hidden = true;
    newButton.hidden = true;
    deleteButton.hidden = true;
    addSelectedButton.hidden = true;
    cancelButton.hidden = true;
    viewLink.removeAttribute("href");
    rule.hidden = true;
    actions.hidden = true;
  }

  function showInputMode() {
    closeTimeMenu(false);
    resetInvitations();
    mode = "input";
    activeLookup = null;
    activeBatch = null;
    deleteArmed = false;
    draftEvent = null;
    batchList.hidden = true;
    clearList(batchList);
    body.hidden = true;
    card.classList.remove("expanded");
    card.classList.remove("clarifying");
    dismissButton.hidden = false;
    input.placeholder = INPUT_PLACEHOLDER;
    input.setAttribute("aria-label", "Event description");
    host.dataset.mode = "input";
    hideOnboarding();
  }

  function hideOnboarding() {
    stopOnboardingDemo();
    onboardingState = null;
    onboardingDemoKey = "";
    onboarding.hidden = true;
    card.hidden = false;
    docs.hidden = !docOpen();
  }

  function onboardingApi() {
    return globalThis.QuickCalOnboarding || null;
  }

  function prefersReducedMotion() {
    return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }

  function stopOnboardingDemo() {
    if (onboardingDemoRun) {
      onboardingDemoRun.generation += 1;
      (onboardingDemoRun.timers || []).forEach((id) => clearTimeout(id));
    }
    onboardingDemoRun = null;
    onboardingDemoPaused = false;
    clearList(onboardingStage);
  }

  function demoStillActive(run) {
    return !!(
      onboardingDemoRun &&
      run &&
      onboardingDemoRun.generation === run.generation &&
      onboardingState &&
      onboardingState.active &&
      !onboarding.hidden
    );
  }

  function scheduleDemo(run, delay, work) {
    if (!run || !demoStillActive(run)) return;
    const id = setTimeout(() => {
      if (!demoStillActive(run)) return;
      if (document.visibilityState === "hidden") {
        onboardingDemoPaused = true;
        return;
      }
      work();
    }, delay);
    run.timers.push(id);
  }

  function paintOverviewCapabilities() {
    clearList(onboardingCapabilities);
    const api = onboardingApi();
    const items = api && api.CAPABILITIES ? api.CAPABILITIES : [];
    items.forEach((item) => {
      const row = document.createElement("div");
      row.className = "onboarding-capability";
      const title = document.createElement("p");
      title.className = "onboarding-capability-title";
      title.textContent = item.title;
      const copy = document.createElement("p");
      copy.className = "onboarding-capability-copy";
      copy.textContent = item.copy;
      row.append(title, copy);
      onboardingCapabilities.appendChild(row);
    });
  }

  function demoBadge() {
    const badge = document.createElement("span");
    badge.className = "onboarding-demo-badge";
    badge.textContent = "Example";
    return badge;
  }

  function demoInputShell() {
    const shell = document.createElement("div");
    shell.className = "onboarding-demo-input";
    const field = document.createElement("div");
    field.className = "onboarding-demo-field";
    const caret = document.createElement("span");
    caret.className = "onboarding-demo-caret";
    caret.setAttribute("aria-hidden", "true");
    field.appendChild(caret);
    shell.appendChild(field);
    return { shell: shell, field: field, caret: caret };
  }

  function setDemoFieldText(field, caret, text, showCaret) {
    clearList(field);
    field.appendChild(document.createTextNode(text || ""));
    if (showCaret) field.appendChild(caret);
  }

  function demoResultCard(lines) {
    const cardEl = document.createElement("div");
    cardEl.className = "onboarding-demo-card";
    lines.forEach((line, index) => {
      const row = document.createElement("p");
      row.className = index === 0 ? "onboarding-demo-card-title" : "onboarding-demo-card-meta";
      row.textContent = line;
      cardEl.appendChild(row);
    });
    return cardEl;
  }

  function typeDemoText(run, field, caret, text, onDone) {
    if (prefersReducedMotion()) {
      setDemoFieldText(field, caret, text, false);
      onDone();
      return;
    }
    let index = 0;
    const stepMs = Math.max(28, Math.min(55, Math.floor(2200 / Math.max(text.length, 1))));
    function tick() {
      if (!demoStillActive(run)) return;
      index += 1;
      setDemoFieldText(field, caret, text.slice(0, index), index < text.length);
      if (index >= text.length) {
        onDone();
        return;
      }
      scheduleDemo(run, stepMs, tick);
    }
    tick();
  }

  function playEventDemo(run, demo) {
    clearList(onboardingStage);
    onboardingStage.appendChild(demoBadge());
    const input = demoInputShell();
    onboardingStage.appendChild(input.shell);
    const status = document.createElement("p");
    status.className = "onboarding-demo-status";
    status.hidden = true;
    onboardingStage.appendChild(status);
    typeDemoText(run, input.field, input.caret, demo.prompt, () => {
      scheduleDemo(run, 350, () => {
        input.shell.classList.add("submitted");
        status.hidden = false;
        status.textContent = "Creating event…";
        scheduleDemo(run, 900, () => {
          status.hidden = true;
          onboardingStage.appendChild(
            demoResultCard(["Meeting with Joe", "Thursday, March 12, 2026", "8:00–9:00 AM"])
          );
        });
      });
    });
  }

  function playAvailabilityDemo(run, demo) {
    clearList(onboardingStage);
    onboardingStage.appendChild(demoBadge());
    const input = demoInputShell();
    onboardingStage.appendChild(input.shell);
    const status = document.createElement("p");
    status.className = "onboarding-demo-status";
    status.hidden = true;
    onboardingStage.appendChild(status);
    const slots = document.createElement("div");
    slots.className = "onboarding-demo-slots";
    slots.hidden = true;
    const choices = [
      { label: "1:00–1:30 PM", pick: false },
      { label: "2:00–2:30 PM", pick: true },
      { label: "3:30–4:00 PM", pick: false },
    ];
    const buttons = choices.map((choice) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "onboarding-demo-slot";
      button.tabIndex = -1;
      button.textContent = choice.label;
      button.setAttribute("aria-hidden", "true");
      slots.appendChild(button);
      return { button: button, pick: choice.pick };
    });
    onboardingStage.appendChild(slots);
    typeDemoText(run, input.field, input.caret, demo.prompt, () => {
      scheduleDemo(run, 300, () => {
        status.hidden = false;
        status.textContent = "Searching Wednesday afternoon…";
        scheduleDemo(run, 900, () => {
          status.hidden = true;
          slots.hidden = false;
          const chosen = buttons.find((item) => item.pick);
          scheduleDemo(run, prefersReducedMotion() ? 0 : 700, () => {
            if (chosen) chosen.button.classList.add("selected");
            scheduleDemo(run, prefersReducedMotion() ? 0 : 500, () => {
              slots.hidden = true;
              onboardingStage.appendChild(
                demoResultCard([
                  demo.eventTitle || "Project sync",
                  "Wednesday, March 11, 2026",
                  "2:00–2:30 PM",
                ])
              );
            });
          });
        });
      });
    });
  }

  function playTaskDemo(run, demo) {
    clearList(onboardingStage);
    onboardingStage.appendChild(demoBadge());
    const input = demoInputShell();
    onboardingStage.appendChild(input.shell);
    const status = document.createElement("p");
    status.className = "onboarding-demo-status";
    status.hidden = true;
    onboardingStage.appendChild(status);
    typeDemoText(run, input.field, input.caret, demo.prompt, () => {
      scheduleDemo(run, 350, () => {
        input.shell.classList.add("submitted");
        status.hidden = false;
        status.textContent = "Creating task…";
        scheduleDemo(run, 900, () => {
          status.hidden = true;
          onboardingStage.appendChild(
            demoResultCard(["Call Joe", "Due Thursday, March 12, 2026"])
          );
        });
      });
    });
  }

  function playDocumentsDemo(run, demo) {
    clearList(onboardingStage);
    onboardingStage.appendChild(demoBadge());
    const drop = document.createElement("div");
    drop.className = "onboarding-demo-drop";
    const dropTitle = document.createElement("p");
    dropTitle.className = "onboarding-demo-drop-title";
    dropTitle.textContent = "Drag and drop a file here";
    drop.appendChild(dropTitle);
    onboardingStage.appendChild(drop);
    const fileChip = document.createElement("div");
    fileChip.className = "onboarding-demo-file";
    fileChip.hidden = true;
    fileChip.textContent = demo.fileName || "Course syllabus.pdf";
    onboardingStage.appendChild(fileChip);
    const input = demoInputShell();
    input.shell.hidden = true;
    onboardingStage.appendChild(input.shell);
    const status = document.createElement("p");
    status.className = "onboarding-demo-status";
    status.hidden = true;
    onboardingStage.appendChild(status);
    const list = document.createElement("div");
    list.className = "onboarding-demo-review";
    list.hidden = true;
    const checks = [];
    (demo.items || []).forEach((item, index) => {
      const row = document.createElement("label");
      row.className = "onboarding-demo-review-item";
      const box = document.createElement("span");
      box.className = "onboarding-demo-check";
      box.setAttribute("aria-hidden", "true");
      const body = document.createElement("span");
      body.className = "onboarding-demo-review-copy";
      const title = document.createElement("span");
      title.className = "onboarding-demo-review-title";
      title.textContent = item.title;
      const meta = document.createElement("span");
      meta.className = "onboarding-demo-review-meta";
      meta.textContent = item.dateText + " · " + item.timeText;
      body.append(title, meta);
      row.append(box, body);
      list.appendChild(row);
      checks.push({ box: box, selected: index < 2 });
    });
    const addButton = document.createElement("button");
    addButton.type = "button";
    addButton.className = "onboarding-demo-add";
    addButton.tabIndex = -1;
    addButton.setAttribute("aria-hidden", "true");
    addButton.textContent = "Create 2 Approved Events";
    addButton.hidden = true;
    list.appendChild(addButton);
    onboardingStage.appendChild(list);
    const summary = document.createElement("p");
    summary.className = "onboarding-demo-summary";
    summary.hidden = true;
    onboardingStage.appendChild(summary);

    function afterFile() {
      drop.hidden = true;
      fileChip.hidden = false;
      input.shell.hidden = false;
      typeDemoText(run, input.field, input.caret, demo.prompt, () => {
        scheduleDemo(run, 300, () => {
          status.hidden = false;
          status.textContent = "Finding exams…";
          scheduleDemo(run, 900, () => {
            status.hidden = true;
            list.hidden = false;
            scheduleDemo(run, prefersReducedMotion() ? 0 : 500, () => {
              checks.forEach((item) => {
                if (item.selected) item.box.classList.add("checked");
              });
              addButton.hidden = false;
              scheduleDemo(run, prefersReducedMotion() ? 0 : 700, () => {
                addButton.classList.add("pressed");
                scheduleDemo(run, prefersReducedMotion() ? 0 : 450, () => {
                  list.hidden = true;
                  summary.hidden = false;
                  summary.textContent = "Saved 2 events from Course syllabus.pdf. One exam left unselected.";
                });
              });
            });
          });
        });
      });
    }

    if (prefersReducedMotion()) {
      afterFile();
      return;
    }
    scheduleDemo(run, 400, () => {
      drop.classList.add("dragging");
      const ghost = document.createElement("div");
      ghost.className = "onboarding-demo-ghost";
      ghost.textContent = demo.fileName || "Course syllabus.pdf";
      onboardingStage.appendChild(ghost);
      scheduleDemo(run, 700, () => {
        ghost.remove();
        drop.classList.remove("dragging");
        afterFile();
      });
    });
  }

  function startOnboardingDemo(step, force) {
    const api = onboardingApi();
    const demos = api && api.DEMOS ? api.DEMOS : {};
    const demo = demos[step];
    if (!demo) {
      stopOnboardingDemo();
      onboardingStage.hidden = true;
      return;
    }
    const key = step;
    if (!force && onboardingDemoKey === key && onboardingDemoRun) return;
    stopOnboardingDemo();
    onboardingDemoKey = key;
    onboardingStage.hidden = false;
    onboardingSr.textContent = demo.description || "";
    const run = { generation: 1, timers: [], step: step };
    onboardingDemoRun = run;
    if (step === "demo-event") playEventDemo(run, demo);
    else if (step === "demo-availability") playAvailabilityDemo(run, demo);
    else if (step === "demo-task") playTaskDemo(run, demo);
    else if (step === "demo-documents") playDocumentsDemo(run, demo);
  }

  function resumeOnboardingDemoIfNeeded() {
    if (!onboardingState || !onboardingState.active) return;
    const step = onboardingState.step || "";
    if (String(step).indexOf("demo-") !== 0) return;
    if (!onboardingDemoPaused && onboardingDemoRun) return;
    onboardingDemoPaused = false;
    startOnboardingDemo(step, true);
  }

  function showOnboarding(view) {
    if (!view || !view.active) {
      hideOnboarding();
      return;
    }
    const api = onboardingApi();
    const step = api && api.normalizeStep ? api.normalizeStep(view.step) : view.step || "overview";
    const previousStep = onboardingState && onboardingState.step;
    onboardingState = Object.assign({}, view, { step: step });
    mode = "onboarding";
    host.dataset.mode = "onboarding";
    card.hidden = true;
    docs.hidden = true;
    onboarding.hidden = false;
    selectionChoice.hidden = true;
    connectRoute.hidden = true;
    healthRetry.hidden = true;
    clearStatus();

    const isDemo = String(step).indexOf("demo-") === 0;
    const demo = api && api.DEMOS ? api.DEMOS[step] : null;
    onboardingCapabilities.hidden = step !== "overview";
    onboardingStage.hidden = !isDemo;
    onboardingProgress.hidden = !isDemo;
    onboardingReplay.hidden = !isDemo;
    onboardingBack.hidden = step === "overview";
    onboardingSkip.hidden = step === "connect";
    onboardingDetail.hidden = true;
    onboardingDetail.textContent = "";
    onboardingDetail.className = "onboarding-detail";
    onboardingPrimary.disabled = onboardingBusy || (step === "connect" && view.connectState === "connecting");
    onboardingBack.disabled = onboardingBusy;
    onboardingSkip.disabled = onboardingBusy;
    onboardingReplay.disabled = onboardingBusy;

    if (step === "overview") {
      stopOnboardingDemo();
      onboardingDemoKey = "";
      onboardingTitle.textContent = "Welcome to QuickCalAI";
      onboardingCopy.textContent =
        "Create calendar events and Google Tasks with natural language from any webpage.";
      onboardingPrimary.textContent = "See how it works";
      onboardingSr.textContent =
        "QuickCalAI can create events, find a time, create tasks, and import dates from documents.";
      paintOverviewCapabilities();
    } else if (isDemo && demo) {
      onboardingTitle.textContent = demo.title;
      onboardingProgress.textContent = demo.progress || "";
      onboardingCopy.textContent = "Local example only. Nothing is sent or saved.";
      onboardingPrimary.textContent = "Next";
      if (previousStep !== step || onboardingDemoKey !== step) {
        startOnboardingDemo(step, true);
      }
    } else {
      stopOnboardingDemo();
      onboardingDemoKey = "";
      onboardingTitle.textContent = "Connect Google";
      onboardingCopy.textContent =
        "QuickCal needs Calendar access to create and update events you own, read your calendar list for conflicts, and Tasks access to create to-dos. Typed text, selections, and uploads are processed by AI; voice audio is transcribed remotely.";
      onboardingPrimary.textContent =
        view.connectState === "ready" ? "Start using QuickCal" : "Connect Google";
      onboardingSr.textContent =
        view.connectState === "ready"
          ? "QuickCalAI is connected and ready."
          : "Connect Google Calendar and Tasks to finish setup.";
      if (view.connectState === "connecting") {
        onboardingDetail.hidden = false;
        onboardingDetail.textContent = "Connecting to Google…";
        onboardingPrimary.disabled = true;
      } else if (view.connectState === "ready") {
        onboardingDetail.hidden = false;
        onboardingDetail.className = "onboarding-detail ready";
        onboardingDetail.textContent = "QuickCalAI is ready.";
      } else if (view.connectMessage) {
        onboardingDetail.hidden = false;
        onboardingDetail.textContent = view.connectMessage;
      }
    }
  }

  function sendOnboarding(action, payload) {
    if (onboardingBusy && action !== "complete") return Promise.resolve(null);
    onboardingBusy = true;
    paintOnboardingBusy();
    return chrome.runtime
      .sendMessage(Object.assign({ type: "quickcal-onboarding", action: action }, payload || {}))
      .then((result) => {
        onboardingBusy = false;
        if (result && result.session) {
          applyRemote(result.session, true);
          if (result.session.visible && !(result.session.onboarding && result.session.onboarding.active)) {
            prepareOpenTab();
          }
        } else if (result && result.result && onboardingState) {
          showOnboarding(onboardingState);
        } else if (onboardingState) showOnboarding(onboardingState);
        return result;
      })
      .catch(() => {
        onboardingBusy = false;
        if (onboardingState) {
          onboardingDetail.hidden = false;
          onboardingDetail.textContent = "QuickCalAI could not update onboarding.";
          showOnboarding(onboardingState);
        }
        return null;
      });
  }

  function paintOnboardingBusy() {
    if (!onboardingState) return;
    onboardingPrimary.disabled = true;
    onboardingBack.disabled = true;
    onboardingSkip.disabled = true;
    onboardingReplay.disabled = true;
  }

  function draftLabel(draft) {
    const event = draft && draft.event ? draft.event : {};
    const view = previewApi.previewModel(event);
    const parts = [];
    parts.push(view.title || event.title || "Untitled event");
    if (view.dateText) parts.push(view.dateText);
    if (view.timeText) parts.push(view.timeText);
    if (event.location) parts.push(event.location);
    if (event.durationDefaulted) parts.push("1 hour default");
    if (view.recurrenceText) parts.push(view.recurrenceText);
    return parts.join(", ");
  }

  function paintBatchList(batch) {
    clearList(batchList);
    activeBatch = batch;
    if (!batch || !batch.drafts || !batch.drafts.length) {
      batchList.hidden = true;
      return;
    }
    batchList.hidden = false;
    batch.drafts.forEach((draft) => {
      const row = document.createElement("div");
      row.className = "batch-item";
      row.setAttribute("role", "listitem");
      const label = document.createElement("label");
      label.className = "batch-label";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "batch-check";
      checkbox.checked = !!draft.selected && draft.complete && draft.saveStatus !== "saved";
      checkbox.disabled = !draft.complete || draft.saveStatus === "saved" || draft.saveStatus === "saving" || !!(batch && batch.saving);
      checkbox.setAttribute("aria-label", "Include " + draftLabel(draft));
      checkbox.addEventListener("change", () => {
        if (!shared || !activeBatch) return;
        chrome.runtime.sendMessage({
          type: "quickcal-widget",
          action: "batch-toggle",
          sessionId: sharedSessionId,
          ref: draft.ref,
          selected: checkbox.checked,
        }).then((result) => {
          if (result && result.session) applyRemote(result.session, false);
        }).catch(() => {});
      });
      const copy = document.createElement("div");
      copy.className = "batch-copy";
      const title = document.createElement("p");
      title.className = "batch-title";
      const view = previewApi.previewModel(draft.event);
      title.textContent = view.title || draft.event.title || "Untitled event";
      const meta = document.createElement("p");
      meta.className = "batch-meta";
      const bits = [];
      if (view.dateText) bits.push(view.dateText);
      if (view.timeText) bits.push(view.timeText);
      if (draft.event.location) bits.push(draft.event.location);
      if (draft.event.durationDefaulted) bits.push("Defaults to 1 hour");
      if (view.recurrenceText) bits.push(view.recurrenceText);
      meta.textContent = bits.join(" · ");
      copy.append(title, meta);
      if (!draft.complete) {
        const missing = document.createElement("p");
        missing.className = "batch-missing";
        missing.textContent = draft.missingText || "Missing details.";
        copy.appendChild(missing);
        const complete = document.createElement("button");
        complete.type = "button";
        complete.className = "action batch-complete";
        complete.textContent = "Complete details";
        complete.addEventListener("click", () => {
          if (!shared) return;
          chrome.runtime.sendMessage({
            type: "quickcal-widget",
            action: "batch-complete",
            sessionId: sharedSessionId,
            ref: draft.ref,
          }).then((result) => {
            if (result && result.session) applyRemote(result.session, true);
          }).catch(() => {});
        });
        copy.appendChild(complete);
      }
      if (draft.saveStatus === "saved" && draft.savedRecord) {
        const saved = document.createElement("p");
        saved.className = "batch-saved";
        saved.textContent = "Saved";
        const link = document.createElement("a");
        link.className = "action";
        link.textContent = "Edit in Google Calendar";
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        const edit = previewApi && previewApi.calendarEditLink
          ? previewApi.calendarEditLink(draft.savedRecord.htmlLink)
          : safeCalendarLink(draft.savedRecord.htmlLink);
        if (edit) {
          link.href = edit;
          copy.append(saved, link);
        } else {
          copy.appendChild(saved);
        }
      } else if (draft.saveStatus === "failed" || draft.saveStatus === "uncertain") {
        const err = document.createElement("p");
        err.className = "batch-missing";
        err.textContent = draft.saveError || "Could not save.";
        copy.appendChild(err);
      } else if (draft.saveStatus === "saving") {
        const wait = document.createElement("p");
        wait.className = "batch-meta";
        wait.textContent = "Saving\u2026";
        copy.appendChild(wait);
      }
      if (draft.conflictNotice && draft.conflictNotice.statusText) {
        const notice = document.createElement("p");
        notice.className = "batch-meta";
        notice.textContent = draft.conflictNotice.statusText;
        copy.appendChild(notice);
        (draft.conflictNotice.lines || []).forEach((line) => {
          const item = document.createElement("p");
          item.className = "batch-missing";
          item.textContent = line;
          copy.appendChild(item);
        });
      }
      label.append(checkbox, copy);
      row.appendChild(label);
      batchList.appendChild(row);
    });
  }

  function showBatchReview(batch, results) {
    mode = results ? "batch-results" : "reviewing";
    activeBatch = batch;
    clarification = null;
    activeLookup = null;
    deleteArmed = false;
    draftEvent = null;
    clearStatus();
    successRow.hidden = true;
    creatingLine.hidden = true;
    showSaveError("");
    summary.hidden = true;
    zoneLine.hidden = true;
    recurrenceLine.hidden = true;
    seriesLine.hidden = true;
    locationLine.hidden = true;
    remindersLine.hidden = true;
    noteLine.hidden = true;
    questionList.hidden = true;
    clearList(questionList);
    card.classList.add("expanded");
    card.classList.remove("clarifying");
    body.hidden = false;
    dismissButton.hidden = false;
    paintBatchList(batch);
    hideActions();
    const count = globalThis.QuickCalBatch ? globalThis.QuickCalBatch.selectedCount(batch) : 0;
    addSelectedButton.hidden = false;
    addSelectedButton.textContent = "Add selected events (" + count + ")";
    addSelectedButton.disabled = count < 1 || !!(batch && batch.saving);
    cancelButton.hidden = false;
    rule.hidden = false;
    actions.hidden = false;
    input.value = "";
    input.placeholder = results ? "Correct an event, or retry unfinished ones" : "Correct an event, or add selected";
    input.setAttribute("aria-label", "Batch correction");
    host.dataset.mode = mode;
  }

  function showBatchClarifying(batch, event) {
    activeBatch = batch;
    const originalText = batch && batch.sourceText ? batch.sourceText : "";
    clarification = {
      originalText: originalText,
      draft: draftFromEvent(event),
      batchRef: batch && batch.clarifyingRef ? batch.clarifyingRef : "",
    };
    draftEvent = null;
    clearStatus();
    successRow.hidden = true;
    creatingLine.hidden = true;
    showSaveError("");
    mode = "batch-clarifying";
    showCard(event);
    const prompt = clarificationPrompt(event);
    questionList.hidden = false;
    fillList(questionList, [prompt.question]);
    paintBatchList(batch);
    hideActions();
    cancelButton.hidden = false;
    rule.hidden = false;
    actions.hidden = false;
    card.classList.add("clarifying");
    input.value = "";
    input.placeholder = prompt.placeholder;
    input.setAttribute("aria-label", "Answer");
    host.dataset.mode = "batch-clarifying";
    suppressBatchConfirm = true;
    if (allowFocus) input.focus();
  }

  function showCard(event) {
    resetInvitations();
    const view = previewApi.previewModel(event);
    card.classList.add("expanded");
    body.hidden = false;
    dismissButton.hidden = false;
    summary.hidden = false;
    fillDetails(view);
    fillList(questionList, view.questions);
    host.dataset.mode = mode;
    return view;
  }

  function draftFromEvent(event) {
    return {
      title: event.title || null,
      date: event.date || null,
      endDate: event.endDate || null,
      startTime: event.startTime || null,
      endTime: event.endTime || null,
      allDay: event.allDay === true,
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
    if (!event.date && !event.startTime && !event.allDay) {
      return { question: "What date and time?", placeholder: "Tuesday at 8 PM" };
    }
    if (!event.date) return { question: "What date?", placeholder: "Tuesday" };
    if (!event.allDay && !event.startTime) return { question: "What time?", placeholder: "8 PM" };
    return { question: questions[0] || "What should be clarified?", placeholder: "Your answer" };
  }

  function showClarifying(event, sourceText) {
    closeTimeMenu(false);
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

  function showLookup(lookup) {
    closeTimeMenu(false);
    resetInvitations();
    activeLookup = lookup;
    mode = lookup.kind === "confirm" ? "confirming" : "choosing";
    deleteArmed = mode === "confirming" && !enterDown;
    card.classList.add("expanded");
    card.classList.add("clarifying");
    body.hidden = false;
    dismissButton.hidden = false;
    successRow.hidden = true;
    creatingLine.hidden = true;
    showSaveError("");
    eventTitle.textContent = lookup.prompt || "";
    eventTitle.hidden = !lookup.prompt;
    schedule.hidden = true;
    zoneLine.hidden = true;
    recurrenceLine.hidden = true;
    seriesLine.hidden = true;
    locationLine.hidden = true;
    remindersLine.hidden = true;
    fillList(questionList, lookup.lines || []);
    noteLine.textContent = lookup.hint || "";
    noteLine.hidden = !lookup.hint;
    hideActions();
    cancelButton.hidden = false;
    const seriesChange = lookup.action === "move" && lookup.kind === "confirm";
    const scheduleAnyway = lookup.action === "availability" && lookup.kind === "confirm" && !!lookup.forceSchedule;
    deleteButton.hidden = lookup.kind !== "confirm" || (lookup.action !== "delete" && !seriesChange && !scheduleAnyway);
    deleteButton.textContent = lookup.action === "delete"
      ? "Delete event"
      : scheduleAnyway
        ? "Schedule anyway"
        : "Change series";
    rule.hidden = false;
    actions.hidden = false;
    input.value = "";
    input.placeholder = lookup.kind === "confirm" && lookup.action === "delete"
      ? "Press Enter to delete"
      : scheduleAnyway
        ? "Press Enter to schedule anyway"
        : "Your answer";
    input.setAttribute("aria-label", lookup.kind === "confirm" ? "Confirm or correct" : "Answer");
    host.dataset.mode = mode;
    if (allowFocus) input.focus();
  }

  function showCreating(event) {
    closeTimeMenu(false);
    mode = "creating";
    clarification = null;
    card.classList.remove("clarifying");
    draftEvent = event;
    draftText = input.value.trim();
    clearStatus();
    successRow.hidden = true;
    creatingLine.hidden = false;
    creatingLine.textContent = event && event.kind === "task" ? "Creating task\u2026" : "Creating event\u2026";
    showSaveError("");
    fillList(questionList, []);
    showCard(event);
    hideActions();
  }

  function showFailed(message, disconnected) {
    closeTimeMenu(false);
    mode = "failed";
    creatingLine.hidden = true;
    successRow.hidden = true;
    showSaveError(message);
    showCard(draftEvent || {});
    fillList(questionList, []);
    retryButton.hidden = !!disconnected;
    connectButton.hidden = !disconnected;
    connectButton.textContent = TASKS_SCOPE_TEXT.test(message || "") ? "Reconnect Google" : "Connect Google Calendar";
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

  function presentConflictNotice(notice) {
    if (!notice || notice.status === "clear") {
      if (notice && notice.horizonText) {
        showStatus(notice.horizonText, false);
        fillList(questionList, notice.lines && notice.lines.length ? notice.lines : [notice.horizonText]);
      } else {
        fillList(questionList, []);
        if (notice && /conflict|overlap/i.test(status.textContent) && !selectionHold) clearStatus();
      }
      connectButton.hidden = true;
      return;
    }
    if (notice.status === "checking") {
      showStatus(notice.statusText || "Checking for conflicts\u2026", false);
      fillList(questionList, []);
      connectButton.hidden = true;
      return;
    }
    if (notice.statusText) showStatus(notice.statusText, false);
    fillList(questionList, notice.lines || []);
    if (notice.needsScopes || notice.status === "needsScopes") {
      connectButton.hidden = false;
      connectButton.textContent = "Reconnect Google Calendar";
      rule.hidden = false;
      actions.hidden = false;
    }
  }

  function showSaved(result, notice) {
    const sameTimes = !!(savedRecord && result && savedRecord.id === result.id &&
      savedRecord.startTime === result.startTime && savedRecord.endTime === result.endTime);
    if (!sameTimes) closeTimeMenu(false);
    activeLookup = null;
    deleteArmed = false;
    mode = "saved";
    clarification = null;
    card.classList.remove("clarifying");
    savedRecord = result;
    // Google Tasks have no guests, so only calendar events offer invitations.
    const inviteTarget = result.kind === "task" ? "" : result.id || "";
    if (inviteEventId !== inviteTarget) resetInvitations();
    inviteEventId = inviteTarget;
    people.hidden = !inviteEventId;
    inviteScope.hidden = !(result.recurrence || result.recurrenceText);
    draftEvent = null;
    card.classList.add("expanded");
    body.hidden = false;
    dismissButton.hidden = false;
    creatingLine.hidden = true;
    successRow.hidden = false;
    const task = result.kind === "task";
    successText.textContent = task ? "Task successfully created" : "Event successfully created";
    fillDetails({
      title: result.summary,
      date: result.dateText,
      time: result.timeText,
      timeZone: "",
      location: result.location || "",
      durationDefaulted: false,
      recurrenceText: result.recurrenceText || "",
      seriesEndText: result.seriesEndText || "",
      remindersText: result.remindersText || "",
      changeText: task && result.startTime
        ? "Google Tasks can't store a time, so it's added to the task's title."
        : result.changeText || "",
    });
    fillList(questionList, []);
    showSaveError("");
    retryButton.hidden = true;
    connectButton.hidden = true;
    if (task) presentTasksLink(result.htmlLink);
    else presentCalendarLink(result.htmlLink);
    newButton.hidden = false;
    rule.hidden = false;
    actions.hidden = false;
    input.value = "";
    input.placeholder = task ? INPUT_PLACEHOLDER : FOLLOW_PLACEHOLDER;
    input.setAttribute("aria-label", "Event description");
    cancelButton.hidden = true;
    host.dataset.mode = "saved";
    if (notice) presentConflictNotice(notice);
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
        timeZone: "",
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

  // ---- Document upload and review ---------------------------------------

  function docsApi() {
    return globalThis.QuickCalDocuments;
  }

  function docOpen() {
    return !!(shared && docState && docState.open);
  }

  function docBusy() {
    return !!docUploading || !!(docState && ["reading", "analyzing", "creating"].indexOf(docState.phase) !== -1);
  }

  function reducedMotion() {
    return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }

  function sendDoc(action, extra) {
    const message = Object.assign({
      type: "quickcal-widget",
      action: action,
      sessionId: sharedSessionId,
      docId: docState ? docState.id : "",
    }, extra || {});
    return chrome.runtime.sendMessage(message).then((result) => {
      if (!alive) return result;
      if (result && result.session) applyRemote(result.session, false);
      else if (!result || !result.ignored) {
        docLocalError = "QuickCalAI could not update the document review.";
        renderDoc();
      }
      return result;
    }).catch(() => {
      if (!alive) return null;
      docLocalError = "QuickCalAI could not reach the document review. Try again.";
      renderDoc();
      return null;
    });
  }

  function toggleDocs() {
    if (!shared || pending || saving || voicePhase !== "idle") return;
    docLocalError = "";
    if (docOpen()) {
      closeTimeMenu(false);
      docEditing = null;
      docState = Object.assign({}, docState, { open: false });
      renderDoc();
      sendDoc("doc-close");
      return;
    }
    sendDoc("doc-open");
  }

  // A highlighted-text event closes the panel first, so it follows the
  // ordinary event path rather than filtering the document.
  function closeDocsForEvent() {
    docEditing = null;
    docState = Object.assign({}, docState, { open: false });
    renderDoc();
    sendDoc("doc-close");
  }

  // Messages that normally sit under the bar move into the panel while it is
  // open, so the panel never covers them.
  function placeStatusInDocs(inside) {
    const moving = [status, selectionChoice, connectRoute, healthRetry];
    if (inside) {
      docsStatusSlot.append.apply(docsStatusSlot, moving);
      return;
    }
    moving.forEach((node) => shell.insertBefore(node, timeMenu));
  }

  // The panel unfolds below the bar when there is room and above it near the
  // bottom of the screen. The bar itself is never moved or resized.
  function placeDocs() {
    if (docs.hidden) return;
    const scale = widgetScale > 0 ? widgetScale : 1;
    const rect = bar.getBoundingClientRect();
    const below = window.innerHeight - rect.bottom - 12;
    const above = rect.top - 12;
    const dir = below >= 300 * scale || below >= above ? "down" : "up";
    docs.dataset.dir = dir;
    const room = Math.max(140, Math.floor((dir === "down" ? below : above) / scale));
    docs.style.setProperty("--docs-max", Math.min(room, 520) + "px");
  }

  // "open" runs the unfold transition; "settled" then removes the clip so the
  // panel is fully shown even if the transition never ran (a throttled tab).
  function setDocsVisible(visible) {
    const showing = !docs.hidden && docs.dataset.state !== "closed";
    attachButton.setAttribute("aria-expanded", visible ? "true" : "false");
    attachButton.classList.toggle("active", visible);
    if (visible === showing) return;
    clearTimeout(docAnimTimer);
    if (visible) {
      docs.hidden = false;
      panel.classList.add("docs-open");
      placeStatusInDocs(true);
      placeDocs();
      docs.dataset.state = "closed";
      void docs.offsetHeight;
      docs.dataset.state = "open";
      docAnimTimer = setTimeout(() => {
        if (docs.dataset.state === "open") docs.dataset.state = "settled";
      }, reducedMotion() ? 0 : 280);
      return;
    }
    if (docs.dataset.state === "settled") {
      docs.dataset.state = "open";
      void docs.offsetHeight;
    }
    docs.dataset.state = "closed";
    const finish = () => {
      if (docs.dataset.state !== "closed") return;
      docs.hidden = true;
      panel.classList.remove("docs-open");
      placeStatusInDocs(false);
    };
    if (reducedMotion()) finish();
    else docAnimTimer = setTimeout(finish, 260);
  }

  function fileMeta(file) {
    const parts = [docsApi().formatSize(file.size)];
    if (Number.isInteger(file.pages)) parts.push(file.pages + (file.pages === 1 ? " page" : " pages"));
    return parts.filter(Boolean).join(" \u00b7 ");
  }

  function itemDateText(value) {
    const api = globalThis.QuickCalSchedule;
    return api ? api.formatCompactDate(value) : value;
  }

  function itemWhen(item) {
    const times = globalThis.QuickCalTimes;
    const label = (value) => (times ? times.label(value) : value);
    if (item.kind === "task") {
      const due = item.date ? "Due " + itemDateText(item.date) : "No due date";
      return item.startTime ? due + " \u00b7 " + label(item.startTime) : due;
    }
    if (!item.date) return "No date";
    const days = item.endDate && item.endDate !== item.date ? itemDateText(item.date) + " \u2013 " + itemDateText(item.endDate) : itemDateText(item.date);
    if (item.allDay) return days + " \u00b7 All day";
    if (!item.startTime) return days + " \u00b7 No time";
    const end = docsApi().effectiveEnd(item);
    return days + " \u00b7 " + label(item.startTime) + " \u2013 " + label(end.endTime);
  }

  function itemNotes(item) {
    const notes = (item.issues || []).slice();
    const api = docsApi();
    if (item.kind === "event" && item.startTime && api.effectiveEnd(item).defaulted) {
      notes.push("End time not in the document. 1 hour is assumed.");
    }
    if (item.kind === "task" && item.startTime) notes.push("Google Tasks can't store a time, so it's added to the task's title.");
    const problem = item.decision !== "approved" && !(item.result && item.result.ok) ? api.itemProblem(item) : "";
    if (problem) notes.push("Before approving: " + problem.toLowerCase().replace(/.$/, "") + ".");
    return notes;
  }

  function resultLink(result) {
    if (!result || !result.ok) return "";
    return result.kind === "task"
      ? (previewApi && previewApi.tasksLink ? previewApi.tasksLink(result.link) : "")
      : safeCalendarLink(result.link);
  }

  function docButton(className, label) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.textContent = label;
    return button;
  }

  function buildDocRow(item) {
    const li = document.createElement("li");
    li.className = "docs-item";
    li.dataset.id = item.id;
    const head = document.createElement("div");
    head.className = "docs-item-head";
    const kind = document.createElement("span");
    kind.className = "docs-kind";
    const title = document.createElement("p");
    title.className = "docs-item-title";
    head.append(kind, title);
    const when = document.createElement("p");
    when.className = "docs-item-when";
    const detail = document.createElement("p");
    detail.className = "docs-item-detail";
    const source = document.createElement("p");
    source.className = "docs-item-source";
    const notes = document.createElement("ul");
    notes.className = "docs-item-notes";
    const actionsRow = document.createElement("div");
    actionsRow.className = "docs-item-actions";
    const approve = docButton("docs-choice docs-approve", "Approve");
    const skip = docButton("docs-choice docs-skip", "Skip");
    const edit = docButton("docs-link docs-edit", "Edit");
    const outcome = document.createElement("p");
    outcome.className = "docs-item-result";
    const outcomeText = document.createElement("span");
    const outcomeLink = document.createElement("a");
    outcomeLink.className = "docs-link";
    outcomeLink.target = "_blank";
    outcomeLink.rel = "noopener noreferrer";
    outcome.append(outcomeText, outcomeLink);
    actionsRow.append(approve, skip, edit, outcome);
    const form = document.createElement("div");
    form.className = "docs-edit-form";
    form.hidden = true;
    li.append(head, when, detail, source, notes, actionsRow, form);
    approve.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const current = docRows.get(item.id);
      if (!current) return;
      docLocalError = "";
      sendDoc("doc-decide", { itemId: item.id, decision: current.item.decision === "approved" ? "pending" : "approved" });
    });
    skip.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const current = docRows.get(item.id);
      if (!current) return;
      docLocalError = "";
      sendDoc("doc-decide", { itemId: item.id, decision: current.item.decision === "skipped" ? "pending" : "skipped" });
    });
    edit.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const current = docRows.get(item.id);
      if (current) openDocEdit(current.item);
    });
    return { li, kind, title, when, detail, source, notes, approve, skip, edit, outcome, outcomeText, outcomeLink, form, item };
  }

  function updateDocRow(row, item, locked) {
    row.item = item;
    const done = !!(item.result && item.result.ok);
    const failed = !!(item.result && !item.result.ok);
    row.li.dataset.decision = done ? "created" : item.decision;
    row.kind.textContent = item.kind === "task" ? "Task" : "Event";
    row.kind.dataset.kind = item.kind;
    row.title.textContent = item.title;
    row.title.title = item.title;
    row.when.textContent = itemWhen(item);
    row.detail.textContent = item.description || "";
    row.detail.hidden = !item.description;
    const quote = item.sourceQuote ? "\u201c" + item.sourceQuote + "\u201d" : "";
    row.source.textContent = [quote, item.sourcePage ? "page " + item.sourcePage : ""].filter(Boolean).join(" \u00b7 ");
    row.source.hidden = !row.source.textContent;
    fillList(row.notes, done ? [] : itemNotes(item));
    const problem = docsApi().itemProblem(item);
    row.approve.hidden = done;
    row.skip.hidden = done;
    row.edit.hidden = done;
    row.approve.disabled = locked || (!!problem && item.decision !== "approved");
    row.skip.disabled = locked;
    row.edit.disabled = locked;
    row.approve.setAttribute("aria-pressed", item.decision === "approved" ? "true" : "false");
    row.skip.setAttribute("aria-pressed", item.decision === "skipped" ? "true" : "false");
    row.approve.textContent = item.decision === "approved" ? "Approved" : "Approve";
    row.skip.textContent = item.decision === "skipped" ? "Skipped" : "Skip";
    row.approve.title = problem && item.decision !== "approved" ? problem : "";
    const link = resultLink(item.result);
    row.outcome.hidden = !done && !failed;
    row.outcome.classList.toggle("error", failed);
    row.outcomeText.textContent = done ? (item.kind === "task" ? "Task created" : "Event created") : failed ? item.result.error || "Could not create this item." : "";
    row.outcomeLink.hidden = !link;
    if (link) {
      row.outcomeLink.href = link;
      row.outcomeLink.textContent = item.kind === "task" ? "View in Google Tasks" : "View in Google Calendar";
    } else {
      row.outcomeLink.removeAttribute("href");
    }
    if (docEditing && docEditing.itemId === item.id && (done || locked)) cancelDocEdit();
  }

  function renderDocItems(doc) {
    const locked = doc.phase === "creating" || doc.phase === "analyzing";
    const ids = new Set(doc.items.map((item) => item.id));
    docRows.forEach((row, id) => {
      if (ids.has(id)) return;
      row.li.remove();
      docRows.delete(id);
      if (docEditing && docEditing.itemId === id) docEditing = null;
    });
    let previous = null;
    doc.items.forEach((item) => {
      let row = docRows.get(item.id);
      if (!row) {
        row = buildDocRow(item);
        docRows.set(item.id, row);
      }
      updateDocRow(row, item, locked);
      const expected = previous ? previous.nextSibling : docsList.firstChild;
      if (expected !== row.li) docsList.insertBefore(row.li, expected);
      previous = row.li;
    });
  }

  function tallyText(items) {
    const approved = items.filter((item) => item.decision === "approved").length;
    const skipped = items.filter((item) => item.decision === "skipped").length;
    const parts = [approved + " of " + items.length + " approved"];
    if (skipped) parts.push(skipped + " skipped");
    return parts.join(" \u00b7 ");
  }

  function renderDoc() {
    const doc = docState;
    const visible = docOpen();
    setDocsVisible(visible);
    if (visible && input.placeholder !== DOC_PLACEHOLDER) {
      input.placeholder = DOC_PLACEHOLDER;
      input.setAttribute("aria-label", "What to find in the document");
    } else if (!visible && input.placeholder === DOC_PLACEHOLDER) {
      input.placeholder = INPUT_PLACEHOLDER;
      input.setAttribute("aria-label", "Event description");
    }
    if (!doc || !docsApi()) {
      docRows.forEach((row) => row.li.remove());
      docRows.clear();
      return;
    }
    const file = docUploading || doc.file;
    const busy = docBusy();
    docsDrop.hidden = !!file;
    docsFile.hidden = !file;
    if (file) {
      const type = docsApi().TYPES[file.kind];
      docsFileIcon.textContent = type ? type.label : "FILE";
      docsFileName.textContent = file.name;
      docsFileName.title = file.name;
      docsFileMeta.textContent = docUploading || doc.phase === "reading" ? "Reading\u2026" : fileMeta(file);
      docsRemove.disabled = busy;
      docsRemove.textContent = "Remove";
      docsRemove.setAttribute("aria-label", "Remove " + file.name);
    }
    const message = docLocalError || doc.message || "";
    docsMessage.textContent = message;
    docsMessage.hidden = !message;
    docsMessage.classList.toggle("error", !!docLocalError || !!doc.messageError);
    docsMessage.classList.toggle("busy", !docLocalError && busy);
    if (doc.needsConnect && visible) connectRoute.hidden = false;
    docsPrompt.hidden = doc.phase !== "ready" || !!docUploading;
    docsAnalyze.disabled = busy;
    const reviewing = doc.items.length > 0 || doc.phase === "review";
    docsFilter.hidden = !reviewing || doc.phase === "analyzing";
    docsFilter.textContent = doc.instructions
      ? "Showing results for \u201c" + doc.instructions + "\u201d"
      : "Showing dates and deadlines from the whole document";
    renderDocItems(doc);
    docsList.hidden = doc.items.length === 0;
    docsFooter.hidden = doc.items.length === 0;
    const ready = docsApi().counts(doc.items).total;
    docsCreate.textContent = doc.phase === "creating" ? "Creating\u2026" : docsApi().createLabel(doc.items);
    docsCreate.disabled = busy || ready === 0;
    docsTally.textContent = tallyText(doc.items);
    placeDocs();
  }

  function analyzeFromInput(text) {
    const doc = docState;
    docLocalError = "";
    if (docUploading || (doc && doc.phase === "reading")) docLocalError = "Wait for the document to finish reading.";
    else if (!doc || !doc.file) docLocalError = "Add a document first.";
    else if (doc.phase === "unreadable") docLocalError = "This document could not be read. Remove it and try another file.";
    else if (docBusy()) docLocalError = "QuickCalAI is still working on this document.";
    if (docLocalError) {
      renderDoc();
      return;
    }
    input.value = "";
    publishInput();
    sendDoc("doc-analyze", {
      instructions: text,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    });
  }

  function encodeFile(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let index = 0; index < bytes.length; index += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(index, index + 0x8000));
    }
    return btoa(binary);
  }

  async function uploadDocFile(file) {
    if (!file || !docOpen() || docBusy()) return;
    const checked = docsApi().checkFile({ name: file.name, size: file.size });
    if (!checked.ok) {
      docLocalError = checked.error;
      renderDoc();
      return;
    }
    docLocalError = "";
    docEditing = null;
    docUploading = { name: file.name, size: file.size, kind: checked.kind, pages: null };
    renderDoc();
    let data;
    try {
      data = encodeFile(await file.arrayBuffer());
    } catch (error) {
      docUploading = null;
      docLocalError = "QuickCalAI could not open this file.";
      renderDoc();
      return;
    }
    if (!alive || !docOpen()) {
      docUploading = null;
      return;
    }
    sendDoc("doc-attach", { name: file.name, size: file.size, data: data }).finally(() => {
      docUploading = null;
      if (alive) renderDoc();
    });
  }

  function cancelDocEdit() {
    if (!docEditing) return;
    const row = docRows.get(docEditing.itemId);
    docEditing = null;
    closeTimeMenu(false);
    if (row) {
      row.form.hidden = true;
      clearList(row.form);
      row.edit.setAttribute("aria-expanded", "false");
      if (!row.edit.hidden) row.edit.focus();
    }
  }

  function formField(labelText, control) {
    const wrap = document.createElement("label");
    wrap.className = "docs-field";
    const caption = document.createElement("span");
    caption.className = "docs-field-label";
    caption.textContent = labelText;
    wrap.append(caption, control);
    return wrap;
  }

  // Inline correction form. Changes stay local until Save.
  function openDocEdit(item) {
    if (docBusy()) return;
    if (docEditing && docEditing.itemId === item.id) {
      cancelDocEdit();
      return;
    }
    cancelDocEdit();
    const row = docRows.get(item.id);
    if (!row) return;
    const draft = {
      kind: item.kind,
      title: item.title,
      date: item.date,
      startTime: item.startTime,
      endTime: item.endTime || (item.kind === "event" && item.startTime ? docsApi().effectiveEnd(item).endTime : null),
      endDate: item.endDate,
      allDay: item.allDay,
      description: item.description || "",
    };
    docEditing = { itemId: item.id, draft: draft };
    const form = row.form;
    clearList(form);
    const times = globalThis.QuickCalTimes;

    const titleInput = document.createElement("input");
    titleInput.type = "text";
    titleInput.className = "docs-control";
    titleInput.value = draft.title;
    titleInput.maxLength = 200;

    const kindRow = document.createElement("div");
    kindRow.className = "docs-segment";
    kindRow.setAttribute("role", "group");
    kindRow.setAttribute("aria-label", "Type");
    const asEvent = docButton("docs-segment-option", "Event");
    const asTask = docButton("docs-segment-option", "Task");
    kindRow.append(asEvent, asTask);

    const dateInput = document.createElement("input");
    dateInput.type = "date";
    dateInput.className = "docs-control";
    dateInput.value = draft.date || "";

    const allDayBox = document.createElement("input");
    allDayBox.type = "checkbox";
    allDayBox.className = "docs-check";
    allDayBox.checked = !!draft.allDay;
    const allDayLabel = document.createElement("label");
    allDayLabel.className = "docs-check-label";
    allDayLabel.append(allDayBox, document.createTextNode("All day"));

    const startButton = docButton("docs-time", "");
    const endButton = docButton("docs-time", "");
    const clearTime = docButton("docs-link", "Clear time");
    const timeRow = document.createElement("div");
    timeRow.className = "docs-time-row";
    const startField = formField("Start", startButton);
    const endField = formField("End", endButton);
    timeRow.append(startField, endField, clearTime);

    const detailInput = document.createElement("textarea");
    detailInput.className = "docs-control docs-textarea";
    detailInput.rows = 2;
    detailInput.maxLength = 500;
    detailInput.value = draft.description;

    const formError = document.createElement("p");
    formError.className = "docs-form-error";
    formError.setAttribute("role", "status");
    formError.hidden = true;

    const buttons = document.createElement("div");
    buttons.className = "docs-form-actions";
    const save = docButton("docs-action", "Save");
    const cancel = docButton("docs-link", "Cancel");
    buttons.append(save, cancel);

    function paint() {
      const task = draft.kind === "task";
      asEvent.setAttribute("aria-pressed", task ? "false" : "true");
      asTask.setAttribute("aria-pressed", task ? "true" : "false");
      allDayLabel.hidden = task;
      startField.firstChild.textContent = task ? "Due time" : "Start";
      endField.hidden = task || !draft.startTime;
      timeRow.hidden = !task && draft.allDay;
      startButton.textContent = draft.startTime && times ? times.label(draft.startTime) : "Add time";
      endButton.textContent = draft.endTime && times ? times.label(draft.endTime) : "Add time";
      clearTime.hidden = !draft.startTime;
    }

    function pickStart(key, value) {
      if (draft.kind === "event" && draft.startTime && draft.endTime && times) {
        const moved = times.applyPick({ date: draft.date, endDate: draft.endDate, startTime: draft.startTime, endTime: draft.endTime }, "start", value);
        draft.endTime = moved.ok ? moved.endTime : null;
      } else if (draft.kind === "event" && times) {
        draft.endTime = times.shiftedEnd("00:00", "01:00", value);
      }
      draft.startTime = value;
      paint();
    }

    startButton.setAttribute("aria-haspopup", "dialog");
    endButton.setAttribute("aria-haspopup", "dialog");
    startButton.setAttribute("aria-expanded", "false");
    endButton.setAttribute("aria-expanded", "false");
    startButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openTimeMenu(startButton, [{ key: "start", label: draft.kind === "task" ? "Due" : "Start", value: draft.startTime, after: null, near: "09:00" }], pickStart);
    });
    endButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const sameDay = !draft.endDate || draft.endDate === draft.date;
      openTimeMenu(endButton, [{ key: "end", label: "End", value: draft.endTime, after: sameDay ? draft.startTime : null, near: draft.startTime }], (key, value) => {
        draft.endTime = value;
        paint();
      });
    });
    clearTime.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      draft.startTime = null;
      draft.endTime = null;
      paint();
    });
    asEvent.addEventListener("click", (event) => {
      event.preventDefault();
      draft.kind = "event";
      paint();
    });
    asTask.addEventListener("click", (event) => {
      event.preventDefault();
      draft.kind = "task";
      draft.allDay = false;
      allDayBox.checked = false;
      paint();
    });
    allDayBox.addEventListener("change", () => {
      draft.allDay = allDayBox.checked;
      paint();
    });
    save.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const patch = {
        kind: draft.kind,
        title: titleInput.value,
        date: dateInput.value || null,
        allDay: draft.kind === "event" && draft.allDay,
        startTime: draft.allDay && draft.kind === "event" ? null : draft.startTime,
        endTime: draft.kind === "event" && !draft.allDay ? draft.endTime : null,
        description: detailInput.value,
      };
      const checked = docsApi().applyEdit(row.item, patch);
      if (!checked.ok) {
        formError.textContent = checked.error;
        formError.hidden = false;
        return;
      }
      save.disabled = true;
      sendDoc("doc-edit", { itemId: item.id, patch: patch }).then((result) => {
        save.disabled = false;
        if (result && result.ok) {
          cancelDocEdit();
          return;
        }
        formError.textContent = (result && result.error) || "QuickCalAI could not save this change.";
        formError.hidden = false;
      });
    });
    cancel.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      cancelDocEdit();
    });
    [titleInput, dateInput, detailInput].forEach((control) => {
      control.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && control !== detailInput) {
          event.preventDefault();
          save.click();
        }
        event.stopPropagation();
      });
    });

    form.append(
      formField("Title", titleInput),
      kindRow,
      formField(draft.kind === "task" ? "Due date" : "Date", dateInput),
      allDayLabel,
      timeRow,
      formField("Details", detailInput),
      formError,
      buttons
    );
    paint();
    form.hidden = false;
    row.edit.setAttribute("aria-expanded", "true");
    titleInput.focus();
  }

  function render() {
    people.hidden = mode !== "saved" || !savedRecord || !inviteEventId;
    paintHost(host, styled && open, mode !== "input");
    if (!docs.hidden) placeDocs();
    if (allowFocus && styled && open && mode === "onboarding" && !onboardingBusy) {
      onboardingPrimary.focus();
      return;
    }
    if (allowFocus && styled && open && (mode === "input" || mode === "clarifying") && !pending && !saving && voicePhase === "idle") focusInput();
  }

  function resetConversation() {
    resetInvitations();
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
    if (onboardingState && onboardingState.active) return;
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
    if (timeMenuState) {
      closeTimeMenu(true);
      return;
    }
    if (docEditing) {
      cancelDocEdit();
      return;
    }
    if (docOpen() && !pending && !saving && voicePhase === "idle") {
      toggleDocs();
      return;
    }
    setOpen(false);
  }

  onboardingBack.addEventListener("click", () => {
    if (!onboardingState || onboardingBusy) return;
    const api = onboardingApi();
    const step = onboardingState.step || "overview";
    const previous = api && api.previousStep ? api.previousStep(step) : "overview";
    const exampleIndex = api && api.demoIndex ? Math.max(0, api.demoIndex(previous)) : 0;
    sendOnboarding("step", { step: previous, exampleIndex: exampleIndex });
  });
  onboardingSkip.addEventListener("click", () => {
    if (!onboardingState || onboardingBusy) return;
    sendOnboarding("step", { step: "connect", exampleIndex: onboardingState.exampleIndex || 0 });
  });
  onboardingReplay.addEventListener("click", () => {
    if (!onboardingState || onboardingBusy) return;
    const step = onboardingState.step || "";
    if (String(step).indexOf("demo-") !== 0) return;
    startOnboardingDemo(step, true);
  });
  onboardingPrimary.addEventListener("click", () => {
    if (!onboardingState || onboardingBusy) return;
    const api = onboardingApi();
    const step = onboardingState.step || "overview";
    if (step === "connect") {
      if (onboardingState.connectState === "ready") {
        sendOnboarding("complete", {});
        return;
      }
      sendOnboarding("connect", {});
      return;
    }
    const next = api && api.nextStep ? api.nextStep(step) : "connect";
    const exampleIndex = api && api.demoIndex ? Math.max(0, api.demoIndex(next)) : 0;
    sendOnboarding("step", { step: next, exampleIndex: exampleIndex });
  });

  function savedSchedule() {
    return {
      date: savedRecord.date,
      endDate: savedRecord.endDate || savedRecord.date,
      startTime: savedRecord.startTime,
      endTime: savedRecord.endTime,
    };
  }

  function openSavedTimeMenu() {
    if (!retimeable() || pending || saving) return;
    const current = savedSchedule();
    const sameDay = current.endDate === current.date;
    openTimeMenu(timeEdit, [
      { key: "start", label: "Start", value: current.startTime, after: null },
      { key: "end", label: "End", value: current.endTime, after: sameDay ? current.startTime : null },
    ], retimeSaved);
  }

  // Applies a picked time to the event already in Google Calendar.
  function retimeSaved(field, value) {
    if (!retimeable() || pending || saving) return;
    const pick = globalThis.QuickCalTimes.applyPick(savedSchedule(), field, value);
    if (!pick.ok) {
      showSaveError(pick.error);
      return;
    }
    if (!pick.changed) return;
    showSaveError("");
    if (!shared) {
      saveEdit(Object.assign(currentEventPayload(), {
        startTime: pick.startTime,
        endTime: pick.endTime,
        durationDefaulted: false,
        needsClarification: false,
        clarificationQuestions: [],
      }));
      return;
    }
    const operationId = typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : "retime-" + Date.now();
    pending = true;
    showStatus("Updating event\u2026", false);
    render();
    chrome.runtime.sendMessage({
      type: "quickcal-widget",
      action: "retime",
      sessionId: sharedSessionId,
      operationId: operationId,
      eventId: savedRecord.id,
      startTime: pick.startTime,
      endTime: pick.endTime,
    }).then((result) => {
      pending = false;
      if (!alive) return;
      if (result && result.session) applyRemote(result.session, false);
      if (!result || (!result.ok && !(result.session && result.session.statusError))) {
        clearStatus();
        showSaveError(result && result.ignored
          ? "QuickCalAI is still finishing another change. Try again."
          : (result && result.error) || "QuickCalAI could not update this event.");
      }
      render();
    }).catch(() => {
      pending = false;
      if (!alive) return;
      clearStatus();
      showSaveError("QuickCalAI could not update this event.");
      render();
    });
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
    const link = savedLink(result);
    if (result && result.ok === true && link) {
      showSaved({
        kind: result.kind === "task" ? "task" : undefined,
        id: result.id || "",
        calendarId: result.calendarId || "primary",
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
      !!(result && (result.state === "disconnected" || result.state === "needsTasksScope"))
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
        expectedId: previous.id || "",
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
        id: result.id || "",
        calendarId: result.calendarId || "primary",
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
    if (docOpen()) {
      analyzeFromInput(text);
      return;
    }
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
    const editing = mode === "saved" && savedRecord && savedRecord.kind !== "task";
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
    return pending || saving || voicePhase !== "idle" || !!(activeBatch && activeBatch.saving);
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

  async function beginNewEvent(text, asBatch) {
    if (docOpen()) closeDocsForEvent();
    dismissSelectionChoice();
    selectionHold = false;
    clarification = null;
    savedRecord = null;
    activeBatch = null;
    showInputMode();
    input.value = text;
    submitFresh = true;
    pendingBatchSelection = !!asBatch;
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
      draft:
        input.value.trim().length > 0 ||
        mode === "clarifying" ||
        mode === "batch-clarifying" ||
        mode === "reviewing" ||
        mode === "batch-results",
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
      beginNewEvent(plan.text, true);
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
      if (state.layout) applyLayout(state.layout, false);
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
        activeLookup = null;
        deleteArmed = false;
        input.value = "";
        showInputMode();
        clearStatus();
        hideActions();
        docState = null;
        docEditing = null;
        renderDoc();
        render();
        return;
      }
      open = true;
      if (state.onboarding && state.onboarding.active) {
        showOnboarding(state.onboarding);
        if (typeof state.input === "string" && state.input && !inputDirty) input.value = state.input;
        render();
        return;
      }
      if (onboardingState) hideOnboarding();
      const focused = shadow.activeElement === input;
      const typedValue = input.value;
      const keepTyped = focused && inputDirty && typedValue !== (state.input || "");
      if ((state.mode === "choosing" || state.mode === "confirming") && state.lookup) {
        clarification = null;
        activeBatch = null;
        showLookup(state.lookup);
        input.value = keepTyped ? typedValue : (state.input || "");
        if (state.statusText) showStatus(state.statusText, !!state.statusError);
        syncConnectFromSession(state);
      } else if (state.mode === "batch-clarifying" && state.batch && state.event) {
        clarification = state.clarification;
        showBatchClarifying(state.batch, state.event);
        input.value = keepTyped ? typedValue : (state.input || "");
        if (state.statusText) showStatus(state.statusText, !!state.statusError);
        syncConnectFromSession(state);
      } else if ((state.mode === "reviewing" || state.mode === "batch-results") && state.batch) {
        showBatchReview(state.batch, state.mode === "batch-results");
        input.value = keepTyped ? typedValue : (state.input || "");
        if (state.statusText) showStatus(state.statusText, !!state.statusError);
        syncConnectFromSession(state);
      } else if (state.mode === "clarifying" && state.event) {
        clarification = state.clarification;
        activeBatch = null;
        showClarifying(state.event, state.clarification && state.clarification.originalText);
        input.value = keepTyped ? typedValue : (state.input || "");
        if (state.statusText) showStatus(state.statusText, !!state.statusError);
        syncConnectFromSession(state);
      } else if (state.mode === "failed") {
        draftEvent = state.draftEvent || state.event;
        const failedText = state.statusText || "";
        showFailed(failedText || "QuickCalAI could not save this event.", /Connect Google Calendar|Connect Google before/i.test(failedText) || TASKS_SCOPE_TEXT.test(failedText));
        if (!keepTyped) input.value = state.input || "";
        syncConnectFromSession(state);
      } else if (state.mode === "creating" && state.event) {
        showCreating(state.event);
        if (!keepTyped) input.value = state.input || "";
      } else if (state.mode === "saved" && state.savedRecord) {
        showSaved(state.savedRecord, state.conflictNotice);
        if (state.event && state.event.needsClarification) showEditQuestion(state.event);
        if (!keepTyped) input.value = state.input || "";
        if (state.statusError) showSaveError(state.statusText);
        else if (state.conflictNotice) presentConflictNotice(state.conflictNotice);
        else if (state.statusText) showStatus(state.statusText, false);
        else if (!selectionHold) clearStatus();
        syncConnectFromSession(state);
      } else {
        showInputMode();
        if (!keepTyped) input.value = state.input || "";
        if (state.statusText) showStatus(state.statusText, !!state.statusError);
        syncConnectFromSession(state);
      }
      docState = state.doc || null;
      renderDoc();
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
    const asBatch = pendingBatchSelection || mode === "batch-clarifying" || mode === "reviewing" || mode === "batch-results";
    pendingBatchSelection = false;
    pending = true;
    showStatus(
      mode === "saved"
        ? "Updating event\u2026"
        : asBatch
          ? "Reading your events\u2026"
          : "Reading your event\u2026",
      false
    );
    render();
    chrome.runtime.sendMessage({
      type: "quickcal-widget",
      action: "submit",
      text: text,
      fresh: !!fresh,
      batch: !!asBatch && (fresh || mode === "batch-clarifying" || mode === "reviewing" || mode === "batch-results"),
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
      if (result && result.session) {
        if (mode === "batch-clarifying") suppressBatchConfirm = true;
        applyRemote(result.session, true);
      } else {
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

  function confirmBatch() {
    if (!shared || !activeBatch || pending || saving || activeBatch.saving) return;
    if (suppressBatchConfirm) return;
    const count = globalThis.QuickCalBatch ? globalThis.QuickCalBatch.selectedCount(activeBatch) : 0;
    if (count < 1) return;
    const operationId = typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : "batch-" + Date.now();
    pending = true;
    showStatus("Adding selected events\u2026", false);
    render();
    chrome.runtime.sendMessage({
      type: "quickcal-widget",
      action: "batch-confirm",
      sessionId: sharedSessionId,
      operationId: operationId,
    }).then((result) => {
      pending = false;
      if (!alive) return;
      if (result && result.session) applyRemote(result.session, false);
      else render();
    }).catch(() => {
      pending = false;
      showStatus("QuickCalAI could not save the selected events.", true);
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
        pointerX: event.clientX,
        pointerY: event.clientY,
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
    // Keep card actions clickable; the input strip retains its existing drag behavior.
    // Include labels so batch checkboxes still toggle from their accessible label text.
    if (!bar.contains(event.target)) {
      if (event.target.closest("button, a, input, textarea, select, label, [contenteditable]")) return;
      event.preventDefault();
    }
    dragging = {
      kind: "move",
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      dx: event.clientX - rect.left,
      dy: event.clientY - rect.top,
      moved: false,
    };
  }

  function onPointerMove(event) {
    if (!dragging || event.pointerId !== dragging.pointerId) return;
    const api = globalThis.QuickCalLayout;
    if (!api) return;
    if (dragging.kind === "move") {
      if (!dragging.moved) {
        const distance = Math.hypot(event.clientX - dragging.startX, event.clientY - dragging.startY);
        if (distance < 5) return;
        dragging.moved = true;
        try {
          card.setPointerCapture(event.pointerId);
        } catch (error) {
          // Window listeners still keep the panel moving without capture.
        }
      }
      event.preventDefault();
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
    const moved = dragging.kind === "move" && dragging.moved;
    dragging = null;
    if (moved) {
      suppressBarClick = true;
      queueMicrotask(() => {
        suppressBarClick = false;
      });
    }
    publishLayout();
  }

  function onBarClick(event) {
    if (!suppressBarClick) return;
    suppressBarClick = false;
    event.preventDefault();
    event.stopImmediatePropagation();
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

  function confirmLookup() {
    if (pending || saving || !activeLookup || activeLookup.kind !== "confirm") return;
    if (shared) {
      const operationId = typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : "confirm-" + Date.now();
      pending = true;
      showStatus(activeLookup.action === "delete" ? "Deleting event\u2026" : "Updating event\u2026", false);
      render();
      chrome.runtime.sendMessage({
        type: "quickcal-widget",
        action: "confirm",
        sessionId: sharedSessionId,
        operationId: operationId,
      }).then((result) => {
        pending = false;
        if (!alive) return;
        if (result && result.session) applyRemote(result.session, false);
        else render();
      }).catch(() => {
        pending = false;
        showStatus("QuickCalAI could not update the shared session.", true);
        render();
      });
      return;
    }
  }

  function onInputKeyDown(event) {
    if (event.key === "Enter") enterDown = true;
    if (event.key !== "Enter") return;
    if (mode === "batch-clarifying" || mode === "reviewing" || mode === "batch-results") {
      if (event.repeat || event.isComposing || event.keyCode === 229) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (pending || saving || voicePhase === "recording" || voicePhase === "review" || voicePhase === "transcribing" || voicePhase === "permission") return;
      const text = input.value.trim();
      if (text) {
        suppressBatchConfirm = true;
        submit(text);
        return;
      }
      // Empty Enter never confirms a batch; only the Add selected button does.
      return;
    }
    const lookupApi = globalThis.QuickCalLookup;
    const action = lookupApi ? lookupApi.enterAction({
      repeat: event.repeat,
      composing: event.isComposing || event.keyCode === 229,
      armed: deleteArmed,
      text: input.value,
      mode: mode,
    }) : (event.repeat || event.isComposing ? "ignore" : (input.value.trim() ? "submit" : "ignore"));
    if (action === "ignore") {
      if (mode === "confirming") {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (pending || saving || voicePhase === "recording" || voicePhase === "review" || voicePhase === "transcribing" || voicePhase === "permission") return;
    if (voicePhase === "held") cancelVoice();
    if (action === "confirm") {
      deleteArmed = false;
      confirmLookup();
      return;
    }
    deleteArmed = false;
    submit(input.value.trim());
  }

  function onInputKeyUp(event) {
    if (event.key !== "Enter") return;
    enterDown = false;
    if (mode === "confirming") deleteArmed = true;
    if (mode === "batch-clarifying" || suppressBatchConfirm) {
      suppressBatchConfirm = false;
    }
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
    attachButton.classList.toggle("voice", active);
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
    if (document.visibilityState === "hidden") {
      if (onboardingDemoRun) {
        onboardingDemoPaused = true;
        (onboardingDemoRun.timers || []).forEach((id) => clearTimeout(id));
        onboardingDemoRun.timers = [];
      }
      return;
    }
    checkConnection();
    resumeOnboardingDemoIfNeeded();
    if (shared) {
      claimLeader().then(() => {
        if (inputDirty) publishInput(0);
      });
    }
  }

  function destroy() {
    resetInvitations();
    stopOnboardingDemo();
    if (!alive) return;
    alive = false;
    requestGeneration += 1;
    saveGeneration += 1;
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerUp);
    document.removeEventListener("keydown", onEscape, true);
    document.removeEventListener("pointerdown", onOutsidePointer, true);
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

  addPeople.addEventListener("click", () => {
    inviteForm.hidden = !inviteForm.hidden;
    addPeople.setAttribute("aria-expanded", String(!inviteForm.hidden));
    allowFocus = false;
    if (!inviteForm.hidden) guestEmail.focus();
  });
  inviteForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (inviteSending || !savedRecord || !inviteEventId || mode !== "saved") return;
    guestEmail.value = guestEmail.value.trim();
    if (!guestEmail.reportValidity()) return;
    const emails = [...new Set(guestEmail.value.split(",").map(email => email.trim().toLowerCase()))];
    if (emails.some(email => !email || email.length > 254)) {
      showInviteStatus("Enter valid email addresses separated by commas.", true);
      return;
    }
    const eventId = inviteEventId;
    const generation = ++inviteGeneration;
    inviteSending = true;
    guestEmail.disabled = true;
    sendInvite.disabled = true;
    sendInvite.textContent = "Sending…";
    showInviteStatus("", false);
    try {
      const result = await chrome.runtime.sendMessage({
        type: "quickcal-calendar", action: "invite", eventId,
        calendarId: savedRecord.calendarId || "primary",
        ...(emails.length === 1 ? { email: emails[0] } : { emails }),
      });
      if (!alive || generation !== inviteGeneration || inviteEventId !== eventId) return;
      if (result && result.ok) {
        const invited = result.emails || emails;
        showInviteStatus(result.alreadyInvited
          ? emails.join(", ") + (emails.length === 1 ? " is" : " are") + " already on the guest list."
          : (invited.length === 1 ? "Invitation sent to " : "Invitations sent to ") + invited.join(", ") + ".", false);
        guestEmail.value = "";
      } else {
        showInviteStatus(result && result.error || "The invitation was not confirmed. Check the event and try again.", true);
      }
    } catch (error) {
      if (alive && generation === inviteGeneration) showInviteStatus("The invitation was not confirmed. Check the event before trying again.", true);
    } finally {
      if (generation === inviteGeneration) {
        inviteSending = false;
        guestEmail.disabled = false;
        sendInvite.disabled = false;
        sendInvite.textContent = "Send";
      }
    }
  });
  // Enter submits only this form, never a calendar edit or another event.
  inviteForm.addEventListener("keydown", (event) => event.stopPropagation());
  inviteForm.addEventListener("keyup", (event) => event.stopPropagation());

  dismissButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    setOpen(false);
  });
  timeEdit.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    openSavedTimeMenu();
  });
  timeMenu.addEventListener("pointerdown", (event) => event.stopPropagation());
  attachButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    toggleDocs();
  });
  docsBrowse.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!docBusy()) docsInput.click();
  });
  docsInput.addEventListener("change", () => {
    const file = docsInput.files && docsInput.files[0];
    docsInput.value = "";
    if (file) uploadDocFile(file);
  });
  function dragHasFile(event) {
    const types = event.dataTransfer && event.dataTransfer.types;
    return !!types && Array.from(types).indexOf("Files") !== -1;
  }
  let dragDepth = 0;
  docsSheet.addEventListener("dragenter", (event) => {
    if (!dragHasFile(event)) return;
    event.preventDefault();
    event.stopPropagation();
    dragDepth += 1;
    docs.classList.add("dragging");
  });
  docsSheet.addEventListener("dragover", (event) => {
    if (!dragHasFile(event)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = docBusy() ? "none" : "copy";
  });
  docsSheet.addEventListener("dragleave", (event) => {
    if (!dragHasFile(event)) return;
    event.stopPropagation();
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) docs.classList.remove("dragging");
  });
  docsSheet.addEventListener("drop", (event) => {
    if (!dragHasFile(event)) return;
    event.preventDefault();
    event.stopPropagation();
    dragDepth = 0;
    docs.classList.remove("dragging");
    const file = event.dataTransfer.files && event.dataTransfer.files[0];
    if (file) uploadDocFile(file);
  });
  docsRemove.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (docBusy()) return;
    docLocalError = "";
    docEditing = null;
    sendDoc("doc-remove");
  });
  docsAnalyze.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    analyzeFromInput(input.value.trim());
  });
  docsCreate.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (docsCreate.disabled) return;
    docLocalError = "";
    sendDoc("doc-create", { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" });
  });
  // A time menu opened from the review list follows its field while the list
  // scrolls, and closes once that field scrolls out of view.
  docsBody.addEventListener("scroll", () => {
    if (!timeMenuState || !docsBody.contains(timeMenuState.trigger)) return;
    const area = docsBody.getBoundingClientRect();
    const field = timeMenuState.trigger.getBoundingClientRect();
    if (field.bottom < area.top || field.top > area.bottom) closeTimeMenu(false);
    else placeTimeMenu(timeMenuState.trigger);
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
    input.focus({ preventScroll: true });
  });
  addSelectedButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    confirmBatch();
  });
  cancelButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (activeLookup) {
      activeLookup = null;
      deleteArmed = false;
      if (shared) {
        chrome.runtime.sendMessage({ type: "quickcal-widget", action: "cancel-lookup", sessionId: sharedSessionId }).then((result) => {
          if (result && result.session) applyRemote(result.session, false);
        }).catch(() => {});
        return;
      }
      showInputMode();
      render();
      return;
    }
    if (mode === "batch-clarifying" && activeBatch) {
      if (shared) {
        chrome.runtime.sendMessage({
          type: "quickcal-widget",
          action: "batch-cancel-clarify",
          sessionId: sharedSessionId,
        }).then((result) => {
          if (result && result.session) applyRemote(result.session, false);
        }).catch(() => {});
        return;
      }
    }
    if (mode === "reviewing" || mode === "batch-results") {
      setOpen(false);
      return;
    }
    discardClarification();
  });
  deleteButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    deleteArmed = false;
    confirmLookup();
  });
  function openCalendarSettings(event) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    chrome.runtime.sendMessage({ type: "quickcal-calendar", action: "open-settings" }).catch(() => {});
  }
  connectButton.addEventListener("click", openCalendarSettings);
  connectRoute.addEventListener("click", openCalendarSettings);
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
  input.addEventListener("keyup", onInputKeyUp);
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
  card.addEventListener("pointerdown", onPointerDown);
  card.addEventListener("click", onBarClick, true);
  [resizeNw, resizeNe, resizeSw, resizeSe].forEach((button) => {
    button.addEventListener("pointerdown", onPointerDown);
    button.addEventListener("keydown", onResizeKey);
  });
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("pointercancel", onPointerUp);
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

  function presentConnectRoute(kind, message) {
    connectRoute.hidden = false;
    connectRoute.disabled = false;
    connectRoute.textContent =
      kind === "reconnect" ? "Reconnect Google Calendar" : "Connect Google Calendar";
    if (message && session.phase() !== "waking" && !selectionHold) {
      showStatus(message, true);
    }
  }

  function syncConnectFromStatus(result) {
    if (!result) return;
    const needsAccount = result.connected === false;
    const needsScopes = result.needsConflictScopes === true || result.needsReconnect === true;
    const needsApproval =
      result.connected === true && result.quickcalReady === false && !!result.message && !needsScopes;
    if (needsAccount) {
      presentConnectRoute("connect", "Connect Google Calendar to use QuickCalAI.");
      return;
    }
    if (needsScopes) {
      presentConnectRoute(
        "reconnect",
        result.message ||
          "Reconnect Google Calendar so QuickCalAI can check other calendars for conflicts."
      );
      return;
    }
    if (needsApproval) {
      presentConnectRoute("reconnect", result.message);
      return;
    }
    connectRoute.hidden = true;
    connectRoute.textContent = "Connect Google Calendar";
    if (
      status.textContent === "Connect Google Calendar to use QuickCalAI." ||
      /Reconnect Google Calendar so QuickCalAI can check/i.test(status.textContent)
    ) {
      clearStatus();
    }
  }

  function syncConnectFromSession(state) {
    const text = state && typeof state.statusText === "string" ? state.statusText : "";
    if (!text) return;
    if (/Connect Google Calendar/i.test(text) || /before using QuickCalAI/i.test(text)) {
      presentConnectRoute("connect", null);
      return;
    }
    if (/Reconnect Google Calendar/i.test(text) || /check other calendars for conflicts/i.test(text)) {
      presentConnectRoute("reconnect", null);
    }
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
    syncConnectFromStatus(result);
    if (mode === "failed" && !saving && draftEvent && !connectButton.hidden && result && result.connected === true && !result.needsConflictScopes) {
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

  stylesheet.addEventListener("load", async () => {
    await fontReady;
    if (!alive) return;
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
  document.addEventListener("pointerdown", onOutsidePointer, true);
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
