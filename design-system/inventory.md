# Portboard 디자인 시스템 인벤토리

이 파일은 디자인 시스템 폴더에 둔다. 칸마다 값, 원천(`파일:줄`), 또는 "없음: <이유>"를 쓴다.
기준: design-system-blueprint 스킬의 `SKILL.md` (2026-10-31 판).
이 파일은 저장소용 점검표다. `scripts/design-system.ts`는 이 파일을 아티팩트에 올리지 않는다.

- 작성일: 2026-10-31
- 원천 저장소와 커밋: `c10dev/portboard` main `b2be0da`
- claude.ai artifact 링크와 버전: 소유자의 비공개 Design System 아티팩트 "Portboard", 버전 4. 링크는 공개 저장소에 적지 않는다.
- 제품 종류: 대시보드 (한 Linux 서버의 포트, tailnet 기기, 개발 worktree를 보는 운영 도구)

## 1. 원천과 동기화

- [x] 원천 폴더: 값의 원천은 앱 CSS(`public/style.css`, `public/settings.css`, `public/shell.css`)다. 문서, 토큰 메모, 컴포넌트는 `design-system/`에 있다. 스킬 기준과 방향이 반대다: 앱 CSS가 원천이고 `tokens.json`은 생성물이다.
- [x] `tokens.json` `meta`: 생성물에만 있다. `source: github`, `repo: c10dev/portboard`, `ref: main@<커밋>`, `synced: <실행 날짜>` (`scripts/design-system.ts` `buildTokens()`의 `meta`). 커밋된 `tokens.json`은 없다.
- [ ] 앱 CSS 생성 위치: 없음. 앱 CSS를 생성하지 않는다. 반대로 `scripts/design-system.ts`가 앱 CSS의 custom property와 `body` font 단축형을 읽어 `tokens.json`, `tokens.css`, `components/bundle.css`를 만든다. 값은 한 벌이지만, 앱은 생성된 `tokens.css`를 읽지 않는다.
- [ ] 테스트: 없는 토큰 참조: 없음. `test/design-system.test.ts`는 README와 가이드의 토큰 이름만 확인한다. 직접 돌린 결과(2026-10-31): `public/` CSS와 JS의 `var()` 이름 43개 중 선언이 없는 것은 `--card` 하나다(`public/features/digest.js:18`, 대체값 `transparent`). JS가 넣는 변수 `--d`, `--side-open`, `--insp-open`, `--t-loading`, `--toast-front-h`는 정상이다.
- [ ] 테스트: 토큰 값의 리터럴 반복: 없음. 직접 센 값(2026-10-31):
  - 토큰 선언 밖 hex 9개: `#fff`(`public/settings.css:103`), `#8250df`(`public/devices.css:53` ×2), `#d2a8ff`(`public/devices.css:128,131` ×4), `#000`(`public/devices.css:231`), `#d4a72c`(`public/style.css:150`).
  - `fs-1`~`fs-5`와 같은 px 값을 리터럴로 쓴 `font-size`가 139개다. `var(--fs-*)`는 `shell.css`에서 40번, `style.css`와 `settings.css`에서 1번씩만 쓴다.
- [x] README "아직 맞지 않는 곳" 절: `design-system/README.md`의 "Not synced". 이 점검에서 찾은 항목을 같은 날 더했다.

## 2. 토큰

