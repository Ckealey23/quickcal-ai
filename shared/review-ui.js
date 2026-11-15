(function (root) {
  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text != null) element.textContent = text;
    return element;
  }
  function button(text, click, className = "review-button") {
    const element = node("button", className, text);
    element.type = "button";
    element.addEventListener("click", click);
    return element;
  }
  function clock(value) {
    return root.QuickCalPreview.formatTimeRange(value, null);
  }
  let activePicker = null;
  function closePicker() { if (activePicker) activePicker(); }
  function timePicker(value, label, change, shadow) {
    const trigger = button(value ? clock(value) : label + "…", () => {
      if (trigger.getAttribute("aria-expanded") === "true") { closePicker(); return; }
      closePicker();
      const popup = node("div", "time-popup");
      if (value && !root.QuickCalItems.timeOptions().includes(value)) popup.append(node("p", "time-current", "Current: " + clock(value) + " (unchanged)"));
      const list = node("div", "time-options");
      list.setAttribute("role", "listbox");
      list.setAttribute("aria-label", label);
      list.tabIndex = 0;
      const values = root.QuickCalItems.timeOptions();
      let index = value ? Math.round((Number(value.slice(0, 2)) * 60 + Number(value.slice(3))) / 5) % 288 : 108;
      const choices = values.map((time, i) => {
        const option = node("div", "time-option", clock(time));
        option.id = "qc-time-" + i;
        option.setAttribute("role", "option");
        option.setAttribute("aria-selected", String(time === value));
        option.addEventListener("click", () => { closePicker(); change(time); });
        list.append(option);
        return option;
      });
      function focusIndex() {
        choices.forEach((choice, i) => choice.classList.toggle("time-active", i === index));
        list.setAttribute("aria-activedescendant", choices[index].id);
        list.scrollTop = Math.max(0, choices[index].offsetTop - list.offsetTop - 60);
      }
      list.addEventListener("keydown", event => {
        if (event.key === "Tab") { closePicker(); return; }
        if (!["ArrowDown", "ArrowUp", "Home", "End", "PageDown", "PageUp", "Enter", " ", "Escape"].includes(event.key)) return;
        event.preventDefault(); event.stopPropagation();
        if (event.key === "Escape") { closePicker(); trigger.focus(); return; }
        if (event.key === "Enter" || event.key === " ") { const time = values[index]; closePicker(); change(time); return; }
        if (event.key === "Home") index = 0;
        else if (event.key === "End") index = 287;
        else index = Math.max(0, Math.min(287, index + ({ ArrowDown: 1, ArrowUp: -1, PageDown: 12, PageUp: -12 }[event.key] || 0)));
        focusIndex();
      });
      popup.append(list);
      shadow.append(popup);
      const rect = trigger.getBoundingClientRect();
      popup.style.left = Math.max(8, Math.min(window.innerWidth - 180, rect.left)) + "px";
      popup.style.top = Math.max(8, Math.min(window.innerHeight - 220, rect.bottom + 4)) + "px";
      trigger.setAttribute("aria-expanded", "true");
      const outside = event => { if (!event.composedPath().includes(popup) && !event.composedPath().includes(trigger)) closePicker(); };
      document.addEventListener("pointerdown", outside, true);
      const dismiss = () => closePicker();
      window.addEventListener("resize", dismiss);
      activePicker = () => {
        popup.remove(); trigger.setAttribute("aria-expanded", "false");
        document.removeEventListener("pointerdown", outside, true);
        window.removeEventListener("resize", dismiss); activePicker = null;
      };
      list.focus(); focusIndex();
    }, "time-trigger");
    trigger.setAttribute("aria-label", label + (value ? ": " + clock(value) : ": not specified"));
    trigger.setAttribute("aria-haspopup", "listbox");
    trigger.setAttribute("aria-expanded", "false");
    return trigger;
  }
  function create({ bar, card, input, shadow, send, reset, expand }) {
    let state = null, signature = "", fileGeneration = 0;
    const paperclip = button("", () => {
      expand();
      act("upload-panel", { open: !state?.uploadOpen });
    }, "attachment-button");
    paperclip.setAttribute("aria-label", "Upload document");
    paperclip.title = "Upload document";
    paperclip.setAttribute("aria-expanded", "false");
    paperclip.setAttribute("aria-controls", "quickcal-upload");
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("width", "18"); svg.setAttribute("height", "18"); svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "M8 12.5l7-7a3.5 3.5 0 015 5l-9 9a5 5 0 01-7-7l9-9M8 12.5l-1 1a2 2 0 003 3l8-8");
    path.setAttribute("fill", "none"); path.setAttribute("stroke", "currentColor"); path.setAttribute("stroke-width", "1.6"); path.setAttribute("stroke-linecap", "round");
    svg.append(path); paperclip.append(svg); bar.insertBefore(paperclip, input);
    const upload = node("section", "upload-panel"); upload.id = "quickcal-upload"; upload.inert = true;
    const uploadInner = node("div", "upload-inner");
    const drop = node("div", "document-drop");
    drop.append(node("span", "", "Drag and drop a file here"));
    const fileInput = node("input"); fileInput.type = "file"; fileInput.accept = ".pdf,.docx,.txt"; fileInput.hidden = true;
    const browse = button("Browse Files", () => fileInput.click());
    drop.append(browse, node("small", "", "PDF, DOCX, TXT · Up to 2 MB"), fileInput);
    const attached = node("div", "attached-file"); attached.hidden = true;
    const name = node("span", "attached-name");
    const remove = button("Remove", () => { fileGeneration++; act("attachment", { file: null }); });
    attached.append(node("span", "file-mark", "▤"), name, remove);
    const analyze = button("Analyze document", () => submit(input.value.trim()), "review-button review-primary");
    const hint = node("p", "document-hint", "Use the main input to describe what to find, or analyze without instructions. The document is sent to QuickCalAI and its AI provider for analysis.");
    const error = node("p", "review-error"); error.hidden = true; error.setAttribute("role", "alert");
    uploadInner.append(drop, attached, hint, analyze); upload.append(uploadInner);
    const indicator = node("p", "attachment-indicator"); indicator.hidden = true;
    const review = node("section", "document-review"); review.hidden = true; review.setAttribute("aria-label", "Review proposed events and tasks");
    card.insertBefore(upload, bar.nextSibling);
    card.insertBefore(indicator, upload.nextSibling);
    card.insertBefore(review, indicator.nextSibling);
    card.insertBefore(error, review);
    function showError(message) { error.textContent = message; error.hidden = !message; }
    async function act(action, payload = {}) {
      showError("");
      try {
        const result = await send(action, payload);
        if (!result || !result.ok) throw new Error(result?.error || "QuickCalAI could not update this request.");
        return result;
      } catch (err) { showError(err.message); }
    }
    async function selectFile(file) {
      if (state?.operation) return;
      const problem = root.QuickCalItems.fileProblem(file);
      if (problem) { showError(problem); return; }
      const generation = ++fileGeneration;
      showError(""); name.textContent = "Reading file…";
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        let binary = "";
        for (let pos = 0; pos < bytes.length; pos += 8192) binary += String.fromCharCode(...bytes.subarray(pos, pos + 8192));
        if (generation !== fileGeneration) return;
        await act("attachment", { file: { name: file.name, data: btoa(binary) } });
      } catch (_) { showError("The file could not be read. Try selecting it again."); }
    }
    fileInput.addEventListener("change", () => { if (fileInput.files[0]) selectFile(fileInput.files[0]); fileInput.value = ""; });
    drop.addEventListener("dragover", event => { event.preventDefault(); drop.classList.add("drag-over"); });
    drop.addEventListener("dragleave", () => drop.classList.remove("drag-over"));
    drop.addEventListener("drop", event => {
      event.preventDefault(); event.stopPropagation(); drop.classList.remove("drag-over");
      if (event.dataTransfer.files.length !== 1) { showError("Choose one document at a time."); return; }
      selectFile(event.dataTransfer.files[0]);
    });
    function submit(text) {
      if (!state?.attachment || state?.operation) return false;
      act("analyze-document", { text, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" });
      return true;
    }
    function edit(row, target) {
      closePicker();
      const item = { ...row.item };
      const form = node("form", "proposal-editor");
      function field(title, key, type = "text") {
        const label = node("label", "review-label", title);
        const control = node(key === "description" ? "textarea" : "input", "review-input");
        if (control.tagName === "INPUT") control.type = type;
        control.value = item[key] || "";
        if (type === "text") control.maxLength = key === "description" ? 4000 : key === "title" ? 200 : 100;
        control.addEventListener("input", () => { item[key] = control.value || null; });
        label.append(control); form.append(label); return control;
      }
      field("Title", "title").required = true;
      const kindLabel = node("label", "review-label", "Create as");
      const kind = node("select", "review-input");
      for (const value of ["event", "task"]) { const option = node("option", "", value === "event" ? "Calendar event" : "Google Task"); option.value = value; kind.append(option); }
      kind.value = item.kind;
      kind.addEventListener("change", () => { item.kind = kind.value; if (item.kind === "task") { item.recurrence = null; item.allDay = false; } });
      kindLabel.append(kind); form.append(kindLabel);
      field("Date / task due date", "date", "date"); field("End date (optional, inclusive)", "endDate", "date");
      const timeRow = node("div", "review-times");
      function timeField(key, title) {
        const wrap = node("span");
        const repaint = () => { wrap.replaceChildren(timePicker(item[key], title, value => { item[key] = value; item.durationDefaulted = false; repaint(); }, shadow), button("Clear", () => { item[key] = null; item.durationDefaulted = false; repaint(); }, "review-clear")); };
        repaint(); timeRow.append(wrap);
      }
      timeField("startTime", "Start / due time"); timeField("endTime", "End time"); form.append(timeRow);
      const allDayLabel = node("label", "review-check", "");
      const allDay = node("input"); allDay.type = "checkbox"; allDay.checked = item.allDay;
      allDay.addEventListener("change", () => { item.allDay = allDay.checked; });
      allDayLabel.append(allDay, document.createTextNode(" All-day event (only if intended)")); form.append(allDayLabel);
      field("Time zone", "timeZone"); field("Description", "description"); field("Location", "location");
      if (item.uncertainty) {
        form.append(node("p", "review-warning", item.uncertainty));
        const resolved = node("label", "review-check"); const check = node("input"); check.type = "checkbox";
        check.addEventListener("change", () => { item.uncertainty = check.checked ? "" : row.item.uncertainty; });
        resolved.append(check, document.createTextNode(" I checked the source and resolved this uncertainty")); form.append(resolved);
      }
      const formError = node("p", "review-error"); formError.setAttribute("role", "alert");
      const save = node("button", "review-button review-primary", "Save changes"); save.type = "submit";
      form.append(formError, save, button("Cancel", () => { signature = ""; update(state); }));
      form.addEventListener("submit", event => {
        event.preventDefault();
        try { const normalized = root.QuickCalItems.normalize(item); act("review-item", { id: row.id, item: normalized }); }
        catch (err) { formError.textContent = err.message; }
      });
      target.replaceChildren(form); form.querySelector("input").focus();
    }
    function update(next) {
      state = next;
      const uploadOpen = !!next?.uploadOpen;
      upload.classList.toggle("is-open", uploadOpen); upload.inert = !uploadOpen;
      upload.setAttribute("aria-hidden", String(!uploadOpen));
      paperclip.setAttribute("aria-expanded", String(uploadOpen));
      const file = next?.attachment;
      const busy = !!next?.operation;
      const isCreating = next?.operation?.kind === "review-create";
      paperclip.classList.toggle("has-attachment", !!file);
      attached.hidden = !file;
      name.textContent = file ? file.name + " · " + Math.max(1, Math.round(file.size / 1024)) + " KB" : "";
      name.title = file?.name || "";
      browse.disabled = busy; remove.disabled = busy; analyze.disabled = !file || busy;
      analyze.textContent = next?.operation?.kind === "document" ? "Analyzing…" : next?.review?.source === "document" ? "Refine results" : "Analyze document";
      indicator.hidden = !file || uploadOpen;
      indicator.textContent = file ? "Attached: " + file.name : "";
      indicator.title = file?.name || "";
      paperclip.disabled = isCreating;
      const model = next?.mode === "review" ? next.review : null;
      review.hidden = !model;
      if (!model) { signature = ""; return; }
      const nextSignature = JSON.stringify([model, busy]);
      if (signature === nextSignature) return;
      signature = nextSignature; closePicker();
      const scroll = review.querySelector(".proposal-list")?.scrollTop || 0;
      review.replaceChildren();
      const heading = node("div", "review-heading");
      heading.append(node("strong", "", model.source === "document" ? "Review extracted items" : "Review before creating"), button("New request", reset));
      review.append(heading, node("p", "review-help", "Approve each item to include it. Changes reset approval."));
      if (model.warning) review.append(node("p", "review-warning", model.warning));
      const list = node("div", "proposal-list");
      if (!model.rows.length) list.append(node("p", "review-help", "No matching dates or activities found. Refine the instructions in the main input."));
      model.rows.forEach(row => {
        const item = row.item, done = row.status === "created";
        const article = node("article", "proposal"); article.dataset.decision = row.decision;
        article.append(node("span", "proposal-type", item.kind === "task" ? "Google Task" : "Calendar event"), node("strong", "proposal-title", item.title || "Untitled item"));
        if (item.category) article.append(node("small", "review-category", item.category));
        article.append(node("p", "proposal-date", item.date ? root.QuickCalPreview.formatFullDate(item.date) + (item.endDate && item.endDate !== item.date ? " – " + root.QuickCalPreview.formatFullDate(item.endDate) : "") : item.kind === "task" ? "No due date" : "Date needed"));
        const details = node("div", "review-times");
        if (item.allDay && item.kind === "event") details.textContent = "All day";
        else {
          const updateTime = (key, value) => act("review-item", { id: row.id, item: { ...item, [key]: value, durationDefaulted: false } });
          const start = timePicker(item.startTime, item.kind === "task" ? "Due time (saved in notes)" : "Start time", value => updateTime("startTime", value), shadow);
          start.disabled = busy || done || row.uncertain || row.status === "failed"; details.append(start);
          if (item.kind === "event") { details.append(document.createTextNode("–")); const end = timePicker(item.endTime, "End time", value => updateTime("endTime", value), shadow); end.disabled = busy || done || row.status === "failed"; details.append(end); }
        }
        article.append(details, node("small", "review-zone", item.timeZone));
        if (item.durationDefaulted) article.append(node("small", "review-zone", "1-hour default"));
        if (item.recurrence) article.append(node("p", "review-help", root.QuickCalSchedule.recurrenceScheduleText(item.recurrence) + " · " + root.QuickCalSchedule.seriesEndText(item.recurrence)));
        if (item.description) article.append(node("p", "proposal-description", item.description));
        if (item.kind === "task" && item.startTime) article.append(node("p", "review-help", "Google Tasks saves due dates only. This time is preserved in notes; it does not set an alarm."));
        if (item.sourceContext) { const source = node("details", "proposal-source"); source.append(node("summary", "", "Source context"), node("p", "", item.sourceContext)); article.append(source); }
        const problem = root.QuickCalItems.problem(item);
        if (problem && !done) article.append(node("p", "review-warning", item.uncertainty || problem));
        if (row.error) article.append(node("p", "review-error", row.error));
        const controls = node("div", "proposal-actions");
        if (!done) {
          const approve = button(row.decision === "approved" ? "Approved ✓" : "Approve", () => act("review-item", { id: row.id, decision: row.decision === "approved" ? "pending" : "approved" }));
          approve.setAttribute("aria-pressed", String(row.decision === "approved")); approve.disabled = busy || !!problem;
          const skip = button(row.decision === "skipped" ? "Skipped" : "Skip", () => act("review-item", { id: row.id, decision: row.decision === "skipped" ? "pending" : "skipped" })); skip.disabled = busy;
          const editButton = button("Edit", () => edit(row, article)); editButton.disabled = busy || row.uncertain || row.status === "failed";
          controls.append(approve, skip, editButton);
        }
        controls.append(node("span", "proposal-status", done ? "Created ✓" : row.status === "failed" ? "Failed" : row.decision === "pending" ? "Unreviewed" : row.decision === "approved" ? "Approved" : "Skipped"));
        if (done && row.result?.htmlLink) {
          const href = root.QuickCalPreview.calendarViewLink(row.result.htmlLink);
          if (href) { const link = node("a", "review-button", "View"); link.href = href; link.target = "_blank"; link.rel = "noopener noreferrer"; controls.append(link); }
        }
        article.append(controls); list.append(article);
      });
      review.append(list); list.scrollTop = scroll;
      const approved = model.rows.filter(row => row.decision === "approved" && row.status !== "created");
      const events = approved.filter(row => row.item.kind === "event").length, tasks = approved.length - events;
      const label = [events ? events + " approved event" + (events === 1 ? "" : "s") : "", tasks ? tasks + " approved task" + (tasks === 1 ? "" : "s") : ""].filter(Boolean).join(" and ");
      const createButton = button(busy ? "Working…" : "Create " + (label || "approved items"), () => act("create-approved"), "review-button review-primary review-create");
      createButton.disabled = busy || !approved.length; review.append(createButton);
      heading.querySelector("button").disabled = busy;
    }
    return { update, submit, hasAttachment: () => !!state?.attachment, expanded: () => !!(state?.uploadOpen || state?.attachment || (state?.mode === "review" && state?.review)), busy: () => !!state?.operation, close: closePicker, destroy: closePicker };
  }
  root.QuickCalReviewUI = { create, timePicker };
})(typeof globalThis !== "undefined" ? globalThis : self);
