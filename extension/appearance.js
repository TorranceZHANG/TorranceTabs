import { DEFAULT_PREFERENCES, validatePreferences } from './preferences.js';

const root = document.documentElement;
let preferences = { ...DEFAULT_PREFERENCES };
let saving = false;
const apply = value => {
  try { preferences = validatePreferences(value); } catch { preferences = { ...DEFAULT_PREFERENCES }; }
  root.dataset.theme = preferences.theme;
  root.dataset.density = preferences.density;
  for (const select of document.querySelectorAll('[data-preference]')) select.value = preferences[select.dataset.preference];
};
async function start() {
  try { apply((await chrome.storage.local.get({ preferences: DEFAULT_PREFERENCES })).preferences); } catch { apply(preferences); }
  const details = document.createElement('details'); details.className = 'appearance-controls';
  const summary = document.createElement('summary'); summary.textContent = '外观'; details.append(summary);
  for (const [key, label, choices] of [
    ['theme', '主题', [['system', '跟随系统'], ['light', '浅色'], ['dark', '深色']]],
    ['density', '密度', [['comfortable', '舒适'], ['compact', '紧凑']]],
  ]) {
    const wrapper = document.createElement('label'); wrapper.textContent = label;
    const select = document.createElement('select'); select.dataset.preference = key;
    for (const [value, text] of choices) { const option = document.createElement('option'); option.value = value; option.textContent = text; select.append(option); }
    select.value = preferences[key]; wrapper.append(select); details.append(wrapper);
    select.addEventListener('change', async () => {
      if (saving) { apply(preferences); return; }
      saving = true;
      const controls = [...document.querySelectorAll('[data-preference]')];
      const next = { ...preferences, [key]: select.value }; controls.forEach(control => { control.disabled = true; });
      try {
        const response = await chrome.runtime.sendMessage({ type: 'PREFERENCES_SAVE', preferences: next });
        if (!response?.ok) throw Error(response?.error || '外观保存失败');
        apply(response.preferences);
      } catch (error) { apply(preferences); message.textContent = error.message; }
      finally { saving = false; controls.forEach(control => { control.disabled = false; }); }
    });
  }
  const message = document.createElement('p'); message.className = 'small'; message.setAttribute('role', 'status'); details.append(message);
  (document.querySelector('.app-sidebar') || document.querySelector('.popup-shell') || document.body).append(details);
  chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.preferences) apply(changes.preferences.newValue); });
}
void start();
