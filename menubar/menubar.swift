/**
 * dsh-ezpomodoro — menu bar helper.
 *
 * A single-file Cocoa process spawned by the Host half, compiled by swiftc into
 * a bundle-less executable. It owns one NSStatusItem and speaks a line protocol
 * over stdio:
 *
 *   stdin   {"cmd":"show","title":"🍅 24:59","labels":{"toggle":"暂停","reset":"重置","panel":"打开番茄钟"}}
 *           {"cmd":"hide"}
 *           {"cmd":"quit"}
 *   stdout  {"event":"ready"}
 *           {"event":"action","action":"toggle"|"reset"|"panel"}
 *           {"event":"error","message":"..."}
 *
 * The clock lives in the renderer: this process only draws the title the Host
 * sends and reports which menu row was clicked. stdin is read with a
 * DispatchSourceRead so the Cocoa run loop stays free, stdout carries protocol
 * lines only, and diagnostics go to stderr.
 */

import AppKit
import Foundation

private let dshBundleIdentifier = "com.deepseek.dsh"

// MARK: - stdio

/// Write one line to stdout, unbuffered.
private func writeLine(_ line: String) {
    FileHandle.standardOutput.write(Data((line + "\n").utf8))
}

/// Log a diagnostic line on stderr.
private func log(_ message: String) {
    FileHandle.standardError.write(Data(("[dsh-ezpomodoro menubar] " + message + "\n").utf8))
}

/// Quote a string for a hand-built JSON line.
private func jsonString(_ value: String) -> String {
    var out = "\""
    for scalar in value.unicodeScalars {
        switch scalar {
        case "\"": out += "\\\""
        case "\\": out += "\\\\"
        case "\n": out += "\\n"
        case "\r": out += "\\r"
        case "\t": out += "\\t"
        default:
            if scalar.value < 0x20 {
                out += String(format: "\\u%04x", scalar.value)
            } else {
                out.unicodeScalars.append(scalar)
            }
        }
    }
    return out + "\""
}

/// Announce that the run loop is up.
private func emitReady() {
    writeLine("{\"event\":\"ready\"}")
}

/// Report a clicked menu row.
private func emitAction(_ action: String) {
    writeLine("{\"event\":\"action\",\"action\":" + jsonString(action) + "}")
}

/// Report a recoverable failure.
private func emitError(_ message: String) {
    writeLine("{\"event\":\"error\",\"message\":" + jsonString(message) + "}")
}

// MARK: - status item

/// Owns the status item and the dropdown built from the Host labels.
private final class StatusController: NSObject {
    /// Menu rows in display order, used as both action id and label key.
    private static let rows = ["toggle", "reset", "panel"]

    /// Wording used when the Host omits a label.
    private static let fallback = ["toggle": "开始/暂停", "reset": "重置", "panel": "打开番茄钟"]

    private var item: NSStatusItem?
    private var labels: [String: String] = [:]

    /// Create or update the item, rebuilding the menu only when labels change.
    func show(title: String, labels newLabels: [String: String]) {
        let item = self.item ?? makeItem()
        self.item = item
        item.button?.title = title
        if item.menu == nil || newLabels != labels {
            labels = newLabels
            item.menu = buildMenu(labels: newLabels)
        }
    }

    /// Remove the item; the process keeps running for later commands.
    func hide() {
        guard let item = self.item else { return }
        NSStatusBar.system.removeStatusItem(item)
        self.item = nil
        labels = [:]
    }

    /// Allocate a variable-length status item.
    private func makeItem() -> NSStatusItem {
        NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    }

    /// Build the three-row menu, toggle / reset / panel in that order.
    private func buildMenu(labels: [String: String]) -> NSMenu {
        let menu = NSMenu()
        menu.autoenablesItems = false
        for action in StatusController.rows {
            let row = NSMenuItem(
                title: labels[action] ?? StatusController.fallback[action] ?? action,
                action: #selector(rowClicked(_:)),
                keyEquivalent: "",
            )
            row.target = self
            row.representedObject = action
            menu.addItem(row)
        }
        return menu
    }

