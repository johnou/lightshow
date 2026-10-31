import AppKit
import ApplicationServices
import Foundation
import IOKit.hidsystem

func runMediaKey(_ action: String) -> Never {
    let actions: [String: Int] = ["playpause": Int(NX_KEYTYPE_PLAY), "next": Int(NX_KEYTYPE_NEXT), "previous": Int(NX_KEYTYPE_PREVIOUS)]
    guard let key = actions[action] else { fputs("Unknown media action.\n", stderr); exit(2) }
    guard AXIsProcessTrusted() else { fputs("Allow Accessibility access for Lightshow in System Settings.\n", stderr); exit(3) }
    for state in [0xA, 0xB] {
        let data = (key << 16) | (state << 8)
        guard let event = NSEvent.otherEvent(with: .systemDefined, location: .zero, modifierFlags: NSEvent.ModifierFlags(rawValue: UInt(state << 8)), timestamp: 0, windowNumber: 0, context: nil, subtype: 8, data1: data, data2: -1), let cgEvent = event.cgEvent else { fputs("Could not create media key event.\n", stderr); exit(1) }
        cgEvent.post(tap: .cghidEventTap)
    }
    exit(0)
}
