import AppKit
import Darwin
import Foundation

private let defaultConfigURL = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library/Application Support/PiOutlinerLink/config.json")
private let logURL = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library/Logs/PiOutlinerLink.log")
private let bundledConfigPathKey = "PiOutlinerLinkConfigPath"

private struct HandlerConfig: Codable, Equatable {
    let host: String
    let workspace: String
    let remoteBun: String

    func validate() throws {
        guard !host.hasPrefix("-"), host.range(of: #"^[A-Za-z0-9._@-]+$"#, options: .regularExpression) != nil else {
            throw HandlerError.invalidConfig("host must be an SSH host or user@host without shell syntax")
        }
        guard workspace.hasPrefix("/"), !containsTerminalControl(workspace) else {
            throw HandlerError.invalidConfig("workspace must be an absolute control-free path")
        }
        guard remoteBun.hasPrefix("/"), !containsTerminalControl(remoteBun) else {
            throw HandlerError.invalidConfig("remoteBun must be an absolute control-free path")
        }
    }
}

private struct LinkRoute: Equatable {
    enum Kind: String {
        case block
        case goto
        case page
        case work
    }

    let kind: Kind
    let target: String
}

private enum HandlerError: LocalizedError {
    case invalidURL(String)
    case invalidConfig(String)
    case remoteFailure(String)

    var errorDescription: String? {
        switch self {
        case .invalidURL(let message): return "Invalid pi-outliner link: \(message)"
        case .invalidConfig(let message): return "Invalid Pi Outliner Link configuration: \(message)"
        case .remoteFailure(let message): return "Remote outliner navigation failed: \(message)"
        }
    }
}

private final class DataCapture: @unchecked Sendable {
    var data = Data()
}

private func containsTerminalControl(_ value: String) -> Bool {
    value.unicodeScalars.contains { scalar in
        scalar.value < 0x20 || scalar.value == 0x7f
    }
}

private func parseRoute(_ rawURL: String) throws -> LinkRoute {
    guard let components = URLComponents(string: rawURL),
          components.scheme == "pi-outliner",
          components.user == nil,
          components.password == nil,
          components.port == nil,
          components.query == nil,
          components.fragment == nil,
          let host = components.host,
          let kind = LinkRoute.Kind(rawValue: host)
    else {
        throw HandlerError.invalidURL("unsupported structure")
    }
    guard components.percentEncodedPath.hasPrefix("/") else {
        throw HandlerError.invalidURL("missing target")
    }
    let encodedTarget = String(components.percentEncodedPath.dropFirst())
    guard let target = encodedTarget.removingPercentEncoding,
          !target.isEmpty,
          !containsTerminalControl(target)
    else {
        throw HandlerError.invalidURL("invalid target encoding")
    }

    switch kind {
    case .block:
        guard target.range(of: #"^[A-Za-z0-9_-]{8,}$"#, options: .regularExpression) != nil else {
            throw HandlerError.invalidURL("malformed block ID")
        }
    case .goto, .work:
        guard target.range(
            of: #"^[A-Za-z][A-Za-z0-9]{0,15}-[0-9]+$"#,
            options: .regularExpression
        ) != nil else {
            throw HandlerError.invalidURL("malformed \(kind.rawValue) Work ID")
        }
    case .page:
        break
    }
    return LinkRoute(kind: kind, target: target)
}

private func shellQuote(_ value: String) -> String {
    "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'"
}

private func configURL() -> URL {
    if let override = ProcessInfo.processInfo.environment["PI_OUTLINER_LINK_CONFIG"], !override.isEmpty {
        return URL(fileURLWithPath: override)
    }
    if let bundledPath = Bundle.main.object(forInfoDictionaryKey: bundledConfigPathKey) as? String,
       !bundledPath.isEmpty {
        return URL(fileURLWithPath: bundledPath)
    }
    return defaultConfigURL
}