| 계열 | 첫 버전 기준 | 개수 | 원천 | 비고 |
|---|---|---|---|---|
| 바탕 | bg, surface, sunk | 4 | `public/style.css:4-6,12` | `side-bg`, `bg`, `surface`, `neutral-bg`. 없음: `sunk`. `neutral-bg`는 들어간 바탕이 아니라 태그와 배지 채움이다. |
| 글자 | fg, muted (4.5:1 이상) | 4 | `public/style.css:7-10` | `text`, `text-2`, `text-3`, `muted`(= `{text-2}`). `fg`라는 이름은 없고 `text`가 그 역할이다. 대비는 7절. |
| 선 | line, line-strong | 2 | `public/style.css:11`, `public/settings.css:8` | `line`, 설정 창용 `st-divider`. 없음: `line-strong`. `line`은 테두리 3:1에 못 미친다(7절). |
| 브랜드 | 1~2개 + on-<brand> | 2 | `public/style.css:13-14` | `accent`, `accent-text`. `accent` 하나가 링크, 초점, 주 버튼, CPU 차트를 함께 맡는다. |
| 상태 | ok, warn, danger, info × fill, on-fill, ink | 8 | `public/style.css:15-22` | `ok`/`ok-bg`, `warn`/`warn-bg`, `info`/`info-bg`, `danger`/`danger-text`. 맨 이름이 ink, `-bg`가 옅은 fill이다. 없음: `danger-bg`(`color-mix()`로 대신), `on-ok`, `on-warn`, `on-info`. |
| 별칭 | link, focus | 0 | — | 없음: 규칙마다 `var(--accent)`를 직접 쓴다. 초점 링 모양도 곳곳에서 다르다(outline offset -2/0/1/2, inset box-shadow, `color-mix` 55%: `public/settings.css:60,107,124`, `public/shell.css:64,150,308`). |
| 차트 | 범주 고정 순서, 색약 검증 | 0 | — | 없음: 차트가 브랜드색과 상태색을 그대로 쓴다. 스파크라인 cpu `accent`, mem `ok`, psi `warn`(`public/devices.css:197-200`), 가동 막대 up `ok` / down `danger` / quiet `warn`(`public/style.css:347-351`). 색약 검증 기록 없음. |
| 테마 | light, dark (같은 이름) | 2 | `public/style.css:1-75`, `public/settings.css:7-32` | 같은 이름에 값만 바꾼다. `prefers-color-scheme`와 `[data-theme]`를 둘 다 따른다. 두 블록이 같은지는 `test/theme.test.ts`가 지킨다. |
| 글꼴 패밀리 | sans, mono, 한국어 대체 | 2 | `public/style.css:23,85` | 앱 CSS에는 `--mono` 변수만 있고, sans 스택은 `body`의 font 단축형에 리터럴로 있다. 한국어 대체(Apple SD Gothic Neo, Noto Sans KR)는 sans에만 있다. 생성된 `tokens.css`에는 `--font-sans`, `--font-mono`가 있다. |
| 텍스트 스타일 | 8~12개, CSS 변수로 생성 | 8 | `public/style.css:26-30`, `design-system/tokens.notes.json` | `fs-1`~`fs-5`(크기만), `figure-port`, `figure-port-sm`, `figure-access-code`. 없음: 역할 이름(display, title, heading, body…), `--type-<name>` 변수. 앱은 대부분 px 리터럴을 쓴다(1절). |
| 간격 | 4~8단계 | 0 | — | 없음: 모든 간격이 리터럴이다. README가 리듬을 글로 적는다(버튼 6px 11px, 목록 행 6px 12px, 컨트롤 사이 4~8px). |
| 반경 | 3~5단계 | 9 | `design-system/tokens.notes.json` | `radius-4/6/7/8/10/12/14/pill/round`. 이름은 디자인 시스템에만 있고 앱은 리터럴을 쓴다. 기준보다 많다: 4/6/7/8과 10/12/14가 합칠 후보다. |
| 그림자 | 2~3개 + 초점 링 | 4 | `design-system/tokens.notes.json` | `shadow-dialog/toast/drawer/sheet`. 디자인 시스템에만 있고 앱은 리터럴을 쓴다. 없음: 초점 링 토큰. 설정 모달, 메뉴, 기기 상세, 현재 탭, 세그먼트, 토글 손잡이의 그림자는 리터럴이다. |
| 크기 | 터치 최소, 컨트롤 높이, 글 폭 | 0 | — | 없음: 컨트롤 높이 32px가 리터럴로 되풀이된다(`public/settings.css:55,65,115,130,151`, `public/shell.css:119`). 44px 최소 높이는 명령 팔레트 행 한 곳뿐이다(`public/palette.css:34`). |
| 모션 | README 표: 시간, easing, reduced | 0 | `design-system/README.md` "Motion and states" | 없음: 변수도 표도 없다. 실제 값: .1s, .12s, .15s, .16s, .18s, .2s(지연 .4s), 1.6s ease-out, 0s(지연 2.5s) (`public/shell.css:147,257,307,373,378,407`, `public/settings.css:100,103`, `public/palette.css:74`). reduced-motion은 일부만 처리한다(`public/shell.css:158,390,423,461`, `public/palette.css:76`). drawer와 sheet, ⋯ 메뉴, 설정 토글은 처리하지 않는다. |
| 키울 때: 원시 팔레트 | 색 40개 이상 또는 테마 3개 이상 | 0 | — | 없음: 아직 필요하지 않다. 색 25개, 테마 2개. |
| 키울 때: 레이아웃, z-index | | 6 / 0 | `public/shell.css:9-14` | 레이아웃 `bar-h`, `side-w`, `insp-w`, `col-max`, `col-wide`, `col-pad`. z-index 토큰은 없음: 리터럴 1, 3, 5, 24, 25, 26, 27, 30, 40, 60. 메뉴가 3(`public/style.css:161`)과 60(`public/settings.css:140`)으로 갈린다. |

