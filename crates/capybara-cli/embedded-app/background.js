// Capybara Chrome Extension - Background Service Worker
// Opens a full-page tab when the extension icon is clicked

chrome.action.onClicked.addListener(() => {
  const url = chrome.runtime.getURL('index.html');
  // Reuse existing Capybara tab if already open
  chrome.tabs.query({ url }, (tabs) => {
    if (tabs.length > 0) {
      chrome.tabs.update(tabs[0].id, { active: true });
      chrome.windows.update(tabs[0].windowId, { focused: true });
    } else {
      chrome.tabs.create({ url });
    }
  });
});