private func loadConfig() throws -> HandlerConfig {
    let url = configURL()
    let data: Data
    do {
        data = try Data(contentsOf: url)
    } catch {
        throw HandlerError.invalidConfig("cannot read \(url.path)")
    }
    let config: HandlerConfig
    do {
        config = try JSONDecoder().decode(HandlerConfig.self, from: data)
    } catch {
        throw HandlerError.invalidConfig("cannot decode \(url.path)")
    }
    try config.validate()
    return config
}

private func writeConfig(path: String, host: String, workspace: String, remoteBun: String) throws {
    let config = HandlerConfig(host: host, workspace: workspace, remoteBun: remoteBun)
    try config.validate()
    let url = URL(fileURLWithPath: path)
    try FileManager.default.createDirectory(
        at: url.deletingLastPathComponent(),
        withIntermediateDirectories: true,
        attributes: nil
    )
    let encoder = JSONEncoder()
    try encoder.encode(config).write(to: url, options: .atomic)
}

private func appendLog(_ message: String) {
    let timestamp = ISO8601DateFormatter().string(from: Date())
    let line = "[\(timestamp)] \(message)\n"
    let data = Data(line.utf8)
    try? FileManager.default.createDirectory(
        at: logURL.deletingLastPathComponent(),
        withIntermediateDirectories: true,
        attributes: nil
    )
    if FileManager.default.fileExists(atPath: logURL.path), let handle = try? FileHandle(forWritingTo: logURL) {
        defer { try? handle.close() }
        _ = try? handle.seekToEnd()
        _ = try? handle.write(contentsOf: data)
    } else {
        try? data.write(to: logURL, options: .atomic)
    }
}

private func navigate(_ rawURL: String) throws {
    let route = try parseRoute(rawURL)
    let config = try loadConfig()
    let remoteCommand = [
        "cd -- \(shellQuote(config.workspace))",
        "\(shellQuote(config.remoteBun)) run src/cli.ts link --url \(shellQuote(rawURL))",
    ].joined(separator: " && ")

    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/ssh")
    process.arguments = [
        "-o", "BatchMode=yes",
        "-o", "ConnectTimeout=8",
        config.host,
        remoteCommand,
    ]
    let stdout = Pipe()
    let stderr = Pipe()
    process.standardOutput = stdout
    process.standardError = stderr
    let terminated = DispatchSemaphore(value: 0)
    process.terminationHandler = { _ in terminated.signal() }
    do {
        try process.run()
    } catch {
        throw HandlerError.remoteFailure("could not start /usr/bin/ssh")
    }

    let outputCapture = DataCapture()
    let errorCapture = DataCapture()
    let readers = DispatchGroup()
    readers.enter()
    DispatchQueue.global(qos: .utility).async {
        outputCapture.data = stdout.fileHandleForReading.readDataToEndOfFile()
        readers.leave()
    }
    readers.enter()
    DispatchQueue.global(qos: .utility).async {
        errorCapture.data = stderr.fileHandleForReading.readDataToEndOfFile()
        readers.leave()
    }

    let commandTimeout: TimeInterval = 15
    let timedOut = terminated.wait(timeout: .now() + commandTimeout) == .timedOut
    if timedOut {
        process.terminate()
        if terminated.wait(timeout: .now() + 2) == .timedOut {
            Darwin.kill(process.processIdentifier, SIGKILL)
            _ = terminated.wait(timeout: .now() + 2)
        }
    }
    readers.wait()
    if timedOut {
        throw HandlerError.remoteFailure("ssh command timed out after \(Int(commandTimeout)) seconds")
    }

    let output = String(data: outputCapture.data, encoding: .utf8) ?? ""
    let errorOutput = String(data: errorCapture.data, encoding: .utf8) ?? ""
    appendLog("\(route.kind.rawValue) \(route.target): exit \(process.terminationStatus); \(output.trimmingCharacters(in: .whitespacesAndNewlines))")
    guard process.terminationStatus == 0 else {
        let detail = errorOutput.trimmingCharacters(in: .whitespacesAndNewlines)
        throw HandlerError.remoteFailure(detail.isEmpty ? "ssh exited \(process.terminationStatus)" : detail)
    }
}

