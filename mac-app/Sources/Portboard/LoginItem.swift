import Foundation
import ServiceManagement

/// 로그인할 때 열기: SMAppService.mainApp (macOS 13+). Registers Portboard.app itself; the user can also turn it off
/// in 시스템 설정 → 일반 → 로그인 항목. Needs the app bundle, so it is off for `swift run`.
enum LoginItem {
    static var available: Bool { AppInfo.isBundled }

    static var isEnabled: Bool { available && SMAppService.mainApp.status == .enabled }

    /// macOS wants the user to approve it in 시스템 설정 → 로그인 항목
    static var needsApproval: Bool { available && SMAppService.mainApp.status == .requiresApproval }

    static func set(_ on: Bool) throws {
        guard available else { return }
        if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
    }

    static func openSystemSettings() {
        SMAppService.openSystemSettingsLoginItems()
    }
}
