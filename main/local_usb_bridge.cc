#include "local_usb_bridge.h"

#include "application.h"
#include "board.h"
#include "device_state_machine.h"
#include "display.h"

#include <cJSON.h>
#include <driver/usb_serial_jtag.h>
#include <driver/usb_serial_jtag_vfs.h>
#include <esp_log.h>
#include <esp_timer.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <mbedtls/base64.h>

#include <cstdio>
#include <cstring>
#include <vector>

#ifndef BOARD_TYPE
#define BOARD_TYPE "unknown-board"
#endif

LocalUsbBridge& LocalUsbBridge::GetInstance() {
    static LocalUsbBridge instance;
    return instance;
}

void LocalUsbBridge::Start() {
    usb_serial_jtag_driver_config_t config = {
        .tx_buffer_size = 4096,
        .rx_buffer_size = 8192,
    };
    if (!usb_serial_jtag_is_driver_installed()) {
        ESP_ERROR_CHECK(usb_serial_jtag_driver_install(&config));
    }
    usb_serial_jtag_vfs_use_driver();
    ESP_LOGI("WorkBuddyUSB", "USB notification transport ready");
    // Serial input is best-effort control traffic. Keep it below the Opus worker so an
    // attached host can never delay normal cloud TTS decoding.
    xTaskCreate([](void* arg) { static_cast<LocalUsbBridge*>(arg)->Run(); },
                "workbuddy_usb", 8192, this, 1, nullptr);
}

void LocalUsbBridge::Reply(const std::string& id, const char* type, const char* error) {
    auto root = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "id", id.c_str());
    cJSON_AddStringToObject(root, "type", type);
    cJSON_AddStringToObject(root, "firmware", "2.2.3-" BOARD_TYPE "-workbuddy-wb5");
    cJSON_AddStringToObject(
        root, "state",
        DeviceStateMachine::GetStateName(Application::GetInstance().GetDeviceState()));
    cJSON_AddBoolToObject(root, "local_active", active_.load());
    if (error) {
        cJSON_AddStringToObject(root, "error", error);
    }
    char* json = cJSON_PrintUnformatted(root);
    if (json) {
        printf("\nWBJSON %s\n", json);
        fflush(stdout);
        cJSON_free(json);
    }
    cJSON_Delete(root);
}

void LocalUsbBridge::Cancel() {
    if (!active_.exchange(false)) {
        return;
    }
    auto& app = Application::GetInstance();
    const auto mode = mode_.exchange(UsbBridgeMode::None);
    waiting_for_cloud_reply_ = false;
    completion_id_.clear();
    if (mode == UsbBridgeMode::CloudInput) {
        app.CancelExternalAudioInput();
    } else {
        app.GetAudioService().ResetDecoder();
        if (app.GetDeviceState() == kDeviceStateSpeaking ||
            app.GetDeviceState() == kDeviceStateConnecting) {
            app.SetDeviceState(kDeviceStateIdle);
        }
    }
}

void LocalUsbBridge::OnCloudReplyStarted() {
    if (active_ && mode_ == UsbBridgeMode::CloudInput) {
        last_packet_us_ = esp_timer_get_time();
    }
}

void LocalUsbBridge::OnCloudReplyFinished() {
    if (!active_ || mode_ != UsbBridgeMode::CloudInput || !waiting_for_cloud_reply_) {
        return;
    }
    const auto id = completion_id_;
    active_ = false;
    mode_ = UsbBridgeMode::None;
    waiting_for_cloud_reply_ = false;
    completion_id_.clear();
    // A cloud reply can otherwise leave the channel or display in listening state.
    Application::GetInstance().CancelExternalAudioInput();
    Reply(id, "cloud_done");
}

void LocalUsbBridge::OnCloudRequestFailed(const char* error) {
    if (!active_ || mode_ != UsbBridgeMode::CloudInput) {
        return;
    }
    const auto id = completion_id_;
    active_ = false;
    mode_ = UsbBridgeMode::None;
    waiting_for_cloud_reply_ = false;
    completion_id_.clear();
    if (!id.empty()) {
        Reply(id, "error", error);
    }
}