## 3. 컴포넌트

모든 행에 공통: README와 preview가 있다. 타입(`index.d.ts`)은 없다: 컴포넌트 묶음이 없어서다. 대시보드는 컴포넌트 라이브러리 없이 DOM 빌더 함수로 그린다. preview는 그 마크업을 손으로 옮긴 정적 사본이다. 어느 README에도 상태 절과 키보드/ARIA 절이 따로 없다. 아래 "상태와 키보드" 칸은 README에 언급이 없는 항목이다(2026-10-31 낱말 검색 기준).

| 컴포넌트 | 제품 고유 / 범용 | 앱 사용 위치 | README | preview | 타입 | 소스 | 상태와 키보드 |
|---|---|---|---|---|---|---|---|
| Badge | 범용 | 포트 행, 서비스, 알림, 메모리, 네트워크 트리 | 있음 | 있음 | 없음 | `public/lib/badge.js` `badge()` | 빠짐: focus, hover, disabled, loading, empty, error, ARIA |
| Button | 범용 | 행 동작, 설정, 대화상자 | 있음 | 있음 | 없음 | `public/lib/dom.js` `button()`, `extLink()` | 빠짐: loading, empty, error, ARIA |
| CommandPalette | 범용 | 모든 페이지(⌘K) | 있음 | 있음 | 없음 | `public/lib/palette.js` `initPalette()` | 빠짐: hover, disabled, error |
| DeviceCard | 제품 고유 | 기기 탭 | 있음 | 있음 | 없음 | `public/features/usage.js` `card()` | 빠짐: disabled, loading, empty, error |
| IconButton | 범용 | 셸 머리줄, 설정 모달 | 있음 | 있음 | 없음 | `src/core/shell.ts` `shellParts()`(서버 HTML), `public/lib/keys.js` | 빠짐: focus, loading, empty, error |
| IconToggle | 범용 | 포트 행의 핀과 종 | 있음 | 있음 | 없음 | `public/features/ports.js` `renderRow()`, `public/features/alerts.js` `bell()` | 빠짐: disabled, loading, empty, error, 키보드 |
| Kbd | 범용 | 단축키 도움말, 팔레트 | 있음 | 있음 | 없음 | `public/lib/keys.js`, `public/lib/palette.js` | 정적 표시라 대부분 해당 없음 |
| Menu | 범용 | 포트 행의 ⋯ | 있음 | 있음 | 없음 | `public/lib/menu.js` `moreMenu()` | 빠짐: loading, empty, error, 화살표와 Esc 동작 |
| MenuSelect | 범용 | 설정(포트 규칙, digest, 자동 정지) | 있음 | 있음 | 없음 | `public/lib/controls.js` `menuSelect()` | 빠짐: loading, empty, error |
| Meter | 범용 | 기기 탭의 머신 줄 | 있음 | 있음 | 없음 | `public/features/machines.js` `bar()` | 빠짐: 상태 전부, 키보드, ARIA(`role=meter` 없음) |
| PortRow | 제품 고유 | 서비스 탭 목록 | 있음 | 있음 | 없음 | `public/features/ports.js` `renderRow()` | 빠짐: disabled, loading, empty, error, 키보드 |
| SegmentedControl | 범용 | 설정 | 있음 | 있음 | 없음 | `public/lib/controls.js` `segmented()` | 빠짐: loading, empty, error |
| SettingsRow | 범용 | 설정의 모든 절 | 있음 | 있음 | 없음 | `public/lib/controls.js` `row()` | 빠짐: focus, hover, loading, empty, error |
| Sidebar | 범용(앱 셸) | 모든 페이지 | 있음 | 있음 | 없음 | `public/lib/shell-boot.js` `fill()`, `public/features/nav.js` | 빠짐: disabled, loading, error |
| StatusDot | 범용 | 기기 줄, 대화상자, 트리, 카드 | 있음 | 있음 | 없음 | 빌더 하나로 모여 있지 않음(`public/features/devices.js`, `public/features/nettree-view.js` 외) | 빠짐: hover, disabled, loading, error |
| Tag | 범용 | 기기 카드, 손님 목록, 호스트 포트 | 있음 | 있음 | 없음 | `public/features/usage.js`, `public/features/host-ports.js` | 빠짐: disabled, loading, empty, error, 키보드, ARIA |
| TextInput | 범용 | 설정(소유자 토큰, digest, 포트 규칙) | 있음 | 있음 | 없음 | 범용 빌더 없음(`public/features/settings-modal.js` 외) | 빠짐: hover, disabled, loading, error(검증 오류 상태 없음), 키보드 |
| Toast | 범용 | 서비스 탭, 기기 탭, 되돌리기 | 있음 | 있음 | 없음 | `public/lib/toast.js` `createToasts()` | 빠짐: focus, hover, disabled, loading, empty |
| Toggle | 범용 | 설정(쓰기 허용 기기) | 있음 | 있음 | 없음 | `public/lib/controls.js` `toggle()` | 빠짐: hover, loading, error |
| UptimeBar | 제품 고유 | 서비스 페이지, 알림 | 있음 | 있음 | 없음 | `public/features/uptime.js` | 빠짐: 상태 전부, 키보드 |
| UserChip | 제품 고유 | 포트 행, 서비스, 인스펙터 | 있음 | 있음 | 없음 | `public/lib/badge.js` `userChip()` | 빠짐: focus, disabled, loading, empty, error, ARIA |
| WhyEmpty | 범용 | 서비스 탭, 기기 탭, 개발 탭 | 있음 | 있음 | 없음 | `public/lib/empty.js` `whyEmpty()` | 빠짐: focus, hover, disabled, loading, 키보드, ARIA |

