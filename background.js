// Open links in the background (like a native Cmd+click). true switches to them right away.
const FOCUS_NEW_TAB = false;

function isAllowedUrl(url) {
  try {
    return /^https?:$/.test(new URL(url).protocol);
  } catch {
    return false;
  }
}

async function switchTab(sender, dir) {
  if (dir !== 1 && dir !== -1) return;

  const tabs = (await browser.tabs.query({ windowId: sender.tab.windowId }))
    .filter((tab) => !tab.hidden)
    .sort((a, b) => a.index - b.index);

  if (tabs.length < 2) return;

  const current = tabs.findIndex((tab) => tab.active);
  if (current === -1) return;

  const next = (current + dir + tabs.length) % tabs.length;
  await browser.tabs.update(tabs[next].id, { active: true });
}

async function closeTab(sender) {
  const { id, index, windowId } = sender.tab;

  const left = (await browser.tabs.query({ windowId }))
    .filter((tab) => !tab.hidden && tab.index < index)
    .sort((a, b) => b.index - a.index)[0];

  if (left) await browser.tabs.update(left.id, { active: true });
  await browser.tabs.remove(id);
}

async function undoCloseTab() {
  await browser.sessions.restore();
}

async function reloadTab(sender) {
  await browser.tabs.reload(sender.tab.id);
}

// The copy opens next to the current tab without stealing focus, like a link opened in the background.
async function duplicateTab(sender) {
  await browser.tabs.duplicate(sender.tab.id, { active: false, index: sender.tab.index + 1 });
}

async function openLink(sender, url) {
  // The content script lives in an untrusted page — re-check the scheme here too.
  if (!isAllowedUrl(url)) return;

  await browser.tabs.create({
    url,
    index: sender.tab.index + 1,
    openerTabId: sender.tab.id,
    active: FOCUS_NEW_TAB
  });
}

browser.runtime.onMessage.addListener((message, sender) => {
  if (!sender.tab) return;

  switch (message.type) {
    case "switchTab":
      return switchTab(sender, message.dir);
    case "closeTab":
      return closeTab(sender);
    case "undoCloseTab":
      return undoCloseTab();
    case "reloadTab":
      return reloadTab(sender);
    case "duplicateTab":
      return duplicateTab(sender);
    case "openLink":
      return openLink(sender, message.url);
  }
});
