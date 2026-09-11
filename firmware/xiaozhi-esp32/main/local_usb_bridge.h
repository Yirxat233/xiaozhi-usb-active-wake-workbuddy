#pragma once
#include <atomic>
#include <string>
#include <cstdint>

enum class UsbBridgeMode : int {
    None,
    LocalPlayback,
    CloudInput,
};

class LocalUsbBridge {
public:
    static LocalUsbBridge& GetInstance();
    void Start();
    bool IsActive() const { return active_.load(); }
    bool IsLocalPlaybackActive() const { return mode_.load() == UsbBridgeMode::LocalPlayback; }
    bool IsCloudInputActive() const {
        return active_.load() && mode_.load() == UsbBridgeMode::CloudInput;
    }
    void Cancel();  // Application main task only.
    void OnCloudReplyStarted();
    void OnCloudReplyFinished();
    void OnCloudRequestFailed(const char* error);
private:
    std::atomic<bool> active_{false};
    std::atomic<UsbBridgeMode> mode_{UsbBridgeMode::None};
    std::atomic<bool> waiting_for_cloud_reply_{false};
    std::atomic<int64_t> last_packet_us_{0};
    std::string session_;
    int sequence_ = 0;
    bool listen_after_ = false;
    std::string completion_id_;
    void Run();
    void Handle(const std::string& line);
    void Reply(const std::string& id, const char* type, const char* error = nullptr);
};
