async function favorites() {
  const box = document.querySelector('#panel-favorites'); box.replaceChildren();
  try {
    const response = await chrome.runtime.sendMessage({ type: 'LIBRARY_GET' });
    if (!response?.ok) throw Error(response?.error || '读取失败');
    for (let index = 0; index < 3; index++) {
      const favorite = response.library.favorites[index];
      const button = document.createElement('button'); button.textContent = favorite?.name || `设置入口 ${index + 1}`;
      button.title = favorite?.url || '在工具箱设置常用入口';
      button.addEventListener('click', async () => {
        if (!favorite) { await chrome.tabs.create({ url: chrome.runtime.getURL('tools.html#favorites') }); return; }
        const result = await chrome.runtime.sendMessage({ type: 'FAVORITE_OPEN', slot: index + 1 });
        if (!result?.ok) { const status = document.querySelector('#status'); status.textContent = result?.error || '打开失败'; status.hidden = false; }
      }); box.append(button);
    }
  } catch (error) { const message = document.createElement('p'); message.textContent = error.message; box.append(message); }
}
void favorites();
chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.library) void favorites(); });
document.querySelector('#tab-search').focus();
