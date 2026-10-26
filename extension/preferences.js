export const DEFAULT_PREFERENCES = Object.freeze({ theme: 'system', density: 'comfortable' });
export function validatePreferences(value = DEFAULT_PREFERENCES) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['theme', 'density'].includes(key))
    || !['system', 'light', 'dark'].includes(value.theme)
    || !['comfortable', 'compact'].includes(value.density)) throw Error('外观设置无效。');
  return { theme: value.theme, density: value.density };
}
