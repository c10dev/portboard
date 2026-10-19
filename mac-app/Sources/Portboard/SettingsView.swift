import AppKit
import PortboardCore
import SwiftUI

/// Portboard 앱 설정 (⌘,): server URL, 연결 확인, notifications, poll interval, 로그인할 때 열기.
/// This is the app's own settings; the dashboard's 설정 tab (settings.html) holds the server's settings and checklist.
struct SettingsView: View {
    @EnvironmentObject var model: AppModel

    @AppStorage(Pref.serverURL) private var serverURL = Server.defaultURL
    @AppStorage(Pref.notifyWatch) private var notifyWatch = false
    @AppStorage(Pref.notifyNewDevices) private var notifyNewDevices = false
    @AppStorage(Pref.ntfyCovers) private var ntfyCovers = false
    @AppStorage(Pref.notifyDecided) private var notifyDecided = false
    @AppStorage(Pref.pollActive) private var pollActive = Poll.activeDefault
    @AppStorage(Pref.pollBackground) private var pollBackground = Poll.backgroundDefault

    @State private var serverInput = ""
    @State private var serverError: String?
    @State private var check: CheckState = .idle
    @State private var notificationStatus = ""
    @State private var loginOn = LoginItem.isEnabled
    @State private var loginError: String?

    enum CheckState: Equatable {
        case idle, running
        case ok([String])
        case failed(String)
    }

    var body: some View {
        Form {
            Section(L10n.t("mac.settings.server")) {
                HStack {
                    TextField(L10n.t("mac.settings.serverAddress"), text: $serverInput, prompt: Text(Server.defaultURL))
                        .onSubmit(applyServer)
                    Button(L10n.t("mac.settings.apply"), action: applyServer)
                        .disabled(Server.normalize(serverInput)?.absoluteString == model.base.absoluteString)
                }
                if let serverError {
                    Text(serverError).foregroundStyle(.red).font(.callout)
                }
                HStack(alignment: .top) {
                    Button(L10n.t("mac.settings.check"), action: runCheck)
                        .disabled(check == .running)
                    checkResult
                }
                Text(L10n.t("mac.settings.serverNote", ["url": Server.defaultURL]))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Section(L10n.t("mac.settings.notifications")) {
                Toggle(L10n.t("mac.settings.notifyWatch"), isOn: $notifyWatch)
                Toggle(L10n.t("mac.settings.notifyNewDevices"), isOn: $notifyNewDevices)
                if notifyDecided && ntfyCovers {
                    Text(L10n.t("mac.settings.ntfyCovers"))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else {
                    Text(L10n.t("mac.settings.notifyRemembers"))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                HStack {
                    Text(notificationStatus).font(.caption).foregroundStyle(.secondary)
                    Spacer()
                    Button(L10n.t("mac.settings.openNotificationSettings")) {
                        if let url = URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension") {
                            NSWorkspace.shared.open(url)
                        }
                    }
                    .controlSize(.small)
                }
            }

            Section(L10n.t("mac.settings.poll")) {
                Picker(L10n.t("mac.settings.pollActive"), selection: $pollActive) {
                    ForEach(Poll.choices.filter { $0 <= 120 }, id: \.self) { Text(Poll.label($0)).tag($0) }
                }
                Picker(L10n.t("mac.settings.pollBackground"), selection: $pollBackground) {
                    ForEach(Poll.choices.filter { $0 >= 60 }, id: \.self) { Text(Poll.label($0)).tag($0) }
                }
            }

            Section(L10n.t("mac.settings.startup")) {
                Toggle(L10n.t("mac.settings.openAtLogin"), isOn: Binding(get: { loginOn }, set: setLogin))
                    .disabled(!LoginItem.available)
                if !LoginItem.available {
                    Text(L10n.t("mac.settings.loginNeedsApp")).font(.caption).foregroundStyle(.secondary)
                } else if LoginItem.needsApproval {
                    HStack {
                        Text(L10n.t("mac.settings.loginNeedsApproval")).font(.caption)
                        Button(L10n.t("mac.settings.open")) { LoginItem.openSystemSettings() }.controlSize(.small)
                    }
                }
                if let loginError {
                    Text(loginError).foregroundStyle(.red).font(.callout)
                }
            }

            Section {
                Text("Portboard for Mac \(AppInfo.version) · \(Bundle.main.bundlePath)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }
        }
        .formStyle(.grouped)
        .frame(width: 560, height: 640)
        .onAppear {
            serverInput = model.base.absoluteString
            loginOn = LoginItem.isEnabled
            Task { notificationStatus = await Notifier.shared.authorizationText() }
        }
        .onChange(of: notifyWatch) { _, on in if on { askForNotifications() } }
        .onChange(of: notifyNewDevices) { _, on in if on { askForNotifications() } }
    }

    @ViewBuilder
    private var checkResult: some View {
        switch check {
        case .idle:
            Text(L10n.t("mac.settings.checkIdle")).font(.callout).foregroundStyle(.secondary)
        case .running:
            ProgressView().controlSize(.small)
        case .ok(let lines):
            VStack(alignment: .leading, spacing: 2) {
                ForEach(lines, id: \.self) { Text($0).font(.callout) }
            }
            .textSelection(.enabled)
        case .failed(let message):
            VStack(alignment: .leading, spacing: 2) {
                Text(L10n.t("mac.settings.checkFailed", ["message": message])).foregroundStyle(.red).font(.callout)
                Text(Problem.hint(base: model.base)).font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private func applyServer() {
        guard let url = Server.normalize(serverInput) else {
            serverError = L10n.t("mac.settings.invalidURL")
            return
        }
        serverError = nil
        serverInput = url.absoluteString
        guard url.absoluteString != model.base.absoluteString else { return }
        serverURL = url.absoluteString
        check = .idle
        model.serverChanged()
    }

    private func runCheck() {
        check = .running
        Task {
            switch await model.whoami() {
            case .success(let w): check = .ok(w.lines)
            case .failure(let e): check = .failed(e.message)
            }
        }
    }

    private func askForNotifications() {
        Task {
            _ = await Notifier.shared.requestAuthorization()
            notificationStatus = await Notifier.shared.authorizationText()
        }
    }

    private func setLogin(_ on: Bool) {
        do {
            try LoginItem.set(on)
            loginError = nil
        } catch {
            loginError = L10n.t("mac.settings.loginFailed", ["error": error.localizedDescription])
        }
        loginOn = LoginItem.isEnabled || LoginItem.needsApproval
    }
}
