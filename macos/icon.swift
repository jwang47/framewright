// Draws the app icon into an .iconset folder (macos/build.sh runs it).
// A rounded dark square with an amber aperture; no artwork files needed.
import AppKit

let out = URL(fileURLWithPath: CommandLine.arguments[1])
try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)

func draw(_ px: Int) -> Data {
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8,
                               samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                               colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let s = CGFloat(px), inset = s * 0.1
    let box = NSRect(x: inset, y: inset, width: s - 2 * inset, height: s - 2 * inset)
    let tile = NSBezierPath(roundedRect: box, xRadius: s * 0.18, yRadius: s * 0.18)
    NSGradient(starting: NSColor(white: 0.2, alpha: 1), ending: NSColor(white: 0.07, alpha: 1))!.draw(in: tile, angle: -90)
    let config = NSImage.SymbolConfiguration(pointSize: s * 0.5, weight: .regular)
        .applying(.init(paletteColors: [NSColor(red: 1, green: 0.69, blue: 0.13, alpha: 1)]))
    if let symbol = NSImage(systemSymbolName: "camera.aperture", accessibilityDescription: nil)?.withSymbolConfiguration(config) {
        let size = symbol.size
        symbol.draw(in: NSRect(x: (s - size.width) / 2, y: (s - size.height) / 2, width: size.width, height: size.height))
    }
    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])!
}

for size in [16, 32, 128, 256, 512] {
    try! draw(size).write(to: out.appendingPathComponent("icon_\(size)x\(size).png"))
    try! draw(size * 2).write(to: out.appendingPathComponent("icon_\(size)x\(size)@2x.png"))
}
