import Foundation
import ScreenCaptureKit
import CoreGraphics
import CoreMedia
import AVFoundation

final class AudioMeter: NSObject, SCStreamOutput, SCStreamDelegate {
    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio, sampleBuffer.isValid else { return }
        try? sampleBuffer.withAudioBufferList { list, _ in
            guard let description = sampleBuffer.formatDescription?.audioStreamBasicDescription,
                  let format = AVAudioFormat(standardFormatWithSampleRate: description.mSampleRate, channels: description.mChannelsPerFrame),
                  let pcm = AVAudioPCMBuffer(pcmFormat: format, bufferListNoCopy: list.unsafePointer),
                  let channels = pcm.floatChannelData else { return }
            let count = Int(pcm.frameLength)
            guard count > 0 else { return }
            var sum: Float = 0
            for channel in 0..<Int(format.channelCount) {
                for index in 0..<count { let value = channels[channel][index]; sum += value * value }
            }
            let rms = sqrt(sum / Float(count * Int(format.channelCount)))
            print(String(format: "%.5f", min(1.0, rms * 4.0)))
            fflush(stdout)
        }
    }
    func stream(_ stream: SCStream, didStopWithError error: Error) {
        fputs("Audio capture stopped: \(error.localizedDescription)\n", stderr)
        exit(1)
    }
}

Task {
    do {
        guard CGPreflightScreenCaptureAccess() || CGRequestScreenCaptureAccess() else {
            fputs("Allow Screen & System Audio Recording for the terminal running Lightshow, then restart the companion.\n", stderr)
            exit(2)
        }
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let display = content.displays.first else { throw NSError(domain: "Lightshow", code: 1, userInfo: [NSLocalizedDescriptionKey: "No display available for audio capture."]) }
        let filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
        let config = SCStreamConfiguration()
        config.capturesAudio = true
        config.excludesCurrentProcessAudio = false
        config.sampleRate = 48000
        config.channelCount = 2
        config.width = 2
        config.height = 2
        config.minimumFrameInterval = CMTime(value: 1, timescale: 1)
        let meter = AudioMeter()
        let stream = SCStream(filter: filter, configuration: config, delegate: meter)
        try stream.addStreamOutput(meter, type: .audio, sampleHandlerQueue: DispatchQueue(label: "lightshow.audio"))
        try await stream.startCapture()
        fputs("ready\n", stderr)
        while true { try await Task.sleep(nanoseconds: 60_000_000_000) }
    } catch {
        fputs("Could not capture system audio: \(error.localizedDescription)\n", stderr)
        exit(1)
    }
}
dispatchMain()
