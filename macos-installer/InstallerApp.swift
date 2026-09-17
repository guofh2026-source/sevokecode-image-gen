import AppKit
import CryptoKit
import Foundation

private let releaseAPIURL = URL(string: "https://gitee.com/api/v5/repos/sevokecodes/sevokecode-image-gen/releases/latest")!
private let productName = "Sevokecode Image Gen"

#if APPLE_SILICON
private let platformID = "macos-arm64"
#else
private let platformID = "macos-x64"
#endif

private struct ReleaseAsset: Decodable {
    let name: String
    let browserDownloadURL: URL?
    let downloadURL: URL?

    enum CodingKeys: String, CodingKey {
        case name
        case browserDownloadURL = "browser_download_url"
        case downloadURL = "download_url"
    }

    var url: URL? { browserDownloadURL ?? downloadURL }
}

private struct LatestRelease: Decodable {
    let tagName: String
    let assets: [ReleaseAsset]

    enum CodingKeys: String, CodingKey {
        case tagName = "tag_name"
        case assets
    }
}

private enum InstallerError: LocalizedError {
    case invalidResponse
    case missingAsset(String)
    case invalidChecksum
    case checksumMismatch
    case processFailed(String)
    case invalidConfig

    var errorDescription: String? {
        switch self {
        case .invalidResponse: return "无法读取 Gitee 最新版本信息。"
        case .missingAsset(let name): return "最新版本缺少安装文件：\(name)"
        case .invalidChecksum: return "无法读取安装包校验值。"
        case .checksumMismatch: return "安装包 SHA-256 校验失败。"
        case .processFailed(let message): return message
        case .invalidConfig: return "安装后的配置文件无效。"
        }
    }
}

private final class InstallerService: @unchecked Sendable {
    private let fileManager = FileManager.default

