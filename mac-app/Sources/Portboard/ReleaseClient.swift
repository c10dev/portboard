import Foundation
import PortboardCore

/// GET api.github.com/repos/c10dev/portboard/releases/latest: the app's only request that leaves the tailnet.
/// Nothing is sent but the User-Agent; no cookies or cache (ephemeral session).
enum ReleaseClient {
    static let timeout: TimeInterval = 15

    static func latest() async -> Result<LatestRelease, APIError> {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = timeout
        config.timeoutIntervalForResource = 30
        config.waitsForConnectivity = false
        let session = URLSession(configuration: config)
        defer { session.finishTasksAndInvalidate() }

        var r = URLRequest(url: UpdateCheck.latestURL)
        r.timeoutInterval = timeout
        r.setValue(AppInfo.userAgent, forHTTPHeaderField: "User-Agent")
        r.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        r.setValue("2022-11-28", forHTTPHeaderField: "X-GitHub-Api-Version")
        do {
            let (data, response) = try await session.data(for: r)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            guard (200..<300).contains(status) else { return .failure(APIError(message: UpdateCheck.failure(httpStatus: status))) }
            guard let release = LatestRelease((try? JSON.parse(data)) ?? .null) else {
                return .failure(APIError(message: L10n.t("mac.update.unreadable")))
            }
            return .success(release)
        } catch let e as URLError {
            return .failure(APIError(message: UpdateCheck.failure(urlErrorCode: e.code.rawValue, timeout: Int(timeout))))
        } catch {
            return .failure(APIError(message: error.localizedDescription))
        }
    }
}