private func showFailure(_ error: Error) {
    appendLog(error.localizedDescription)
    NSApp.setActivationPolicy(.regular)
    NSApp.activate(ignoringOtherApps: true)
    let alert = NSAlert()
    alert.alertStyle = .warning
    alert.messageText = "Pi Outliner Link"
    alert.informativeText = error.localizedDescription
    alert.runModal()
}

private func runSelfTests() throws {
    let blockID = "550e8400-e29b-41d4-a716-446655440000"
    guard try parseRoute("pi-outliner://block/\(blockID)") == LinkRoute(kind: .block, target: blockID) else {
        throw HandlerError.invalidURL("block self-test failed")
    }
    guard try parseRoute("pi-outliner://goto/PIE-133") == LinkRoute(kind: .goto, target: "PIE-133") else {
        throw HandlerError.invalidURL("goto self-test failed")
    }
    guard try parseRoute("pi-outliner://work/PIE-133") == LinkRoute(kind: .work, target: "PIE-133") else {
        throw HandlerError.invalidURL("work self-test failed")
    }
    guard try parseRoute("pi-outliner://work/ABC-001") == LinkRoute(kind: .work, target: "ABC-001") else {
        throw HandlerError.invalidURL("custom-prefix work self-test failed")
    }
    guard try parseRoute("pi-outliner://page/Research%20Notes") == LinkRoute(kind: .page, target: "Research Notes") else {
        throw HandlerError.invalidURL("page self-test failed")
    }
    for invalid in [
        "https://example.com",
        "pi-outliner://work/arbitrary",
        "pi-outliner://goto/arbitrary",
        "pi-outliner://goto/PIE-133?query=yes",
        "pi-outliner://goto/%1Bowned",
        "pi-outliner://block/short",
    ] {
        var rejected = false
        do {
            _ = try parseRoute(invalid)
        } catch {
            rejected = true
        }
        if !rejected {
            throw HandlerError.invalidURL("accepted invalid self-test URI: \(invalid)")
        }
    }
    let config = HandlerConfig(host: "evan@float-box", workspace: "/home/evan/test", remoteBun: "/home/evan/.bun/bin/bun")
    try config.validate()
    guard shellQuote("a'b") == "'a'\\''b'" else {
        throw HandlerError.invalidConfig("shell quoting self-test failed")
    }
}

private final class AppDelegate: NSObject, NSApplicationDelegate {
    private var handledURL = false

    func applicationDidFinishLaunching(_: Notification) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
            if !self.handledURL { NSApp.terminate(nil) }
        }
    }

    func application(_: NSApplication, open urls: [URL]) {
        guard let url = urls.first else { return }
        handle(url.absoluteString)
    }

    private func handle(_ rawURL: String) {
        guard !handledURL else { return }
        handledURL = true
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                try navigate(rawURL)
                DispatchQueue.main.async { NSApp.terminate(nil) }
            } catch {
                DispatchQueue.main.async {
                    showFailure(error)
                    NSApp.terminate(nil)
                }
            }
        }
    }
}

let arguments = CommandLine.arguments
if arguments.count >= 2, arguments[1] == "--self-test" {
    do {
        try runSelfTests()
        print("PiOutlinerLink self-test passed")
        exit(0)
    } catch {
        fputs("\(error.localizedDescription)\n", stderr)
        exit(1)
    }
}
if arguments.count == 6, arguments[1] == "--write-config" {
    do {
        try writeConfig(path: arguments[2], host: arguments[3], workspace: arguments[4], remoteBun: arguments[5])
        exit(0)
    } catch {
        fputs("\(error.localizedDescription)\n", stderr)
        exit(1)
    }
}

let application = NSApplication.shared
private let delegate = AppDelegate()
application.delegate = delegate
application.setActivationPolicy(.accessory)
application.run()
