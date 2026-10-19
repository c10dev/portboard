// Where the 설정 modal is in the URL (docs/settings/): only the hash, #settings/<section>, over whatever page is open.
// The pages that read their own hash (app.js: the selected port; service.js, dev.js, devices.js: what to show) leave a
// settings hash alone (isSettingsHash). The old settings.html and its anchors (#remote, from the consent page and the
// checklist) land on the same sections: settings.html redirects, and a click on such a link opens the modal in place.

/** The sections in menu order and their names (features/settings-modal.js has their content) */
export const SETTINGS_LABELS = {
  start: '시작하기',
  remote: '원격 커넥터',
  'write-devices': '쓰기 허용 기기',
  'port-rules': '포트 규칙',
  notify: '알림',
  claude: 'Claude 세션',
  secrets: '비밀값',
  display: '화면',
  about: '정보',
};

export const SETTINGS_IDS = Object.keys(SETTINGS_LABELS);

export const DEFAULT_SECTION = 'start';

export const settingsHash = (id) => `#settings/${id}`;

/** '#settings' → 'start', '#settings/remote' → 'remote', an unknown section → 'start'; any other hash → null */
export function settingsSection(hash) {
  const m = /^#settings(?:\/([\w-]*))?$/.exec(String(hash ?? ''));
  if (!m) return null;
  return SETTINGS_IDS.includes(m[1]) ? m[1] : DEFAULT_SECTION;
}

export const isSettingsHash = (hash) => settingsSection(hash) !== null;

/** settings.html's hash (#remote, #settings/remote or none) → the section */
export function legacySection(hash) {
  const id = String(hash ?? '').replace(/^#(settings\/?)?/, '');
  return SETTINGS_IDS.includes(id) ? id : DEFAULT_SECTION;
}

/**
 * The section a link opens, or null when it isn't one: settings.html[#anchor] on this origin, or #settings[/id] on
 * this page. base: the page's URL.
 */
export function linkSection(href, base) {
  if (href == null || href === '') return null;
  let u;
  let b;
  try {
    b = new URL(base);
    u = new URL(href, b);
  } catch {
    return null;
  }
  if (u.origin !== b.origin) return null;
  if (/\/settings\.html$/.test(u.pathname)) return legacySection(u.hash);
  if (u.pathname === b.pathname && u.search === b.search) return settingsSection(u.hash);
  return null;
}
