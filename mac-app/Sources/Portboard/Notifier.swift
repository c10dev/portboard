import Foundation
import PortboardCore
import UserNotifications

/// Native notifications (UserNotifications). Only inside Portboard.app: UNUserNotificationCenter needs a bundle, and
/// calling it from the bare binary (`swift run`) crashes, so every call is guarded.
@MainActor
final class Notifier: NSObject, UNUserNotificationCenterDelegate {
    static let shared = Notifier()

    /// Opens a dashboard path when a notification is clicked (set by the app)
    var onOpen: ((String) -> Void)?

    var available: Bool { AppInfo.isBundled }

    func setUp() {
        guard available else { return }
        UNUserNotificationCenter.current().delegate = self
    }

    /// Asks macOS once; later calls just return the current answer
    func requestAuthorization() async -> Bool {
        guard available else { return false }
        return (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound])) ?? false
    }

    /// "허용됨" / "꺼짐" / … for the settings window
    func authorizationText() async -> String {
        guard available else { return L10n.t("mac.settings.notifyNeedsApp") }
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        switch settings.authorizationStatus {
        case .authorized, .provisional: return L10n.t("mac.settings.notifyAllowed")
        case .denied: return L10n.t("mac.settings.notifyDenied")
        case .notDetermined: return L10n.t("mac.settings.notifyNotAsked")
        default: return L10n.t("mac.settings.notifyUnknown")
        }
    }

    func post(_ e: NotifyEvent) {
        guard available else { return }
        let content = UNMutableNotificationContent()
        content.title = e.title
        content.body = e.body
        content.sound = e.kind == .down ? UNNotificationSound.default : nil
        content.userInfo = ["path": e.path]
        // One group per port (or device) in Notification Center, so its 다운 and 복구 stay together
        content.threadIdentifier = e.thread
        // 다운 may break through Focus, 복구 only goes to the list. Time-sensitive needs an entitlement the ad-hoc
        // build doesn't have, so macOS may treat it as active (docs/mac-app/README.md, Notifications).
        content.interruptionLevel = Self.level(e.level)
        // The same id for down and back: the recovery replaces the down banner
        let request = UNNotificationRequest(identifier: e.id, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request) { _ in }
    }

    /// Not shown because you're looking at that port: take back its earlier banner too (a 다운 that is now 복구)
    func withdraw(_ e: NotifyEvent) {
        guard available else { return }
        UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: [e.id])
    }

    static func level(_ level: NotifyEvent.Level) -> UNNotificationInterruptionLevel {
        switch level {
        case .passive: return .passive
        case .active: return .active
        case .timeSensitive: return .timeSensitive
        }
    }

    // Show banners even while the app is in front
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list, .sound])
    }

    // Clicked: open the page it is about in the dashboard window
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        let path = response.notification.request.content.userInfo["path"] as? String ?? ""
        Task { @MainActor in self.onOpen?(path) }
        completionHandler()
    }
}