    /// Activate the DSH application, if it is running.
    private func activateDSH() {
        let running = NSRunningApplication.runningApplications(withBundleIdentifier: dshBundleIdentifier)
        guard let app = running.first else {
            log("DSH application is not running")
            return
        }
        if !app.activate(options: [.activateAllWindows]) {
            log("activation of " + dshBundleIdentifier + " was refused")
        }
    }

    /// Report the clicked row; the panel row activates DSH first.
    @objc private func rowClicked(_ sender: NSMenuItem) {
        guard let action = sender.representedObject as? String else { return }
        if action == "panel" {
            activateDSH()
        }
        emitAction(action)
    }
}

// MARK: - stdin

/// Line-delimited reader over STDIN_FILENO driven by GCD.
private final class StdinLineReader {
    private let queue = DispatchQueue(label: "dsh-ezpomodoro.menubar.stdin")
    private let onLine: (String) -> Void
    private let onClose: () -> Void
    private var source: DispatchSourceRead?
    private var pending = Data()

    init(onLine: @escaping (String) -> Void, onClose: @escaping () -> Void) {
        self.onLine = onLine
        self.onClose = onClose
    }

    /// Start watching stdin; EOF and read errors end the stream.
    func start() {
        let source = DispatchSource.makeReadSource(fileDescriptor: STDIN_FILENO, queue: queue)
        source.setEventHandler { [weak self] in self?.handleReadable() }
        source.resume()
        self.source = source
    }

    /// Read what is available and forward every complete line.
    private func handleReadable() {
        var chunk = [UInt8](repeating: 0, count: 64 * 1024)
        let count = read(STDIN_FILENO, &chunk, chunk.count)
        if count > 0 {
            pending.append(contentsOf: chunk[0..<count])
            splitLines()
            return
        }
        if count == 0 {
            finish()
            return
        }
        if errno == EINTR {
            return
        }
        if errno == EAGAIN || errno == EWOULDBLOCK {
            return
        }
        log("stdin read failed: " + String(cString: strerror(errno)))
        finish()
    }

    /// Emit every newline-terminated line still buffered.
    private func splitLines() {
        while let newline = pending.firstIndex(of: 0x0a) {
            let lineData = pending[pending.startIndex..<newline]
            pending.removeSubrange(pending.startIndex...newline)
            var line = String(decoding: lineData, as: UTF8.self)
            if line.hasSuffix("\r") {
                line.removeLast()
            }
            if !line.isEmpty {
                onLine(line)
            }
        }
    }

    /// Stop the source and report the closed stream once.
    private func finish() {
        pending.removeAll()
        guard let source = self.source else { return }
        self.source = nil
        source.cancel()
        onClose()
    }
}

// MARK: - entry point

/// Wires the status controller to stdin and keeps both alive.
private final class Helper {
    private let controller = StatusController()
    private(set) var reader: StdinLineReader?

    init() {
        let controller = self.controller
        reader = StdinLineReader(
            onLine: { line in
                DispatchQueue.main.async { Helper.handle(line: line, controller: controller) }
            },
            onClose: {
                DispatchQueue.main.async { exit(0) }
            },
        )
    }

    /// Apply one command; unknown or malformed lines are dropped.
    private static func handle(line: String, controller: StatusController) {
        guard
            let data = line.data(using: .utf8),
            let object = try? JSONSerialization.jsonObject(with: data),
            let command = object as? [String: Any],
            let cmd = command["cmd"] as? String
        else {
            return
        }

        switch cmd {
        case "show":
            guard let title = command["title"] as? String else {
                emitError("show needs a string title")
                return
            }
            let labels = (command["labels"] as? [String: Any])?.compactMapValues { $0 as? String } ?? [:]
            controller.show(title: title, labels: labels)
        case "hide":
            controller.hide()
        case "quit":
            controller.hide()
            exit(0)
        default:
            return
        }
    }
}

signal(SIGPIPE, SIG_IGN)

private let app = NSApplication.shared
app.setActivationPolicy(.accessory)
app.finishLaunching()

private let helper = Helper()
emitReady()
helper.reader?.start()

withExtendedLifetime(helper) {
    app.run()
}