    func install(apiKey: String, status: @escaping (String) -> Void) throws {
        status("正在获取 Gitee 最新版本…")
        let release: LatestRelease = try fetchJSON(releaseAPIURL)
        let version = release.tagName.hasPrefix("v") ? String(release.tagName.dropFirst()) : release.tagName
        let archiveName = "sevokecode-image-gen-\(platformID)-v\(version).zip"
        let checksumName = "SHA256SUMS.txt"
        guard let archiveURL = release.assets.first(where: { $0.name == archiveName })?.url else {
            throw InstallerError.missingAsset(archiveName)
        }
        guard let checksumURL = release.assets.first(where: { $0.name == checksumName })?.url else {
            throw InstallerError.missingAsset(checksumName)
        }

        let temporaryRoot = fileManager.temporaryDirectory
            .appendingPathComponent("sevokecode-image-gen-installer-\(UUID().uuidString)", isDirectory: true)
        try fileManager.createDirectory(at: temporaryRoot, withIntermediateDirectories: true)
        defer { try? fileManager.removeItem(at: temporaryRoot) }

        status("正在下载 \(release.tagName)…")
        let archiveData = try fetchData(archiveURL)
        let checksumData = try fetchData(checksumURL)
        guard let checksumText = String(data: checksumData, encoding: .utf8),
              let expectedChecksum = checksum(in: checksumText, for: archiveName) else {
            throw InstallerError.invalidChecksum
        }
        let actualChecksum = SHA256.hash(data: archiveData).map { String(format: "%02x", $0) }.joined()
        guard actualChecksum.caseInsensitiveCompare(expectedChecksum) == .orderedSame else {
            throw InstallerError.checksumMismatch
        }

        status("正在安装…")
        let archivePath = temporaryRoot.appendingPathComponent(archiveName)
        try archiveData.write(to: archivePath, options: .atomic)
        let unpackRoot = temporaryRoot.appendingPathComponent("unpacked", isDirectory: true)
        try fileManager.createDirectory(at: unpackRoot, withIntermediateDirectories: true)
        try run("/usr/bin/ditto", ["-x", "-k", archivePath.path, unpackRoot.path])

        let packageRoot = unpackRoot.appendingPathComponent("sevokecode-image-gen-\(platformID)", isDirectory: true)
        let executable = packageRoot.appendingPathComponent("bin/sevokecode-image-gen")
        let home = fileManager.homeDirectoryForCurrentUser
        let installRoot = home.appendingPathComponent(".codex/skills/sevokecode-image-gen", isDirectory: true)
        let codexConfig = home.appendingPathComponent(".codex/config.toml")
        try run(executable.path, [
            "install",
            "--install-dir", installRoot.path,
            "--config-path", codexConfig.path,
        ])

        let installedConfig = installRoot.appendingPathComponent("config.json")
        guard var config = try JSONSerialization.jsonObject(with: Data(contentsOf: installedConfig)) as? [String: Any] else {
            throw InstallerError.invalidConfig
        }
        config["apiKey"] = apiKey
        let configData = try JSONSerialization.data(withJSONObject: config, options: [.prettyPrinted, .sortedKeys]) + Data("\n".utf8)
        try configData.write(to: installedConfig, options: [.atomic])
        try fileManager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: installedConfig.path)
        try run(installRoot.appendingPathComponent("bin/sevokecode-image-gen").path, ["--help"])
    }

    private func fetchJSON<T: Decodable>(_ url: URL) throws -> T {
        try JSONDecoder().decode(T.self, from: fetchData(url))
    }

    private func fetchData(_ url: URL) throws -> Data {
        let semaphore = DispatchSemaphore(value: 0)
        var result: Result<Data, Error>?
        var request = URLRequest(url: url)
        request.timeoutInterval = 60
        request.setValue("sevokecode-image-gen-installer", forHTTPHeaderField: "User-Agent")
        URLSession.shared.dataTask(with: request) { data, response, error in
            defer { semaphore.signal() }
            if let error { result = .failure(error); return }
            guard let http = response as? HTTPURLResponse,
                  (200...299).contains(http.statusCode),
                  let data else {
                result = .failure(InstallerError.invalidResponse)
                return
            }
            result = .success(data)
        }.resume()
        semaphore.wait()
        return try result?.get() ?? { throw InstallerError.invalidResponse }()
    }

    private func checksum(in manifest: String, for fileName: String) -> String? {
        for line in manifest.split(whereSeparator: \.isNewline) {
            let fields = line.split(maxSplits: 1, whereSeparator: \.isWhitespace).map(String.init)
            guard fields.count == 2 else { continue }
            let listedName = fields[1].trimmingCharacters(in: CharacterSet(charactersIn: " *"))
            if listedName == fileName, fields[0].range(of: "^[0-9a-fA-F]{64}$", options: String.CompareOptions.regularExpression) != nil {
                return fields[0]
            }
        }
        return nil
    }

    private func run(_ executable: String, _ arguments: [String]) throws {
        let process = Process()
        let output = Pipe()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        process.standardOutput = output
        process.standardError = output
        do {
            try process.run()
        } catch {
            throw InstallerError.processFailed("无法启动安装程序：\(error.localizedDescription)")
        }
        process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            let data = output.fileHandleForReading.readDataToEndOfFile()
            let detail = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
            throw InstallerError.processFailed(detail?.isEmpty == false ? detail! : "安装程序执行失败。")
        }
    }
}