void LocalUsbBridge::Run() {
    std::string line;
    line.reserve(4096);
    bool overflow = false;
    while (true) {
        char ch;
        int count = usb_serial_jtag_read_bytes(&ch, 1, pdMS_TO_TICKS(20));
        if (count == 1) {
            if (ch == '\n') {
                if (!overflow && line.rfind("WB:", 0) == 0) {
                    Handle(line.substr(3));
                }
                line.clear();
                overflow = false;
            } else if (ch != '\r') {
                if (line.size() < 4096) {
                    line.push_back(ch);
                } else {
                    overflow = true;
                }
            }
        } else {
            const int64_t timeout_us = waiting_for_cloud_reply_ ? 90000000 : 15000000;
            if (active_ && esp_timer_get_time() - last_packet_us_.load() > timeout_us) {
                last_packet_us_ = esp_timer_get_time();
                Application::GetInstance().Schedule([this]() { Cancel(); });
            }
            vTaskDelay(pdMS_TO_TICKS(10));
        }
    }
}

void LocalUsbBridge::Handle(const std::string& line) {
    auto root = cJSON_ParseWithLength(line.data(), line.size());
    if (!root) {
        return;
    }
    auto get = [root](const char* key) -> std::string {
        auto item = cJSON_GetObjectItemCaseSensitive(root, key);
        return cJSON_IsString(item) ? item->valuestring : "";
    };
    const auto id = get("id");
    const auto op = get("type");
    const auto session = get("session_id");
    if (id.empty() || id.size() > 80) {
        cJSON_Delete(root);
        return;
    }

    auto& app = Application::GetInstance();
    if (op == "status") {
        Reply(id, "status");
    } else if (op == "speak_request") {
        const auto text = get("text");
        const bool listen_after = get("event_type") == "question";
        if (session.empty() || session.size() > 80 || text.size() > 2400) {
            Reply(id, "error", "invalid_request");
        } else {
            app.Schedule([this, id, session, text, listen_after]() {
                auto& current = Application::GetInstance();
                if (active_ || current.GetDeviceState() != kDeviceStateIdle) {
                    Reply(id, "busy", "device_not_idle");
                    return;
                }
                session_ = session;
                sequence_ = 0;
                listen_after_ = listen_after;
                mode_ = UsbBridgeMode::LocalPlayback;
                last_packet_us_ = esp_timer_get_time();
                active_ = true;
                current.SetDeviceState(kDeviceStateConnecting);
                current.SetDeviceState(kDeviceStateSpeaking);
                // State-change handling resets the decoder before readiness is acknowledged.
                current.Schedule([this, id, session, text]() {
                    if (!active_ || session != session_ ||
                        Application::GetInstance().GetDeviceState() != kDeviceStateSpeaking) {
                        Reply(id, "error", "interrupted");
                        return;
                    }
                    Board::GetInstance().GetDisplay()->SetChatMessage("assistant", text.c_str());
                    Reply(id, "speak_ready");
                });
            });
        }
    } else if (op == "ask_request") {
        const auto text = get("text");
        if (session.empty() || session.size() > 80 || text.empty() || text.size() > 2400) {
            Reply(id, "error", "invalid_request");
        } else {
            app.Schedule([this, id, session, text]() {
                auto& current = Application::GetInstance();
                if (active_ || current.GetDeviceState() != kDeviceStateIdle) {
                    Reply(id, "busy", "device_not_idle");
                    return;
                }
                session_ = session;
                sequence_ = 0;
                completion_id_.clear();
                waiting_for_cloud_reply_ = false;
                last_packet_us_ = esp_timer_get_time();
                active_ = true;
                mode_ = UsbBridgeMode::CloudInput;
                Board::GetInstance().GetDisplay()->SetChatMessage("user", text.c_str());
                current.BeginExternalAudioInput([this, id, session](bool ready) {
                    if (!ready || !active_ || mode_ != UsbBridgeMode::CloudInput ||
                        session != session_) {
                        active_ = false;
                        mode_ = UsbBridgeMode::None;
                        Reply(id, "error", "cloud_channel_unavailable");
                        return;
                    }
                    Reply(id, "ask_ready");
                });
            });
        }
    } else if (op == "audio" || op == "input_audio") {
        auto seq = cJSON_GetObjectItemCaseSensitive(root, "seq");
        auto encoded = get("data");
        const bool cloud = op == "input_audio";
        const auto expected_mode =
            cloud ? UsbBridgeMode::CloudInput : UsbBridgeMode::LocalPlayback;
        const auto expected_state = cloud ? kDeviceStateListening : kDeviceStateSpeaking;
        if (!active_ || mode_ != expected_mode || session != session_ ||
            app.GetDeviceState() != expected_state) {
            Reply(id, "error", "session_inactive");
        } else if (!cJSON_IsNumber(seq) || seq->valuedouble != sequence_ || encoded.empty() ||
                   encoded.size() > 1800) {
            Reply(id, "error", "invalid_packet");
        } else {
            std::vector<uint8_t> payload(1350);
            size_t decoded = 0;
            int result = mbedtls_base64_decode(
                payload.data(), payload.size(), &decoded,
                reinterpret_cast<const unsigned char*>(encoded.data()), encoded.size());
            if (result != 0 || decoded == 0 || decoded > 1275) {
                Reply(id, "error", "invalid_opus");
            } else {
                payload.resize(decoded);
                auto packet = std::make_unique<AudioStreamPacket>(AudioStreamPacket{
                    .sample_rate = cloud ? 16000 : 24000,
                    .frame_duration = 60,
                    .timestamp = 0,
                    .payload = std::move(payload),
                });
                const bool accepted =
                    cloud ? app.SendExternalAudio(std::move(packet))
                          : app.GetAudioService().PushPacketToDecodeQueue(std::move(packet), false);
                if (accepted) {
                    sequence_++;
                    last_packet_us_ = esp_timer_get_time();
                    Reply(id, cloud ? "input_ack" : "audio_ack");
                } else {
                    Reply(id, "busy", "audio_queue_full");
                }
            }
        }
    } else if (op == "input_stop") {
        if (!active_ || mode_ != UsbBridgeMode::CloudInput || session != session_) {
            Reply(id, "error", "session_inactive");
        } else {
            completion_id_ = id;
            waiting_for_cloud_reply_ = true;
            last_packet_us_ = esp_timer_get_time();
            app.Schedule([]() { Application::GetInstance().FinishExternalAudioInput(); });
        }
    } else if (op == "tts_stop") {
        if (!active_ || session != session_) {
            Reply(id, "error", "session_inactive");
        } else {
            app.GetAudioService().WaitForPlaybackQueueEmpty();
            vTaskDelay(pdMS_TO_TICKS(150));
            app.Schedule([this, id, session]() {
                if (!active_ || session != session_) {
                    Reply(id, "error", "interrupted");
                    return;
                }
                active_ = false;
                mode_ = UsbBridgeMode::None;
                Application::GetInstance().SetDeviceState(kDeviceStateIdle);
                const bool listen_after = listen_after_;
                Application::GetInstance().Schedule([this, id, listen_after]() {
                    Reply(id, "speak_done");
                    if (listen_after) {
                        Application::GetInstance().ToggleChatState();
                    }
                });
            });
        }
    } else if (op == "cancel") {
        if (session != session_) {
            Reply(id, "error", "session_mismatch");
        } else {
            app.Schedule([this, id]() {
                Cancel();
                Reply(id, "cancelled");
            });
        }
    } else {
        Reply(id, "error", "unknown_type");
    }
    cJSON_Delete(root);
}
