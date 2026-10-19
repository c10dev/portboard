// The language the suite runs in: `npm test` sets PORTBOARD_LOCALE=ko, `npm run test:en` sets en (scripts/test-en.ts).
// Both src/core/i18n.ts (through SITE.locale) and public/lib/i18n.js read the same variable; unset is en for both.
//
// L(ko, en) picks the expected text for a test that checks wording, so the same assertion checks the English catalog
// too instead of only the Korean one (#6). Tests whose whole point is Korean wording stay ko-only (scripts/test-en.ts).

export const LOCALE: 'ko' | 'en' = process.env.PORTBOARD_LOCALE === 'ko' ? 'ko' : 'en';

export const L = <T>(ko: T, en: T): T => (LOCALE === 'ko' ? ko : en);
