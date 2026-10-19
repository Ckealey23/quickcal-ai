(function (root) {
  const MAX_TEXT_LENGTH = 2000;
  const BUSY_MESSAGE =
    "QuickCalAI is still working on the current event. Try the selection again when it finishes.";
  const CONFIRM_MESSAGE = "Replace your current text with the selection?";

  function formatCount(value) {
    return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }

  function planSelection(input) {
    const source = input || {};
    const operationId = typeof source.operationId === "string" ? source.operationId.trim() : "";
    if (!operationId) return { action: "ignore" };
    if (source.seen && typeof source.seen.has === "function" && source.seen.has(operationId)) {
      return { action: "ignore" };
    }
    const maxLength = source.maxLength > 0 ? source.maxLength : MAX_TEXT_LENGTH;
    const text = typeof source.text === "string" ? source.text.trim() : "";
    if (source.tooLong === true || text.length > maxLength) {
      return {
        action: "tooLong",
        operationId: operationId,
        message:
          "Select a shorter passage. QuickCalAI can read " + formatCount(maxLength) + " characters or fewer.",
      };
    }
    if (!text) return { action: "ignore", operationId: operationId };
    if (source.busy) return { action: "busy", operationId: operationId, message: BUSY_MESSAGE };
    if (source.draft) {
      return { action: "confirm", operationId: operationId, text: text, message: CONFIRM_MESSAGE };
    }
    return { action: "submit", operationId: operationId, text: text, newEvent: true };
  }

  root.QuickCalSelection = {
    MAX_TEXT_LENGTH: MAX_TEXT_LENGTH,
    planSelection: planSelection,
  };
})(typeof globalThis !== "undefined" ? globalThis : self);
