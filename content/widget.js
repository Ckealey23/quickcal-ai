(() => {
  const HOST_ID = "quickcal-ai-host";
  const STATE_KEY = "__quickcalAi";

  function paintHost(host, visible) {
    host.dataset.open = visible ? "true" : "false";
    host.style.cssText = [
      "position:fixed",
      "right:24px",
      "bottom:24px",
      "z-index:2147483647",
      "width:min(420px, calc(100vw - 48px))",
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

  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "close";
  closeButton.setAttribute("aria-label", "Close QuickCalAI");
  closeButton.title = "Close";
  closeButton.textContent = "\u00d7";

  const bar = document.createElement("div");
  bar.className = "bar";

  const input = document.createElement("input");
  input.id = "quickcal-input";
  input.type = "text";
  input.className = "input";
  input.placeholder = "Coffee with Alex tomorrow at 10 AM";
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

  bar.append(input, micButton);
  shell.append(closeButton, bar);

  const stylesheet = document.createElement("link");
  stylesheet.rel = "stylesheet";
  stylesheet.href = chrome.runtime.getURL("content/widget.css");
  shadow.append(stylesheet, shell);

  let open = true;
  let styled = false;
  let alive = true;

  function focusInput() {
    input.focus();
  }

  function render() {
    paintHost(host, styled && open);
    if (styled && open) focusInput();
  }

  function onEscape(event) {
    if (event.key !== "Escape" || host.dataset.open !== "true") return;
    event.preventDefault();
    event.stopPropagation();
    open = false;
    render();
  }

  function onInputKeyDown(event) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    event.stopPropagation();
  }

  function destroy() {
    if (!alive) return;
    alive = false;
    document.removeEventListener("keydown", onEscape, true);
    host.remove();
    if (globalThis[STATE_KEY] && globalThis[STATE_KEY].destroy === destroy) {
      delete globalThis[STATE_KEY];
    }
  }

  closeButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    open = false;
    render();
  });
  input.addEventListener("keydown", onInputKeyDown);

  stylesheet.addEventListener("load", () => {
    styled = true;
    render();
  });

  stylesheet.addEventListener("error", () => {
    console.info("QuickCalAI: the input bar styles failed to load.");
    destroy();
  });

  document.addEventListener("keydown", onEscape, true);
  document.documentElement.appendChild(host);
  render();

  globalThis[STATE_KEY] = {
    toggle() {
      open = !open;
      render();
    },
    destroy,
  };
})();
