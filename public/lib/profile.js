// @ts-check
// A preview instance (any port but 8790, see src/core/paths.ts) says so in the header and the tab title,
// so it isn't mistaken for production. GET /api/health → {profile, port}. Shared by every page.

import { tryJSON } from './api.js';
import { t } from './i18n.js';

export async function showProfile() {
  const health = await tryJSON('/api/health');
  if (health?.profile !== 'preview') return;
  const h1 = document.querySelector('.top .brand h1');
  if (!h1 || document.querySelector('.profile-badge')) return;
  const badge = document.createElement('span');
  badge.className = 'profile-badge';
  badge.textContent = t('profile.badge', { port: health.port });
  badge.title = t('profile.badge.title');
  (h1.closest('.brand-link') ?? h1).after(badge);
  document.title = t('profile.docTitle', { port: health.port, title: document.title });
}
