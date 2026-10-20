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
            Text(L10n.t(model.refreshing ? "common.loading" : "mac.menu.notLoaded"))
            Divider()
        }
        footer
    }

    // MARK: unreachable

    @ViewBuilder
    private func unreachable(_ problem: String) -> some View {
        Text(L10n.t("mac.menu.unreachable"))
        Text(problem)
        Text(Problem.hint(base: model.base))
        Button(L10n.t("mac.retry.button")) { model.refreshNow() }
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
        let usedTitle = L10n.t("mac.menu.inUse", ["n": s.usage == nil ? "?" : String(used.count)])
        Section(usedTitle) {
            if s.usage != nil && used.isEmpty { Text(L10n.t("mac.menu.inUseEmpty")) }
            ForEach(used.prefix(maxRows), id: \.port) { svc in
                Menu(svc.title) {
                    openButton(svc.url)
                    Button(L10n.t("mac.menu.serviceDetails")) { model.open("service.html#\(svc.port)") }
                }
            }
            more(used.count, L10n.t("mac.menu.viewInDashboard"), path: "")
        }
        Divider()

        let pinned = Summary.pinned(s.ports)
        Section(L10n.t("mac.menu.pinned", ["n": pinned.count])) {
            if pinned.isEmpty { Text(L10n.t("mac.menu.pinnedEmpty")) }
            ForEach(pinned, id: \.port) { p in
                Menu(Summary.pinnedTitle(p)) {
                    openButton(p.listening ? p.url : nil)
                    Button(L10n.t("mac.menu.serviceDetails")) { model.open("service.html#\(p.port)") }
                }
            }
        }
        Divider()

        let cards = Summary.cards(usage: s.usage, devices: s.devices)
        Section(L10n.t("mac.menu.devices", ["n": cards.count])) {
            if cards.isEmpty { Text(L10n.t("mac.menu.devicesEmpty")) }
            ForEach(Array(cards.prefix(maxRows).enumerated()), id: \.offset) { _, c in
                deviceMenu(c)
            }
            more(cards.count, L10n.t("mac.menu.viewInDevices"), path: "devices.html")
        }

        let local = Summary.localOnly(s.ports)
        if !local.isEmpty {
            Divider()
            Section(L10n.t("mac.menu.localOnly", ["n": local.count])) {
                ForEach(local.prefix(maxRows), id: \.port) { p in
                    localMenu(p)
                }
                more(local.count, L10n.t("mac.menu.viewInDashboard"), path: "")
            }
        }

        let cleanup = Summary.cleanup(s.owners)
        if !cleanup.isEmpty {
            Divider()
            Section(L10n.t("mac.menu.cleanup", ["n": cleanup.count])) {
                ForEach(cleanup.prefix(maxRows), id: \.port) { o in
                    // The 정리 banner (모두 정리) is on the 서비스 tab
                    Button(Summary.cleanupTitle(o)) { model.open("") }
                }
                more(cleanup.count, L10n.t("mac.menu.cleanupInDashboard"), path: "")
            }
        }
        Divider()
    }

    @ViewBuilder
    private func openButton(_ url: URL?) -> some View {
        if let url {
            Button(L10n.t("mac.menu.open")) { model.openURL(url) }
        } else {
            Text(L10n.t("mac.menu.noWebURL"))
        }
    }

    @ViewBuilder
    private func more(_ count: Int, _ label: String, path: String) -> some View {
        if count > maxRows {
            Button(L10n.t("mac.menu.more", ["n": count - maxRows, "label": label])) { model.open(path) }
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
            Button(L10n.t("mac.menu.viewInDevices")) { model.open("devices.html#\(Summary.pathEscape(c.anchor))") }
        }
    }

    private func localMenu(_ p: PortEntry) -> some View {
        Menu("\(p.displayName) :\(p.port)") {
            if p.canExpose {
                Button(L10n.t("mac.menu.expose")) { model.expose(p.port) }
            } else {
                Text(L10n.t("mac.menu.cantExpose", ["reason": p.exposeBlocker ?? "?"]))
            }
            if let ssh = p.sshCommand {
                Button(L10n.t("mac.menu.copySSH")) {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(ssh, forType: .string)
                }
                Text(ssh)
            }
            Button(L10n.t("mac.menu.serviceDetails")) { model.open("service.html#\(p.port)") }
        }
    }

    // MARK: footer

    @ViewBuilder
    private var footer: some View {
        Button(L10n.t("mac.menu.openDashboard")) { model.open("") }
        Button(L10n.t("mac.menu.openInBrowser")) { model.openInBrowser() }
        Button(L10n.t("common.refresh")) { model.refreshNow() }
            .keyboardShortcut("r")
        if let at = model.lastUpdate {
            Text(L10n.t("mac.menu.lastUpdate", ["time": at.formatted(date: .omitted, time: .standard)]))
        }
        Divider()
        if let update = model.update {
            Button(UpdateCheck.menuTitle(update)) { model.openUpdatePage() }
        }
        Button(L10n.t(model.checkingUpdate ? "mac.update.checking" : "mac.menu.checkForUpdates")) { model.checkForUpdatesByHand() }
            .disabled(model.checkingUpdate)
        SettingsLink { Text(L10n.t("mac.menu.settings")) }
            .keyboardShortcut(",")
        Button(L10n.t("mac.menu.quit")) { NSApp.terminate(nil) }
            .keyboardShortcut("q")
    }
}
