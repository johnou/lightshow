import Foundation
import ScreenCaptureKit
import CoreGraphics
import CoreMedia
import AVFoundation

final class AudioMeter: NSObject, SCStreamOutput, SCStreamDelegate {
    private var bass: [Float] = []
    private var lowMid: [Float] = []
    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio, sampleBuffer.isValid else { return }
        try? sampleBuffer.withAudioBufferList { list, _ in
            guard let description = sampleBuffer.formatDescription?.audioStreamBasicDescription,
                  let format = AVAudioFormat(standardFormatWithSampleRate: description.mSampleRate, channels: description.mChannelsPerFrame),
                  let pcm = AVAudioPCMBuffer(pcmFormat: format, bufferListNoCopy: list.unsafePointer),
                  let channels = pcm.floatChannelData else { return }
            let count = Int(pcm.frameLength)
            guard count > 0 else { return }
            let channelCount = Int(format.channelCount)
            if bass.count != channelCount { bass = Array(repeating: 0, count: channelCount); lowMid = Array(repeating: 0, count: channelCount) }
            let alpha = Float(1.0 - exp(-2.0 * Double.pi * 180.0 / description.mSampleRate))
            let midAlpha = Float(1.0 - exp(-2.0 * Double.pi * 2000.0 / description.mSampleRate))
            var sum: Float = 0
            var fullSum: Float = 0
            var midSum: Float = 0
            var highSum: Float = 0
            for channel in 0..<channelCount {
                var filtered = bass[channel]
                var middle = lowMid[channel]
                for index in 0..<count {
                    let sample = channels[channel][index]
                    filtered += alpha * (sample - filtered)
                    middle += midAlpha * (sample - middle)
                    sum += filtered * filtered
                    fullSum += sample * sample
                    midSum += (middle - filtered) * (middle - filtered)
                    highSum += (sample - middle) * (sample - middle)
                }
                bass[channel] = filtered
                lowMid[channel] = middle
            }
            let rms = sqrt(sum / Float(count * channelCount))
            let loudness = sqrt(fullSum / Float(count * channelCount))
            let mid = sqrt(midSum / Float(count * channelCount))
            let high = sqrt(highSum / Float(count * channelCount))
            print(String(format: "%.5f %.5f %.5f %.5f", min(1.0, rms * 6.0), min(1.0, loudness * 4.0), min(1.0, mid * 6.0), min(1.0, high * 8.0)))
            fflush(stdout)
        }
    }
    func stream(_ stream: SCStream, didStopWithError error: Error) {
        fputs("Audio capture stopped: \(error.localizedDescription)\n", stderr)
        exit(1)
    }
}

func runSystemAudio() {
Task {
    do {
        guard CGPreflightScreenCaptureAccess() || CGRequestScreenCaptureAccess() else {
            fputs("Allow Screen & System Audio Recording for Lightshow (or the terminal running it), then restart it.\n", stderr)
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
}
