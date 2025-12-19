#include <napi.h>
#include "game_server.h"

namespace {
GameServer gServer;
GameConfig gConfig{64, 40.0f, 0};
}

Napi::Value StartServer(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    if (info.Length() > 0 && info[0].IsObject()) {
        Napi::Object obj = info[0].As<Napi::Object>();
        if (obj.Has("maxPlayers")) {
            gConfig.maxPlayers = obj.Get("maxPlayers").As<Napi::Number>().Uint32Value();
        }
        if (obj.Has("worldHalfExtent")) {
            gConfig.worldHalfExtent = obj.Get("worldHalfExtent").As<Napi::Number>().FloatValue();
        }
    }
    gServer.start(gConfig);
    return env.Undefined();
}

Napi::Value StopServer(const Napi::CallbackInfo &info) {
    gServer.stop();
    return info.Env().Undefined();
}

Napi::Value PushInput(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2) {
        Napi::TypeError::New(env, "Expected playerId and buffer").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    uint32_t playerId = info[0].As<Napi::Number>().Uint32Value();
    if (!info[1].IsTypedArray() && !info[1].IsBuffer()) {
        Napi::TypeError::New(env, "Expected ArrayBuffer or Buffer").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    Napi::ArrayBuffer buf;
    size_t offset = 0;
    if (info[1].IsTypedArray()) {
        buf = info[1].As<Napi::TypedArray>().ArrayBuffer();
        offset = info[1].As<Napi::TypedArray>().ByteOffset();
    } else {
        buf = info[1].As<Napi::Buffer<uint8_t>>().ArrayBuffer();
        offset = info[1].As<Napi::Buffer<uint8_t>>().ByteOffset();
    }

    const uint8_t *data = static_cast<const uint8_t *>(buf.Data()) + offset;
    const size_t len = buf.ByteLength() - offset;
    if (len < 23) {
        return Napi::Boolean::New(env, false);
    }

    InputPacket pkt{};
    size_t idx = 0;
    auto read32 = [&]() {
        uint32_t v;
        std::memcpy(&v, data + idx, sizeof(v));
        idx += sizeof(v);
        return v;
    };
    auto readFloat = [&]() {
        float v;
        std::memcpy(&v, data + idx, sizeof(v));
        idx += sizeof(v);
        return v;
    };

    pkt.playerId = playerId;
    pkt.seq = read32();
    pkt.moveX = readFloat();
    pkt.moveZ = readFloat();
    pkt.yaw = readFloat();
    pkt.pitch = readFloat();
    pkt.fire = data[idx] != 0;
    idx += 1;
    pkt.weapon = data[idx];
    idx += 1;
    pkt.jump = idx < len ? (data[idx] != 0) : false;

    bool ok = gServer.pushInput(pkt);
    return Napi::Boolean::New(env, ok);
}

Napi::Value GetSnapshot(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    std::vector<uint8_t> snap;
    gServer.getSnapshot(snap);
    if (snap.empty()) {
        return Napi::ArrayBuffer::New(env, 0);
    }
    Napi::ArrayBuffer buf = Napi::ArrayBuffer::New(env, snap.size());
    std::memcpy(buf.Data(), snap.data(), snap.size());
    return buf;
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("startServer", Napi::Function::New(env, StartServer));
    exports.Set("stopServer", Napi::Function::New(env, StopServer));
    exports.Set("pushInput", Napi::Function::New(env, PushInput));
    exports.Set("getSnapshot", Napi::Function::New(env, GetSnapshot));
    return exports;
}

NODE_API_MODULE(addon, Init)