앱이 직접 만든 범용 부품 (디자인 시스템으로 옮길 후보):

- Modal (포커스 가두기): `public/lib/modal.js` `createModal()`, 설정 모달이 쓴다.
- Dialog / Sheet: `public/lib/dialog.js` `modal()`, `sheet()`. 알림, 어디서 돌릴까, 셀프와치, 팔레트, 기기 상세, 머신 상세가 쓴다.
- CopyButton: 공통 빌더가 없고 `public/lib/toast.js` `copy()`를 버튼과 묶는 곳이 4곳이다(`public/features/control.js`, `about.js`, `settings-start.js`, `remote-connector.js`).
- LogsViewer: `public/features/control.js` `logsDialog()`.
- Table: 표 빌더 3개가 따로 있다(`public/service.js` `table.used`, `public/features/memory.js` `table()`, `public/features/adoption.js`).
- Sparkline / 추세 차트: `public/lib/sparkline.js`, 막대 차트 `public/features/adoption.js` `bars()`.
- FilterPopover: `public/lib/shell.js`의 필터 버튼과 패널.
- Tabs: `src/core/shell.ts`의 `shell-tabs`, CSS `public/shell.css:91-92`.
- Inspector: `public/features/port-inspector.js` `renderInspector()`.
- NetTree: `public/lib/nettree.js`, `public/features/nettree-view.js`.

## 4. 문서

- [x] 제품 한 문단: `design-system/README.md` 첫 문단. 무엇이 아닌지는 쓰지 않았다.
- [ ] 원칙: 없음. 원칙 절이 없다.
- [x] 목소리 (영어, 한국어): "Content fundamentals".
- [ ] 색과 대비 표 (테마별): 색 절은 있다. 대비 표는 없고 "4.5:1에 닿는다"는 문장 하나뿐이다. 그 문장의 바탕 목록에 `ok-bg`, `warn-bg`가 없다.
- [x] 글자, 간격, 반경, 그림자: "Type", "Shape and space". 간격 토큰이 없다고 적었다.
- [ ] 상태와 모션: 상태 문장은 있다. 모션 표(시간, easing, reduced-motion에서 멈추는 것)는 없다.
- [x] 로고와 아이콘: "Iconography", `design-system/assets/Logos/README.md`.
- [ ] 레이아웃 (앱의 모든 화면): 셸 골격과 브레이크포인트는 있다. 화면별로는 서비스 탭과 기기 탭만 나온다. 개발 탭(`dev.html`), 서비스 상세(`service.html`), 설정 창은 없다.
- [ ] 컴포넌트 목록: 목록이 없다. "Components" 절은 설명 문단뿐이다.
- [x] 아직 맞지 않는 곳: "Not synced".

