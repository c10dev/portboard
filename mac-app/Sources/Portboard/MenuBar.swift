import AppKit
import PortboardCore
import SwiftUI

/// The menu bar item: an icon plus `⇄ n` (services in use) and counts for what needs a look:
/// `↓n` watched ports down, `⚠n` devices to check, `🧹n` leftover dev servers.
struct MenuBarLabel: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: symbol)
            Text(text)
        }
        .onAppear {
            // The label is always on screen, so its openWindow is the one the rest of the app uses
            model.openMainWindow = { openWindow(id: PortboardApp.mainWindowID) }
        }
    }

    private var symbol: String {
        if model.problem != nil { return "wifi.exclamationmark" }
        return model.status?.needsAttention == true ? "exclamationmark.triangle.fill" : "network"
    }

    private var text: String {
        if model.problem != nil { return "" }
        return model.status?.title ?? "…"
    }
}

private let maxRows = 25 // per section, so the menu stays on screen

/// The menu, the native successor of menubar/format.mjs
struct MenuContent: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        if let flash = model.flash {
            Text(flash)
            Divider()
        }
        if let problem = model.problem {
            unreachable(problem)
        } else if let s = model.snapshot {
            sections(s)
        } else {
            Text(model.refreshing ? "불러오는 중…" : "아직 읽지 않았어요")
            Divider()
        }
        footer
    }

    // MARK: unreachable

    @ViewBuilder
    private func unreachable(_ problem: String) -> some View {
        Text("Portboard 연결 안 됨")
        Text(problem)
        Text(Problem.hint(base: model.base))
        Button("다시 시도") { model.refreshNow() }
        Divider()
    }

    // MARK: sections

    @ViewBuilder
    private func sections(_ s: Snapshot) -> some View {
        let status = MenuStatus(s)
        let warnings = Summary.warnings(s)
        Group {
            if let detail = status.detail { Text(detail) }
            if !warnings.isEmpty {
                ForEach(Array(warnings.enumerated()), id: \.offset) { _, w in
                    Button(w.text) { model.open(w.path) }
                }
                Divider()
            }
        }

        let used = Summary.inUse(ports: s.ports, usage: s.usage)
        let usedTitle = s.usage == nil ? "사용 중 서비스 ?" : "사용 중 서비스 \(used.count)"
        Section(usedTitle) {
            if s.usage != nil && used.isEmpty { Text("지금 쓰는 서비스 없음") }
            ForEach(used.prefix(maxRows), id: \.port) { svc in
                Menu(svc.title) {
                    openButton(svc.url)
                    Button("서비스 상세 보기") { model.open("service.html#\(svc.port)") }
                }
            }
            more(used.count, "대시보드에서 보기", path: "")
        }
        Divider()

        let pinned = Summary.pinned(s.ports)
        Section("고정한 포트 \(pinned.count)") {
            if pinned.isEmpty { Text("고정한 포트 없음 (대시보드에서 고정)") }
            ForEach(pinned, id: \.port) { p in
                Menu(Summary.pinnedTitle(p)) {
                    openButton(p.listening ? p.url : nil)
                    Button("서비스 상세 보기") { model.open("service.html#\(p.port)") }
                }
            }
        }
        Divider()

        let cards = Summary.cards(usage: s.usage, devices: s.devices)
        Section("기기 \(cards.count)") {
            if cards.isEmpty { Text("기기 정보 없음") }
            ForEach(Array(cards.prefix(maxRows).enumerated()), id: \.offset) { _, c in
                deviceMenu(c)
            }
            more(cards.count, "기기 탭에서 보기", path: "devices.html")
        }

        let local = Summary.localOnly(s.ports)
        if !local.isEmpty {
            Divider()
            Section("local only 서비스 \(local.count)") {
                ForEach(local.prefix(maxRows), id: \.port) { p in
                    localMenu(p)
                }
                more(local.count, "대시보드에서 보기", path: "")
            }
        }

        let cleanup = Summary.cleanup(s.owners)
        if !cleanup.isEmpty {
            Divider()
            Section("정리할 수 있는 서버 \(cleanup.count)") {
                ForEach(cleanup.prefix(maxRows), id: \.port) { o in
                    // The 정리 banner (모두 정리) is on the 서비스 tab
                    Button(Summary.cleanupTitle(o)) { model.open("") }
                }
                more(cleanup.count, "대시보드에서 정리", path: "")
            }
        }
        Divider()
    }

    @ViewBuilder
    private func openButton(_ url: URL?) -> some View {
        if let url {
            Button("열기 ↗") { model.openURL(url) }
        } else {
            Text("열 수 있는 웹 주소 없음")
        }
    }

    @ViewBuilder
    private func more(_ count: Int, _ label: String, path: String) -> some View {
        if count > maxRows {
            Button("외 \(count - maxRows)개 — \(label)") { model.open(path) }
        }
    }

    private func deviceMenu(_ c: DeviceCard) -> some View {
        Menu(Summary.deviceTitle(c)) {
            ForEach(Array(c.uses.enumerated()), id: \.offset) { _, u in
                if let url = u.url {
                    Button(Summary.useTitle(u)) { model.openURL(url) }
                } else {
                    Text(Summary.useTitle(u))
                }
            }
            if let detail = c.pool?.detail, detail != "ok" { Text(Fmt.menuText(detail)) }
            if !c.uses.isEmpty || (c.pool?.detail.map { $0 != "ok" } ?? false) { Divider() }
            Button("기기 탭에서 보기") { model.open("devices.html#\(Summary.pathEscape(c.anchor))") }
        }
    }

    private func localMenu(_ p: PortEntry) -> some View {
        Menu("\(p.displayName) :\(p.port)") {
            if p.canExpose {
                Button("tailnet 공개") { model.expose(p.port) }
            } else {
                Text("공개 불가: \(p.exposeBlocker ?? "?")")
            }
            if let ssh = p.sshCommand {
                Button("SSH 터널 명령 복사") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(ssh, forType: .string)
                }
                Text(ssh)
            }
            Button("서비스 상세 보기") { model.open("service.html#\(p.port)") }
        }
    }

    // MARK: footer

    @ViewBuilder
    private var footer: some View {
        Button("대시보드 열기") { model.open("") }
        Button("브라우저에서 열기") { model.openInBrowser() }
        Button("새로고침") { model.refreshNow() }
            .keyboardShortcut("r")
        if let at = model.lastUpdate {
            Text("마지막 갱신 \(at.formatted(date: .omitted, time: .standard))")
        }
        Divider()
        SettingsLink { Text("Portboard 앱 설정…") }
            .keyboardShortcut(",")
        Button("Portboard 종료") { NSApp.terminate(nil) }
            .keyboardShortcut("q")
    }
}
