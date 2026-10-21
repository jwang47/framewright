// Framewright for macOS: a native window around the local Framewright server.
//
// The app bundles the framewright Python package, starts it on a free
// loopback port with the user's Python 3.10+, and shows it in a WKWebView.
// The page talks back through the "framewright" message handler (see
// native() in web/app.js) for notifications, Dock progress and keeping the
// Mac awake while an import runs. Build with macos/build.sh.

import AppKit
import UserNotifications
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate,
    WKScriptMessageHandler, NSWindowDelegate, UNUserNotificationCenterDelegate {
    var window: NSWindow!
    var web: WKWebView!
    var server: Process?
    var port = 0
    var log = ""
    var importing = false
    var terminating = false
    var awake: NSObjectProtocol?
    let progress = NSProgressIndicator()

    // MARK: launch

    func applicationDidFinishLaunching(_ note: Notification) {
        buildMenu()
        buildWindow()
        UNUserNotificationCenter.current().delegate = self
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }
        NSWorkspace.shared.notificationCenter.addObserver(
            self, selector: #selector(volumeMounted(_:)), name: NSWorkspace.didMountNotification, object: nil)
        startServer()
    }

    func buildWindow() {
        let config = WKWebViewConfiguration()
        config.userContentController.add(self, name: "framewright")
        // Tells the page it is in the app, so the header clears the window buttons.
        config.userContentController.addUserScript(WKUserScript(
            source: "document.documentElement.classList.add('mac-app')",
            injectionTime: .atDocumentStart, forMainFrameOnly: true))
        config.mediaTypesRequiringUserActionForPlayback = []
        config.preferences.isElementFullscreenEnabled = true
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self
        web.uiDelegate = self
        web.isInspectable = true
        web.allowsMagnification = true
        web.setValue(false, forKey: "drawsBackground")
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                          backing: .buffered, defer: false)
        window.title = "Framewright"
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.backgroundColor = NSColor(white: 0.067, alpha: 1)
        window.appearance = NSAppearance(named: .darkAqua)
        window.delegate = self
        window.contentView = web
        window.center()
        window.setFrameAutosaveName("Framewright")
        window.tabbingMode = .disallowed
        web.loadHTMLString(splash("Starting Framewright…"), baseURL: nil)
        window.makeKeyAndOrderFront(nil)
    }

    func splash(_ message: String, detail: String = "") -> String {
        let esc = { (s: String) in s.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;") }
        return """
        <html><body style="margin:0;height:100vh;display:flex;flex-direction:column;align-items:center;
        justify-content:center;background:#111;color:#e8e8e8;font:14px -apple-system">
        <div style="width:160px;height:2px;background:#2c2c2c;overflow:hidden;border-radius:1px;margin-bottom:18px">
        <div style="width:40%;height:100%;background:#ffb020;animation:s 1s ease-in-out infinite"></div></div>
        <div>\(esc(message))</div><pre style="color:#8a8a8a;font-size:11px;max-width:80vw;white-space:pre-wrap">\(esc(detail))</pre>
        <style>@keyframes s{from{transform:translateX(-100%)}to{transform:translateX(250%)}}</style></body></html>
        """
    }

    // MARK: server

    /// A Python 3.10+ interpreter; GUI apps don't inherit the shell's PATH.
    func findPython() -> String? {
        var candidates = ["/opt/homebrew/bin/python3", "/usr/local/bin/python3"]
        for v in ["3.14", "3.13", "3.12", "3.11", "3.10"] {
            candidates.append("/Library/Frameworks/Python.framework/Versions/\(v)/bin/python3")
            candidates.append("/opt/homebrew/bin/python\(v)")
        }
        candidates.append("/usr/bin/python3")
        for path in candidates where FileManager.default.isExecutableFile(atPath: path) {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: path)
            p.arguments = ["-c", "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)"]
            p.standardOutput = FileHandle.nullDevice
            p.standardError = FileHandle.nullDevice
            if (try? p.run()) != nil {
                p.waitUntilExit()
                if p.terminationStatus == 0 { return path }
            }
        }
        return nil
    }

    func freePort() -> Int {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        defer { close(fd) }
        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        addr.sin_port = 0
        var len = socklen_t(MemoryLayout<sockaddr_in>.size)
        let size = len
        _ = withUnsafeMutablePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(fd, $0, size) } }
        _ = withUnsafeMutablePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &len) } }
        return Int(UInt16(bigEndian: addr.sin_port))
    }

    func startServer() {
        guard let python = findPython() else {
            web.loadHTMLString(splash("Framewright needs Python 3.10 or newer.",
                                      detail: "Install it with: brew install python"), baseURL: nil)
            return
        }
        // A dev build (build.sh --dev) runs the checkout it was built from, with
        // the server's hot reload: code changes restart it, page changes reload.
        let live = (Bundle.main.object(forInfoDictionaryKey: "FramewrightSource") as? String).map { URL(fileURLWithPath: $0) }
        let dev = live.map { FileManager.default.fileExists(atPath: $0.appendingPathComponent("framewright/__main__.py").path) } ?? false
        let code = dev ? live! : Bundle.main.resourceURL!.appendingPathComponent("app")
        port = freePort()
        let p = Process()
        p.executableURL = URL(fileURLWithPath: python)
        p.arguments = ["-m", "framewright", "--no-browser", "--port", String(port)] + (dev ? [] : ["--no-reload"])
        if dev { window.title = "Framewright (dev)" }
        p.currentDirectoryURL = code
        var env = ProcessInfo.processInfo.environment
        env["PYTHONPATH"] = code.path
        env["PYTHONUNBUFFERED"] = "1"
        // So the server finds ffmpeg, ImageMagick and Chrome from Homebrew.
        env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:" + (env["PATH"] ?? "")
        p.environment = env
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = pipe
        pipe.fileHandleForReading.readabilityHandler = { [weak self] h in
            let s = String(decoding: h.availableData, as: UTF8.self)
            DispatchQueue.main.async { self?.log = String(((self?.log ?? "") + s).suffix(4000)) }
        }
        p.terminationHandler = { [weak self] proc in
            DispatchQueue.main.async {
                guard let self, self.server === proc, !self.terminating else { return }
                self.web.loadHTMLString(self.splash("The Framewright server stopped.", detail: self.log), baseURL: nil)
            }
        }
        do { try p.run() } catch {
            web.loadHTMLString(splash("Couldn't start the server.", detail: "\(error)"), baseURL: nil)
            return
        }
        server = p
        waitForServer(tries: 100)
    }

    var base: URL { URL(string: "http://127.0.0.1:\(port)/")! }

    func waitForServer(tries: Int) {
        URLSession.shared.dataTask(with: base) { [weak self] _, response, _ in
            DispatchQueue.main.async {
                guard let self else { return }
                if (response as? HTTPURLResponse) != nil {
                    self.web.load(URLRequest(url: self.restoreURL()))
                } else if tries > 0, self.server?.isRunning == true {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { self.waitForServer(tries: tries - 1) }
                } else {
                    self.web.loadHTMLString(self.splash("The Framewright server didn't start.", detail: self.log), baseURL: nil)
                }
            }
        }.resume()
    }

    /// Reopen on the last view; the page keeps its state in the query string.
    func restoreURL() -> URL {
        if let q = UserDefaults.standard.string(forKey: "lastQuery"), q.hasPrefix("?"),
           let url = URL(string: q, relativeTo: base) { return url }
        return base
    }

    func stopServer() {
        guard let p = server, p.isRunning else { return }
        server = nil
        p.terminate()
        DispatchQueue.global().asyncAfter(deadline: .now() + 3) { if p.isRunning { kill(p.processIdentifier, SIGKILL) } }
    }

    // MARK: lifecycle

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard importing else { return .terminateNow }
        let alert = NSAlert()
        alert.messageText = "An import is still running."
        alert.informativeText = "Quitting stops it partway. Files already copied are kept and verified; the rest import next time."
        alert.addButton(withTitle: "Keep Importing")
        alert.addButton(withTitle: "Quit Anyway")
        return alert.runModal() == .alertFirstButtonReturn ? .terminateCancel : .terminateNow
    }

    func applicationWillTerminate(_ note: Notification) {
        if let url = web.url, url.host == "127.0.0.1", let q = url.query { UserDefaults.standard.set("?" + q, forKey: "lastQuery") }
        terminating = true
        stopServer()
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
        window.makeKeyAndOrderFront(nil)
        return true
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        // Closing hides, so an import keeps going and ⌘-Tab brings it back.
        window.orderOut(nil)
        return false
    }

    // MARK: page → app

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        switch type {
        case "notify":
            notify(title: body["title"] as? String ?? "Framewright", body: body["body"] as? String ?? "")
        case "drag":
            // The header is the title bar: drag it to move, double-click to zoom.
            if let event = NSApp.currentEvent, event.type == .leftMouseDown || event.type == .leftMouseDragged {
                window.performDrag(with: event)
            }
        case "zoom":
            window.performZoom(nil)
        case "import":
            setImporting(body["running"] as? Bool ?? false, progress: body["progress"] as? Double ?? 0)
        default:
            break
        }
    }

    func setImporting(_ running: Bool, progress value: Double) {
        if running != importing {
            importing = running
            if running {
                awake = ProcessInfo.processInfo.beginActivity(
                    options: [.userInitiated, .idleSystemSleepDisabled], reason: "Importing from a camera card")
            } else if let a = awake {
                ProcessInfo.processInfo.endActivity(a)
                awake = nil
            }
        }
        let tile = NSApp.dockTile
        if running {
            if tile.contentView == nil {
                let icon = NSImageView(image: NSApp.applicationIconImage)
                progress.style = .bar
                progress.isIndeterminate = false
                progress.minValue = 0
                progress.maxValue = 1
                progress.frame = NSRect(x: 12, y: 8, width: 104, height: 16)
                icon.addSubview(progress)
                tile.contentView = icon
            }
            progress.doubleValue = value
            tile.badgeLabel = "\(Int(value * 100))%"
        } else {
            tile.contentView = nil
            tile.badgeLabel = nil
        }
        tile.display()
    }

    func notify(title: String, body: String) {
        if NSApp.isActive && window.isVisible && window.isKeyWindow { return }
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
        NSApp.requestUserAttention(.informationalRequest)
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler done: @escaping () -> Void) {
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
        done()
    }

    @objc func volumeMounted(_ note: Notification) {
        guard let url = note.userInfo?[NSWorkspace.volumeURLUserInfoKey] as? URL else { return }
        let fm = FileManager.default
        let isCard = ["DCIM", "PRIVATE/M4ROOT/CLIP", "M4ROOT/CLIP"].contains {
            fm.fileExists(atPath: url.appendingPathComponent($0).path)
        }
        if isCard { notify(title: "Camera card connected", body: "\(url.lastPathComponent): open Framewright and press Import (⌘I).") }
    }

    // MARK: menus

    func buildMenu() {
        let main = NSMenu()
        func menu(_ title: String, _ items: [NSMenuItem]) {
            let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
            let sub = NSMenu(title: title)
            items.forEach(sub.addItem)
            item.submenu = sub
            main.addItem(item)
        }
        func item(_ title: String, _ action: Selector?, _ key: String = "", _ mods: NSEvent.ModifierFlags = .command) -> NSMenuItem {
            let i = NSMenuItem(title: title, action: action, keyEquivalent: key)
            i.keyEquivalentModifierMask = mods
            return i
        }
        menu("Framewright", [
            item("About Framewright", #selector(NSApplication.orderFrontStandardAboutPanel(_:))),
            .separator(),
            item("Hide Framewright", #selector(NSApplication.hide(_:)), "h"),
            item("Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
            item("Show All", #selector(NSApplication.unhideAllApplications(_:))),
            .separator(),
            item("Quit Framewright", #selector(NSApplication.terminate(_:)), "q"),
        ])
        menu("File", [
            item("Import from Card", #selector(importCard), "i"),
            .separator(),
            item("Show Library in Finder", #selector(showLibrary), "o", [.command, .shift]),
            item("Open in Browser", #selector(openInBrowser), "b", [.command, .shift]),
            .separator(),
            item("Close Window", #selector(NSWindow.performClose(_:)), "w"),
        ])
        menu("Edit", [
            item("Undo", Selector(("undo:")), "z"),
            item("Redo", Selector(("redo:")), "z", [.command, .shift]),
            .separator(),
            item("Cut", #selector(NSText.cut(_:)), "x"),
            item("Copy", #selector(NSText.copy(_:)), "c"),
            item("Paste", #selector(NSText.paste(_:)), "v"),
            item("Select All", #selector(NSText.selectAll(_:)), "a"),
        ])
        menu("View", [
            item("Library", #selector(showTab(_:)), "1"),
            item("Develop", #selector(showTab(_:)), "2"),
            item("Post", #selector(showTab(_:)), "3"),
            item("Videos", #selector(showTab(_:)), "4"),
            .separator(),
            item("Reload", #selector(reload), "r"),
            item("Actual Size", #selector(zoomReset), "0"),
            item("Zoom In", #selector(zoomIn), "="),
            item("Zoom Out", #selector(zoomOut), "-"),
            .separator(),
            item("Enter Full Screen", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control]),
        ])
        let windowMenu = NSMenu(title: "Window")
        windowMenu.addItem(item("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"))
        windowMenu.addItem(item("Zoom", #selector(NSWindow.performZoom(_:))))
        windowMenu.addItem(item("Framewright", #selector(showWindow), "0", [.command, .option]))
        let windowItem = NSMenuItem(title: "Window", action: nil, keyEquivalent: "")
        windowItem.submenu = windowMenu
        main.addItem(windowItem)
        NSApp.windowsMenu = windowMenu
        NSApp.mainMenu = main
    }

    @objc func showWindow() { window.makeKeyAndOrderFront(nil) }
    @objc func importCard() {
        showWindow()
        web.evaluateJavaScript("window.framewrightImport && window.framewrightImport()")
    }
    @objc func showTab(_ sender: NSMenuItem) {
        showWindow()
        web.evaluateJavaScript("document.querySelector('.tabs button[data-tab=\"\(sender.title.lowercased())\"]')?.click()")
    }
    @objc func reload() {
        if server?.isRunning == true { web.reload() } else { startServer() }
    }
    @objc func zoomReset() { web.pageZoom = 1 }
    @objc func zoomIn() { web.pageZoom = min(2, web.pageZoom + 0.1) }
    @objc func zoomOut() { web.pageZoom = max(0.5, web.pageZoom - 0.1) }
    @objc func openInBrowser() { NSWorkspace.shared.open(web.url?.host == "127.0.0.1" ? web.url! : base) }
    @objc func showLibrary() {
        let config = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".config/framewright/config.json")
        if let data = try? Data(contentsOf: config),
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let library = json["library"] as? String {
            NSWorkspace.shared.open(URL(fileURLWithPath: (library as NSString).expandingTildeInPath))
        }
    }

    // MARK: web view

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        // Keep the app on its own server; anything else opens in the browser.
        if let url = action.request.url, let scheme = url.scheme, ["http", "https"].contains(scheme),
           url.host != "127.0.0.1" && url.host != "localhost" {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url { NSWorkspace.shared.open(url) }
        return nil
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { webView.reload() }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.beginSheetModal(for: window) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        alert.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn) }
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let alert = NSAlert()
        alert.messageText = prompt
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 280, height: 24))
        field.stringValue = defaultText ?? ""
        alert.accessoryView = field
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        alert.window.initialFirstResponder = field
        alert.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn ? field.stringValue : nil) }
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.beginSheetModal(for: window) { completionHandler($0 == .OK ? panel.urls : nil) }
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.activate(ignoringOtherApps: true)
app.run()
