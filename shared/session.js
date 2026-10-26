(function (root) {
  const NORMAL_KEY = "quickcalWidgetSession";
  const INCOGNITO_KEY = "quickcalWidgetSessionIncognito";

  function storageKey(incognito) {
    return incognito ? INCOGNITO_KEY : NORMAL_KEY;
  }

  function create(incognito) {
    return {
      sessionId: "s1",
      revision: 1,
      claim: 0,
      ownerTabId: null,
      inputSeq: 0,
      visible: false,
      incognito: !!incognito,
      layout: { scale: 1, left: null, top: null },
      input: "",
      mode: "input",
      clarification: null,
      savedRecord: null,
      draftEvent: null,
      draftText: "",
      event: null,
      statusText: "",
      statusError: false,
      operation: null,
      voice: null,
    };
  }

  function cleared(state) {
    return {
      input: "",
      mode: "input",
      clarification: null,
      savedRecord: null,
      draftEvent: null,
      draftText: "",
      event: null,
      statusText: "",
      statusError: false,
      operation: null,
      voice: null,
    };
  }

  function dismiss(state) {
    return Object.assign({}, state, cleared(state), {
      visible: false,
      sessionId: state.sessionId + "." + String(state.revision + 1),
      revision: state.revision + 1,
      claim: state.claim + 1,
      ownerTabId: null,
      inputSeq: 0,
    });
  }

  function openReset(state) {
    return Object.assign({}, state, cleared(state), {
      visible: true,
      voice: state.voice,
      sessionId: state.sessionId + "." + String(state.revision + 1),
      revision: state.revision + 1,
      claim: state.claim + 1,
      ownerTabId: state.ownerTabId,
      inputSeq: 0,
    });
  }

  function show(state) {
    if (state.visible) return state;
    return Object.assign({}, state, { visible: true, revision: state.revision + 1 });
  }

  function claim(state, tabId) {
    if (state.ownerTabId === tabId && state.claim > 0) {
      return { accepted: true, state: state };
    }
    return {
      accepted: true,
      state: Object.assign({}, state, {
        ownerTabId: tabId,
        claim: state.claim + 1,
        revision: state.revision + 1,
      }),
    };
  }

  function patchInput(state, action) {
    if (!state.visible || action.sessionId !== state.sessionId) return { accepted: false, state: state };
    if (typeof action.seq !== "number" || action.seq <= state.inputSeq) return { accepted: false, state: state };
    const sameTab = state.ownerTabId == null || state.ownerTabId === action.tabId;
    if (!sameTab || action.claim !== state.claim) return { accepted: false, state: state };
    const input = typeof action.input === "string" ? action.input.slice(0, 2000) : "";
    return {
      accepted: true,
      state: Object.assign({}, state, {
      input: input,
      inputSeq: action.seq,
      ownerTabId: action.tabId,
      revision: state.revision + 1,
      }),
    };
  }

  function setLayout(state, layout) {
    const scale = layout && isFinite(layout.scale) && layout.scale > 0 ? layout.scale : state.layout.scale;
    const left = layout && typeof layout.left === "number" ? layout.left : null;
    const top = layout && typeof layout.top === "number" ? layout.top : null;
    return Object.assign({}, state, {
      layout: { scale: scale, left: left, top: top },
      revision: state.revision + 1,
    });
  }

  function beginOperation(state, kind, id, sessionId) {
    if (!state.visible || sessionId !== state.sessionId || state.operation) {
      return { accepted: false, state: state };
    }
    return {
      accepted: true,
      state: Object.assign({}, state, {
        operation: { id: id, kind: kind, sessionId: state.sessionId },
        revision: state.revision + 1,
      }),
    };
  }

  function operationCurrent(state, operation) {
    return !!(
      state.operation &&
      operation &&
      state.operation.id === operation.id &&
      state.operation.sessionId === state.sessionId
    );
  }

  function finishOperation(state, operation, patch) {
    if (!operationCurrent(state, operation)) return { accepted: false, state: state };
    return {
      accepted: true,
      state: Object.assign({}, state, patch || {}, {
        operation: null,
        revision: state.revision + 1,
      }),
    };
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
    };
  }

  function noteClarification(state, event, sourceText) {
    const original = state.clarification && state.clarification.originalText
      ? state.clarification.originalText
      : sourceText;
    return Object.assign({}, state, {
      mode: "clarifying",
      event: event,
      clarification: { originalText: original, draft: draftFromEvent(event) },
      savedRecord: null,
      draftEvent: null,
      input: "",
      statusText: "",
      statusError: false,
      operation: null,
    });
  }

  root.QuickCalSession = {
    NORMAL_KEY: NORMAL_KEY,
    INCOGNITO_KEY: INCOGNITO_KEY,
    storageKey: storageKey,
    create: create,
    dismiss: dismiss,
    openReset: openReset,
    show: show,
    claim: claim,
    patchInput: patchInput,
    setLayout: setLayout,
    beginOperation: beginOperation,
    operationCurrent: operationCurrent,
    finishOperation: finishOperation,
    noteClarification: noteClarification,
    draftFromEvent: draftFromEvent,
  };
})(typeof globalThis !== "undefined" ? globalThis : self);