@MainActor
private final class AppDelegate: NSObject, NSApplicationDelegate, NSTextFieldDelegate {
    private let service = InstallerService()
    private let apiKeyField = NSSecureTextField()
    private let installButton = NSButton(title: "安装", target: nil, action: nil)
    private let statusLabel = NSTextField(labelWithString: "")
    private let progress = NSProgressIndicator()
    private var window: NSWindow!

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildWindow()
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func controlTextDidChange(_ obj: Notification) {
        installButton.isEnabled = !apiKeyField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    @objc private func install() {
        let apiKey = apiKeyField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !apiKey.isEmpty else { return }
        setInstalling(true)
        statusLabel.stringValue = "正在准备安装…"
        DispatchQueue.global(qos: .userInitiated).async { [service] in
            do {
                try service.install(apiKey: apiKey) { message in
                    DispatchQueue.main.async { [weak self] in self?.statusLabel.stringValue = message }
                }
                DispatchQueue.main.async { [weak self] in
                    self?.setInstalling(false)
                    self?.apiKeyField.stringValue = ""
                    self?.statusLabel.textColor = .systemGreen
                    self?.statusLabel.stringValue = "安装完成，请重新启动 Codex。"
                    self?.installButton.isEnabled = false
                }
            } catch {
                DispatchQueue.main.async { [weak self] in
                    self?.setInstalling(false)
                    self?.statusLabel.textColor = .systemRed
                    self?.statusLabel.stringValue = error.localizedDescription
                }
            }
        }
    }

    private func setInstalling(_ installing: Bool) {
        apiKeyField.isEnabled = !installing
        installButton.isEnabled = !installing && !apiKeyField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        if installing { progress.startAnimation(nil) } else { progress.stopAnimation(nil) }
        if installing { statusLabel.textColor = .secondaryLabelColor }
    }

    private func buildWindow() {
        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 460, height: 238),
            styleMask: [.titled, .closable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        window.title = productName
        window.center()
        window.isReleasedWhenClosed = false

        let title = NSTextField(labelWithString: productName)
        title.font = .systemFont(ofSize: 22, weight: .semibold)

        let keyLabel = NSTextField(labelWithString: "API Key")
        keyLabel.font = .systemFont(ofSize: 13, weight: .medium)
        apiKeyField.placeholderString = "请输入 API Key"
        apiKeyField.delegate = self
        apiKeyField.font = .monospacedSystemFont(ofSize: 13, weight: .regular)

        installButton.bezelStyle = .rounded
        installButton.keyEquivalent = "\r"
        installButton.target = self
        installButton.action = #selector(install)
        installButton.isEnabled = false

        progress.style = .spinning
        progress.controlSize = .small
        progress.isDisplayedWhenStopped = false
        statusLabel.textColor = .secondaryLabelColor
        statusLabel.lineBreakMode = .byWordWrapping
        statusLabel.maximumNumberOfLines = 2

        let statusRow = NSStackView(views: [progress, statusLabel])
        statusRow.orientation = .horizontal
        statusRow.spacing = 8
        statusRow.alignment = .centerY

        let buttonRow = NSStackView(views: [NSView(), installButton])
        buttonRow.orientation = .horizontal

        let stack = NSStackView(views: [title, keyLabel, apiKeyField, statusRow, buttonRow])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 10
        stack.translatesAutoresizingMaskIntoConstraints = false
        window.contentView?.addSubview(stack)

        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: window.contentView!.leadingAnchor, constant: 28),
            stack.trailingAnchor.constraint(equalTo: window.contentView!.trailingAnchor, constant: -28),
            stack.topAnchor.constraint(equalTo: window.contentView!.topAnchor, constant: 25),
            apiKeyField.widthAnchor.constraint(equalTo: stack.widthAnchor),
            apiKeyField.heightAnchor.constraint(equalToConstant: 28),
            statusRow.widthAnchor.constraint(equalTo: stack.widthAnchor),
            statusLabel.widthAnchor.constraint(lessThanOrEqualTo: statusRow.widthAnchor, constant: -24),
            buttonRow.widthAnchor.constraint(equalTo: stack.widthAnchor),
            installButton.widthAnchor.constraint(equalToConstant: 86),
            installButton.heightAnchor.constraint(equalToConstant: 30),
        ])
        window.makeKeyAndOrderFront(nil)
        window.makeFirstResponder(apiKeyField)
    }
}

@main
private struct InstallerApplication {
    @MainActor
    static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.regular)
        app.run()
    }
}
