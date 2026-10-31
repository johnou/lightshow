import AppKit
import Foundation

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var window: NSWindow!
    private var statusItem: NSStatusItem!
    private var statusLabel: NSTextField!
    private var addressLabel: NSTextField!
    private var codeLabel: NSTextField!
    private var process: Process?
    private var pipe: Pipe?
    private var accumulated = ""
    private var lastError = ""
    private var localPort = "4177"
    private var phoneAddresses: [String] = []

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        createMenu()
        createWindow()
        startCompanion()
        showWindow(nil)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationWillTerminate(_ notification: Notification) {
        pipe?.fileHandleForReading.readabilityHandler = nil
        if let process, process.isRunning { process.terminate() }
    }

    private func createMenu() {
        let menuBar = NSMenu()
        let item = NSMenuItem(); menuBar.addItem(item)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Show Lightshow", action: #selector(showWindow(_:)), keyEquivalent: "o").target = self
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit Lightshow", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        item.submenu = appMenu; NSApp.mainMenu = menuBar
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.title = "✳"
        let statusMenu = NSMenu()
        statusMenu.addItem(withTitle: "Open Lightshow", action: #selector(showWindow(_:)), keyEquivalent: "").target = self
        statusMenu.addItem(withTitle: "Open controls in browser", action: #selector(openControls(_:)), keyEquivalent: "").target = self
        statusMenu.addItem(.separator())
        statusMenu.addItem(withTitle: "Quit Lightshow", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "")
        statusItem.menu = statusMenu
    }

    private func createWindow() {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 520, height: 405), styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.title = "Lightshow"
        window.center()
        let title = NSTextField(labelWithString: "✳  Lightshow")
        title.font = NSFont.systemFont(ofSize: 27, weight: .bold)
        let subtitle = NSTextField(wrappingLabelWithString: "Your lights, your music, your show. Leave Lightshow running while you control it from your phone.")
        subtitle.textColor = .secondaryLabelColor
        statusLabel = NSTextField(wrappingLabelWithString: "Starting companion…")
        statusLabel.font = NSFont.systemFont(ofSize: 13, weight: .medium)
        addressLabel = NSTextField(wrappingLabelWithString: "Phone address: starting…")
        addressLabel.isSelectable = true
        codeLabel = NSTextField(labelWithString: "Connection code: starting…")
        codeLabel.isSelectable = true
        codeLabel.font = NSFont.monospacedSystemFont(ofSize: 15, weight: .semibold)
        let open = NSButton(title: "Open controls on this Mac", target: self, action: #selector(openControls(_:)))
        open.bezelStyle = .rounded
        let help = NSTextField(wrappingLabelWithString: "On your phone, connect to the same Wi-Fi and open the phone address above. For music sync, macOS may ask Lightshow for Screen & System Audio Recording access.")
        help.textColor = .secondaryLabelColor
        help.font = NSFont.systemFont(ofSize: 11)
        let stack = NSStackView(views: [title, subtitle, statusLabel, addressLabel, codeLabel, open, help])
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 14
        stack.translatesAutoresizingMaskIntoConstraints = false
        window.contentView?.addSubview(stack)
        guard let view = window.contentView else { return }
        NSLayoutConstraint.activate([stack.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 28), stack.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -28), stack.topAnchor.constraint(equalTo: view.topAnchor, constant: 25)])
    }

    @objc private func showWindow(_ sender: Any?) { window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true) }
    @objc private func openControls(_ sender: Any?) { if let url = URL(string: "http://localhost:\(localPort)/") { NSWorkspace.shared.open(url) } }

    private func startCompanion() {
        guard let resources = Bundle.main.resourceURL, let executable = Bundle.main.executableURL else { statusLabel.stringValue = "Could not locate application resources."; return }
        do {
            let support = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true).appendingPathComponent("Lightshow", isDirectory: true)
            try FileManager.default.createDirectory(at: support, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            if let legacy = try? String(contentsOf: resources.appendingPathComponent("legacy-path.txt"), encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines), !legacy.isEmpty {
                for filename in [".lightshow.json", ".lightshow-govee.json"] {
                    let source = URL(fileURLWithPath: legacy).appendingPathComponent(filename)
                    let destination = support.appendingPathComponent(filename)
                    if !FileManager.default.fileExists(atPath: destination.path), FileManager.default.fileExists(atPath: source.path) { try FileManager.default.copyItem(at: source, to: destination) }
                }
            }
            let task = Process()
            task.executableURL = executable.deletingLastPathComponent().appendingPathComponent("node")
            task.arguments = [resources.appendingPathComponent("server.js").path]
            task.currentDirectoryURL = resources
            var env = ProcessInfo.processInfo.environment
            env["LIGHTSHOW_LAN"] = "1"
            env["LIGHTSHOW_DATA_DIR"] = support.path
            env["LIGHTSHOW_APP_EXECUTABLE"] = executable.path
            env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
            if let requestedPort = env["LIGHTSHOW_APP_PORT"], Int(requestedPort) != nil { env["PORT"] = requestedPort; localPort = requestedPort }
            task.environment = env
            let output = Pipe(); pipe = output; task.standardOutput = output; task.standardError = output
            output.fileHandleForReading.readabilityHandler = { [weak self] file in
                let data = file.availableData
                guard !data.isEmpty, let string = String(data: data, encoding: .utf8) else { return }
                DispatchQueue.main.async { self?.consume(string) }
            }
            task.terminationHandler = { [weak self] task in DispatchQueue.main.async {
                guard let self else { return }
                if task.terminationStatus != 0 { self.statusLabel.stringValue = self.lastError.contains("EADDRINUSE") ? "Port 4177 is already in use. Stop the terminal companion, then quit and reopen Lightshow." : "Companion stopped unexpectedly. Quit and reopen Lightshow." }
                else { self.statusLabel.stringValue = "Companion stopped." }
            }}
            process = task
            try task.run()
        } catch { statusLabel.stringValue = "Could not start Lightshow: \(error.localizedDescription)" }
    }

    private func consume(_ text: String) {
        accumulated += text
        while let newline = accumulated.firstIndex(of: "\n") {
            let line = String(accumulated[..<newline]); accumulated.removeSubrange(...newline)
            if line.contains("EADDRINUSE") { lastError = line }
            if line.hasPrefix("Lightshow companion running") { statusLabel.stringValue = "●  Ready on your local network" }
            if line.hasPrefix("Phone on your Wi-Fi: ") {
                let address = line.replacingOccurrences(of: "Phone on your Wi-Fi: ", with: "")
                if !phoneAddresses.contains(address) { phoneAddresses.append(address) }
                addressLabel.stringValue = "Phone address:\n" + phoneAddresses.joined(separator: "\n")
            }
            if line.hasPrefix("Connection code: ") { codeLabel.stringValue = line }
        }
    }
}

if CommandLine.arguments.count > 1, CommandLine.arguments[1] == "--capture-audio" {
    runSystemAudio()
} else if CommandLine.arguments.count == 3, CommandLine.arguments[1] == "--media" {
    runMediaKey(CommandLine.arguments[2])
} else {
    let app = NSApplication.shared
    let delegate = AppDelegate()
    app.delegate = delegate
    app.run()
}
