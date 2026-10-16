const SUPPORTED_PAGE = /^https?:\/\//i;

function canInject(url) {
  return typeof url === "string" && SUPPORTED_PAGE.test(url);
}

function reportBlocked(error) {
  const detail = error ? " " + error.message : "";
  console.info(
    "QuickCalAI: open a normal http or https webpage. Chrome blocks the input bar on browser pages." +
      detail
  );
}

chrome.action.onClicked.addListener((tab) => {
  if (!tab || tab.id == null || !canInject(tab.url)) {
    reportBlocked();
    return;
  }

  try {
    chrome.scripting
      .executeScript({
        target: { tabId: tab.id },
        files: ["content/widget.js"],
      })
      .catch(reportBlocked);
  } catch (error) {
    reportBlocked(error);
  }
});
