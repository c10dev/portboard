import Foundation
import PortboardCore

/// A failed request, already in plain words in the app's language (PortboardCore.Problem)
struct APIError: Error {
    let message: String
}

/// Portboard's REST API (docs/api.md) over URLSession. Reads are GETs; the one write (expose) sends X-Portboard: 1,
/// which the server requires for every POST. Through tailscale serve the server knows who is asking, so there is
/// no token here.
final class APIClient: Sendable {
    let base: URL
    private let session: URLSession
    static let timeout: TimeInterval = 8

    init(base: URL) {
        self.base = base
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = Self.timeout
        config.timeoutIntervalForResource = 30
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.waitsForConnectivity = false
        config.httpAdditionalHeaders = ["User-Agent": AppInfo.userAgent, "Accept": "application/json"]
        session = URLSession(configuration: config)
    }

    private func request(_ path: String, method: String = "GET") -> URLRequest {
        var r = URLRequest(url: Server.url(base, path))
        r.httpMethod = method
        r.timeoutInterval = Self.timeout
        r.setValue(AppInfo.userAgent, forHTTPHeaderField: "User-Agent")
        if method != "GET" { r.setValue("1", forHTTPHeaderField: "X-Portboard") }
        return r
    }

    private func send(_ r: URLRequest) async throws -> (Data, Int) {
        do {
            let (data, response) = try await session.data(for: r)
            return (data, (response as? HTTPURLResponse)?.statusCode ?? 0)
        } catch let e as URLError {
            throw APIError(message: Problem.text(urlErrorCode: e.code.rawValue, timeout: Int(Self.timeout)) ?? L10n.t("mac.error.cancelled"))
        } catch {
            throw APIError(message: error.localizedDescription)
        }
    }

    func get(_ path: String) async throws -> JSON {
        let (data, status) = try await send(request(path))
        guard (200..<300).contains(status) else { throw APIError(message: Problem.text(httpStatus: status)) }
        do {
            return try JSON.parse(data)
        } catch {
            throw APIError(message: L10n.t("mac.error.notJSON"))
        }
    }

    /// GET that never throws: the endpoint's result or its error text
    func fetch(_ path: String) async -> Result<JSON, APIError> {
        do { return .success(try await get(path)) } catch let e as APIError { return .failure(e) } catch { return .failure(APIError(message: "\(error)")) }
    }

    /// POST /api/ports/<port>/expose and friends: `{ok, message}`, or `{error, reason}` when refused (403)
    func post(_ path: String) async throws -> ActionReply {
        let (data, status) = try await send(request(path, method: "POST"))
        return ActionReply(status: status, body: (try? JSON.parse(data)) ?? .null)
    }
}
