import AppKit
import PortboardCore
import SwiftUI

@main
struct PortboardApp: App {
    static let mainWindowID = "main"

    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @StateObject private var model = AppModel()
    @StateObject private var web = WebController()

    init() {
        // First, before any text is built: the Localizable.strings of the system language (Resources/*.lproj)
        L10n.load()
        Pref.register()
    }

    var body: some Scene {
        Window("Portboard", id: Self.mainWindowID) {
            MainWindow()
                .environmentObject(model)
                .environmentObject(web)
                .onAppear { connect() }
        }
        // no title bar: the dashboard's header is the window's one bar (MainWindow, WindowChromeView)
        .windowStyle(.hiddenTitleBar)
        .defaultSize(width: 1280, height: 860)
        .commands { DashboardCommands(web: web) }

        MenuBarExtra {
            MenuContent()
                .environmentObject(model)
        } label: {
            MenuBarLabel()
                .environmentObject(model)
                .onAppear { connect() }
        }
        .menuBarExtraStyle(.menu)

        Settings {
            SettingsView()
                .environmentObject(model)
        }
    }

    /// Wires the pieces together once: polling, the window's web view, notification clicks, menu open/close
    private func connect() {
        delegate.model = model
        model.loadInWindow = { [weak web] path in web?.load(path) }
        model.viewingPort = { [weak web] in web?.viewingPort() }
        Notifier.shared.onOpen = { [weak model] path in model?.open(path) }
        Notifier.shared.setUp()
        model.start()
    }
}

/// The window has no toolbar, so its actions live here: ⌘1…⌘4 for the dashboard's tabs, ⌘[, ⌘R and ⇧⌘O
struct DashboardCommands: Commands {
    let web: WebController

    var body: some Commands {
        CommandMenu(L10n.t("mac.menu.dashboard")) {
            ForEach(Array(DashboardTab.allCases.enumerated()), id: \.element) { i, tab in
                Button(tab.title) { web.open(tab) }
                    .keyboardShortcut(KeyEquivalent(Character(String(i + 1))), modifiers: .command)
            }
            Divider()
            Button(L10n.t("shell.back")) { web.goBack() }
                .keyboardShortcut("[", modifiers: .command)
            Button(L10n.t("common.refresh")) { web.reload() }
                .keyboardShortcut("r", modifiers: .command)
            Button(L10n.t("mac.menu.openInBrowser")) { web.openInBrowser() }
                .keyboardShortcut("o", modifiers: [.command, .shift])
        }
    }
}

/// Keeps the app (and its menu bar item) running when the window is closed, reopens the window from the Dock, and
/// tells the model when a menu is open (to poll every 30 s while it is).
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    weak var model: AppModel?
    private var observers: [NSObjectProtocol] = []

    func applicationDidFinishLaunching(_ notification: Notification) {
        let center = NotificationCenter.default
        // Posted for every menu, the menu bar extra's too; the model only refreshes when its data is stale
        observers.append(center.addObserver(forName: NSMenu.didBeginTrackingNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.model?.menuOpened() }
        })
        observers.append(center.addObserver(forName: NSMenu.didEndTrackingNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.model?.menuClosed() }
        })
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { model?.open("") }
        return true
    }
}
