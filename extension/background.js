chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'NAVIGATE') {
    chrome.tabs.update(message.tabId, { url: message.url }, () => {
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message.type === 'GET_ACTIVE_TAB') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      sendResponse({ tabId: tabs[0]?.id, url: tabs[0]?.url });
    });
    return true;
  }

  if (message.type === 'EXECUTE_CONTENT_SCRIPT') {
    chrome.tabs.sendMessage(message.tabId, message.payload, (response) => {
      if (chrome.runtime.lastError) {
        chrome.scripting.executeScript({
          target: { tabId: message.tabId },
          files: ['content.js']
        }, () => {
          setTimeout(() => {
            chrome.tabs.sendMessage(message.tabId, message.payload, sendResponse);
          }, 500);
        });
      } else {
        sendResponse(response);
      }
    });
    return true;
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'complete') {
    chrome.runtime.sendMessage({
      type: 'TAB_UPDATED',
      tabId,
      url: changeInfo.url
    }).catch(() => {});
  }
});
