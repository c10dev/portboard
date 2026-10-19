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
            Section("서버") {
                HStack {
                    TextField("서버 주소", text: $serverInput, prompt: Text(Server.defaultURL))
                        .onSubmit(applyServer)
                    Button("적용", action: applyServer)
                        .disabled(Server.normalize(serverInput)?.absoluteString == model.base.absoluteString)
                }
                if let serverError {
                    Text(serverError).foregroundStyle(.red).font(.callout)
                }
                HStack(alignment: .top) {
                    Button("연결 확인", action: runCheck)
                        .disabled(check == .running)
                    checkResult
                }
                Text("기본값은 \(Server.defaultURL) (tailscale serve, tailnet 안에서만). 쓰기(정지·공개)는 소유자 계정의 쓰기 허용 기기에서만 돼요.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Section("알림") {
                Toggle("감시 중인(🔔) 포트·기기가 다운되거나 복구될 때", isOn: $notifyWatch)
                Toggle("새 기기가 처음 보일 때", isOn: $notifyNewDevices)
                if notifyDecided && ntfyCovers {
                    Text("ntfy 알림 채널이 이미 같은 알림을 보내고 있어서 기본으로 꺼 뒀어요. 켜면 휴대폰(ntfy)과 이 Mac에 둘 다 와요.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else {
                    Text("이미 본 상태는 기억해서, 앱을 다시 켜도 같은 알림을 또 보내지 않아요.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                HStack {
                    Text(notificationStatus).font(.caption).foregroundStyle(.secondary)
                    Spacer()
                    Button("시스템 알림 설정 열기") {
                        if let url = URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension") {
                            NSWorkspace.shared.open(url)
                        }
                    }
                    .controlSize(.small)
                }
            }

            Section("갱신 주기") {
                Picker("앱을 보고 있거나 메뉴를 열었을 때", selection: $pollActive) {
                    ForEach(Poll.choices.filter { $0 <= 120 }, id: \.self) { Text(Poll.label($0)).tag($0) }
                }
                Picker("그 밖에 (백그라운드)", selection: $pollBackground) {
                    ForEach(Poll.choices.filter { $0 >= 60 }, id: \.self) { Text(Poll.label($0)).tag($0) }
                }
            }

            Section("시작") {
                Toggle("로그인할 때 Portboard 열기", isOn: Binding(get: { loginOn }, set: setLogin))
                    .disabled(!LoginItem.available)
                if !LoginItem.available {
                    Text("Portboard.app으로 실행할 때만 쓸 수 있어요 (./build.sh)").font(.caption).foregroundStyle(.secondary)
                } else if LoginItem.needsApproval {
                    HStack {
                        Text("시스템 설정 → 로그인 항목에서 허용이 필요해요").font(.caption)
                        Button("열기") { LoginItem.openSystemSettings() }.controlSize(.small)
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
            Text("/api/whoami로 이 Mac이 누구로 보이는지 확인해요").font(.callout).foregroundStyle(.secondary)
        case .running:
            ProgressView().controlSize(.small)
        case .ok(let lines):
            VStack(alignment: .leading, spacing: 2) {
                ForEach(lines, id: \.self) { Text($0).font(.callout) }
            }
            .textSelection(.enabled)
        case .failed(let message):
            VStack(alignment: .leading, spacing: 2) {
                Text("연결 안 됨: \(message)").foregroundStyle(.red).font(.callout)
                Text(Problem.hint(base: model.base)).font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private func applyServer() {
        guard let url = Server.normalize(serverInput) else {
            serverError = "http:// 또는 https://로 시작하는 주소를 넣어 주세요"
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
            loginError = "바꾸지 못했어요: \(error.localizedDescription)"
        }
        loginOn = LoginItem.isEnabled || LoginItem.needsApproval
    }
}
