// 설정 체크리스트 (#32): what is set up and what is left (alert channel, Proxmox token, the read-only SSH keys, the
// Mac's agent and menu bar, the claude.ai connector, Claude Code's MCP entry, first pins/names/alerts), each with
// its next step. Read-only; never a secret (src/core/onboarding.ts).
//
//   GET /api/onboarding   ({items: [{key, title, status ok|missing|warn, detail, action}], ok, total, summary})
//   MCP setup_status      (local only: it names local setup files and commands, nothing for the internet)
//   ui  onboarding.js on the 서비스 page (header chip "설정 n/m", a link to the 설정 tab, hidden once all is ok);
//       the checklist itself is the 설정 tab's 시작하기 section (settings-start.js)

import { assess, collectSetupFacts, type Checklist } from '../core/onboarding.ts';
import { text } from '../mcp/kit.ts';
import { ok } from './router.ts';
import type { FeatureModule } from './types.ts';

declare module '../mcp/kit.ts' {
  interface Core {
    /** The setup checklist, from the files the server writes (self-watch, menu bar last seen) and the config files */
    setupStatus?(): Promise<Checklist>;
  }
}

export const onboardingFeature: FeatureModule = {
  name: 'onboarding',
  order: 1700,
  routes: [
    {
      method: 'GET',
      path: '/api/onboarding',
      // The server's live self-watch view, not the file it writes once a minute.
      handler: async (_r, ctx) => ok(assess(await collectSetupFacts({ selfwatch: () => ctx.selfwatch.status() }))),
    },
  ],
  tools: [
    {
      def: {
        name: 'setup_status',
        title: 'Setup checklist',
        description:
          "What of Portboard's setup is done and what is left: alert channel, Proxmox API token (and its expiry), the " +
          'read-only SSH keys for the Proxmox host/CTs and Windows, the Mac agent and menu bar, the claude.ai remote connector, ' +
          'Claude Code MCP registration, and first use (pins, labels, alerts, LAN names). Each item: status ' +
          'ok/missing/warn, a one-line Korean explanation and the next action (a command or a doc link). Never secrets. ' +
          'Use it when the user asks what is left to set up, or why alerts/devices/the connector do not work.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async call(_args, core) {
        if (!core.setupStatus) return text('setup_status is not available here', true);
        return text(await core.setupStatus());
      },
    },
  ],
  mcpCore: () => ({ setupStatus: async () => assess(await collectSetupFacts()) }),
  // in the shell's sidebar footer on every page (docs/layout/)
  ui: [{ pages: ['index.html', 'devices.html', 'dev.html', 'service.html'], script: 'features/onboarding.js' }],
};