## 5. 자산

- [x] 로고 파일: `public/icon.svg`(32 × 32, 색 고정 `#2f6feb`, `#fff`, `#5fe08d`)를 아티팩트 asset store에 올린다. `public/apple-touch-icon.png`(180 × 180)는 디자인 시스템에 없다. wordmark 없음: 이름은 `sans`로 쓴다.
- [x] 아이콘 세트, 크기 격자, 라이선스: 세트 없음. 텍스트 글리프(↻ ⋯ ☆★ 🔔 ← ↗ × ⌘K)와 직접 그린 인라인 SVG 2개(`public/lib/controls.js` CHEVRON 16 격자, `public/features/settings-modal.js` CLOSE_ICON 20 격자, 둘 다 선 1.6, `currentColor`). 직접 만들어 라이선스 해당 없음. 격자와 선 굵기는 README에 없다.
- [x] 글꼴 파일과 라이선스: 없음: 시스템 글꼴 스택만 쓴다(`public/style.css:85`). `tokens.json` `type.fonts`는 빈 목록이다.
- [x] 가져온 코드와 라이선스: 없음: `package.json`에 런타임 의존성이 없고 `public/*.html`은 외부 script나 stylesheet를 불러오지 않는다. 저장소 라이선스는 MIT다.

## 6. 앱과 연결

- [ ] 앱 CSS에 hex, 글꼴 리터럴 없음: 미충족. 토큰 선언 밖 hex 9개, `font:` 단축형 리터럴 30개, sans 스택 리터럴 1개(`public/style.css:85`). 1절 참고.
- [ ] 차트 색이 차트 토큰에서 옴: 없음: 차트 토큰이 없다. 2절 차트 행 참고.
- [x] 다크 모드: `prefers-color-scheme`와 `[data-theme]`: 충족(`public/style.css:32-78`, `public/settings.css:17-32`). `.tag.serve`만 리터럴로 같은 구조를 쓴다(`public/devices.css:127-131`).

## 7. 내기 전 확인

- [x] 모든 토큰에 usage 메모: 메모가 빠지거나 남으면 빌드가 실패하고, 테스트가 지킨다(`test/design-system.test.ts`).
- [x] 대비 직접 계산 (두 테마): 글자 토큰 8개 × 바탕 7개(`bg`, `side-bg`, `surface`, `neutral-bg`, `info-bg`, `ok-bg`, `warn-bg`).
  - 밝은 테마: 최소 `info` on `neutral-bg` 4.56:1. `accent-text` on `accent` 5.73:1, `danger-text` on `danger` 5.36:1.
  - 어두운 테마: 최소 `accent` on `neutral-bg` 4.73:1. `accent-text` on `accent` 6.48:1, `danger-text` on `danger` 7.81:1.
  - 4.5:1 미만 쌍은 두 테마 모두 0개다. `ok-bg`, `warn-bg` 쌍은 `test/contrast.test.ts`가 검사하지 않는다.
  - 미달: `line`을 `surface`에 합성하면 밝은 테마 1.25:1, 어두운 테마 1.35:1이다. 컨트롤 테두리 3:1 기준에 못 미친다.
- [ ] 상태가 색만으로 말하지 않음: 대부분 충족. 예외 3곳: 사이드바 점은 상태를 `title`(마우스 올림)으로만 준다(`public/lib/shell-boot.js:163`), 기기 칩은 온라인일 때 글자가 없다(`public/features/usage.js:250`), 머신 카드는 stale일 때만 글자가 있다(`public/features/machines.js:54`).
- [ ] 앱 테스트 통과: `npm test`, `npm run test:en`, 두 typecheck는 통과한다. 기준이 요구하는 "없는 토큰 참조 0개", "리터럴 반복 0개" 테스트는 없다. 직접 센 값은 1개(`--card`), hex 1개와 font-size 139개다.
- [x] 공개 파일에 실제 경로, 비공개 이름, ID 없음: `design-system/`과 `docs/design-system.md`에서 홈 경로, 실제 호스트와 tailnet 이름, UUID를 grep한 결과 0줄이다.
- [x] "아직 맞지 않는 곳" 최신: 이 점검의 빠진 항목을 2026-10-31에 README "Not synced"에 더했다.
