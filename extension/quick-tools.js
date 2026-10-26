import { canonicalUrl } from './url-identity.js';

export async function initializeQuickTools(setIdentity) {
  const $ = value => document.querySelector(value);
  const note = $('#quick-tools-status');
  const say = text => { note.textContent = text; note.hidden = false; };
  const send = async (type, data = {}) => {
    const result = await chrome.runtime.sendMessage({ type, ...data });
    if (!result?.ok) throw Error(result?.error || '后台未确认操作结果。');
    return result;
  };
  const tools = hash => chrome.tabs.create({ url: chrome.runtime.getURL(`tools.html${hash || ''}`) });
  const bind = (node, handler) => node.addEventListener('click', async () => {
    node.disabled = true;
    try { await handler(); } catch (error) { say(error.message); }
    finally { node.disabled = node.id === 'quick-undo' ? !undoAvailable : false; }
  });
  let loadGeneration = 0;
  let undoAvailable = false;
  async function refresh() {
    const generation = ++loadGeneration;
    const data = await send('LIBRARY_GET');
    if (generation !== loadGeneration) return;
    const list = $('#quick-favorites');
    list.replaceChildren();
    for (let slot = 1; slot <= 3; slot++) {
      const favorite = data.library.favorites[slot - 1];
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.empty = String(!favorite);
      button.textContent = favorite?.name || `入口 ${slot}`;
      button.title = favorite?.url || '点击工具箱配置此入口';
      bind(button, async () => { if (favorite) await send('FAVORITE_OPEN', { slot }); else await tools('#favorites'); });
      list.append(button);
    }
    $('#favorite-hint').textContent = data.library.favorites.some(Boolean) ? '已打开的页面会直接定位，无需重复打开' : '点击空白入口，添加你的常用网站';
    const available = (data.undo?.items || []).filter(item => item.status === 'available').length;
    undoAvailable = available > 0;
    $('#quick-undo').disabled = !undoAvailable;
    $('#quick-undo').textContent = available ? `恢复清理记录（${available}）` : '暂无可恢复的清理记录';
    const rules = data.library.dedupRules;
    const { duplicateAllowlist = [] } = await chrome.storage.local.get({ duplicateAllowlist: [] });
    setIdentity(url => { try { return duplicateAllowlist.includes(new URL(url).origin) ? null : canonicalUrl(url, rules); } catch { return null; } });
  }
  bind($('#open-tools'), () => tools());
  bind($('#undo-details'), () => tools('#recovery'));
  bind($('#quick-undo'), async () => {
    const result = await send('UNDO_RESTORE');
    say(`已恢复 ${result.restored} 个${result.failed ? `，失败 ${result.failed} 个` : ''}${result.interrupted ? '；部分操作中断，请到工具箱查看' : ''}。`);
    await refresh();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if ((area === 'local' && (changes.library || changes.cleanupUndo || changes.duplicateAllowlist)) || (area === 'session' && Object.keys(changes).some(key => /undo|cleanup/i.test(key)))) {
      refresh().catch(error => say(error.message));
    }
  });
  await refresh();
}
