// A preview instance (any port but 8790, see src/core/paths.ts) says so in the header and the tab title,
// so it isn't mistaken for production. GET /api/health → {profile, port}. Shared by every page.

import { tryJSON } from './api.js';

export async function showProfile() {
  const health = await tryJSON('/api/health');
  if (health?.profile !== 'preview') return;
  const h1 = document.querySelector('.top .brand h1');
  if (!h1 || document.querySelector('.profile-badge')) return;
  const badge = document.createElement('span');
  badge.className = 'profile-badge';
  badge.textContent = `미리보기 · ${health.port}`;
  badge.title = '미리보기 인스턴스: 설정과 상태는 운영(8790)과 따로, 알림은 꺼짐';
  (h1.closest('.brand-link') ?? h1).after(badge);
  document.title = `[미리보기 ${health.port}] ${document.title}`;
}
