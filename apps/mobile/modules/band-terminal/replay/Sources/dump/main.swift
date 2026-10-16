import Foundation
import SwiftTerm

// usage: dump <recording.jsonl>
// Prints {"cols","rows","alt","cursor":[x,y],"lines":[...],"cells":[[row,col,fg,bg,flags]...]}
// for the final visible screen. Colors are "d" (default), "p<N>" (palette) or "#rrggbb".

final class Delegate: TerminalDelegate {
    func send(source: Terminal, data: ArraySlice<UInt8>) {}
}

func color(_ c: Attribute.Color) -> String {
    switch c {
    case .defaultColor, .defaultInvertedColor: return "d"
    case .ansi256(let code): return "p\(code)"
    case .trueColor(let r, let g, let b): return String(format: "#%02x%02x%02x", r, g, b)
    }
}

guard CommandLine.arguments.count > 1,
      let text = try? String(contentsOfFile: CommandLine.arguments[1], encoding: .utf8)
else {
    FileHandle.standardError.write(Data("usage: dump <recording.jsonl>\n".utf8))
    exit(2)
}

var lines = text.split(separator: "\n").map { String($0) }
let header = try JSONSerialization.jsonObject(with: Data(lines.removeFirst().utf8)) as! [String: Any]
let delegate = Delegate()
var options = TerminalOptions.default
options.cols = header["cols"] as! Int
options.rows = header["rows"] as! Int
options.scrollback = 1000
let terminal = Terminal(delegate: delegate, options: options)

for line in lines {
    let event = try JSONSerialization.jsonObject(with: Data(line.utf8)) as! [String: Any]
    if let b64 = event["o"] as? String, let data = Data(base64Encoded: b64) {
        terminal.feed(buffer: [UInt8](data)[...])
    } else if let size = event["r"] as? [Int] {
        terminal.resize(cols: size[0], rows: size[1])
    }
}

var rows: [String] = []
var cells: [[Any]] = []
for y in 0..<terminal.rows {
    var s = ""
    if let line = terminal.getLine(row: y) {
        for x in 0..<terminal.cols {
            let cd = line[x]
            let ch = terminal.getCharacter(for: cd)
            let isBlank = ch == "\0"
            if cd.width == 0 { continue }
            s.append(isBlank ? " " : ch)
            if cd.width == 2 { /* the next cell is the right half */ }
            let attr = cd.attribute
            let st = attr.style
            var flags: [String] = []
            if st.contains(.bold) { flags.append("b") }
            if st.contains(.italic) { flags.append("i") }
            if st.contains(.underline) { flags.append("u") }
            if st.contains(.inverse) { flags.append("r") }
            if st.contains(.dim) { flags.append("d") }
            let f = color(attr.fg), b = color(attr.bg)
            if !isBlank && (f != "d" || b != "d" || !flags.isEmpty) || (isBlank && (b != "d" || st.contains(.inverse))) {
                cells.append([y, x, f, b, flags.joined()])
            }
        }
    }
    while s.hasSuffix(" ") { s.removeLast() }
    rows.append(s)
}
let cursor = terminal.getCursorLocation()
let out: [String: Any] = [
    "cols": terminal.cols, "rows": terminal.rows, "alt": terminal.isCurrentBufferAlternate,
    "cursor": [cursor.x, cursor.y], "lines": rows, "cells": cells,
]
let data = try JSONSerialization.data(withJSONObject: out, options: [.sortedKeys])
print(String(data: data, encoding: .utf8)!)
