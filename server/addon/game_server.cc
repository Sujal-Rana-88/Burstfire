#include "game_server.h"
#include "game_math.h"
#include "weapon_defs.h"

#include <algorithm>
#include <chrono>
#include <iterator>

InputRing::InputRing() : head_(0), tail_(0) {}

bool InputRing::push(const InputPacket &packet) {
    const size_t head = head_.load(std::memory_order_relaxed);
    const size_t next = (head + 1) % kSize;
    if (next == tail_.load(std::memory_order_acquire)) {
        return false; // full, drop
    }
    buffer_[head] = packet;
    head_.store(next, std::memory_order_release);
    return true;
}

bool InputRing::pop(InputPacket &packet) {
    const size_t tail = tail_.load(std::memory_order_relaxed);
    if (tail == head_.load(std::memory_order_acquire)) {
        return false; // empty
    }
    packet = buffer_[tail];
    const size_t next = (tail + 1) % kSize;
    tail_.store(next, std::memory_order_release);
    return true;
}

GameServer::GameServer()
    : running_(false), tickCount_(0), config_{64, 24.0f, 0} {}

GameServer::~GameServer() { stop(); }

void GameServer::start(const GameConfig &config) {
    if (running_.load()) return;
    config_ = config;
    setupMap();
    running_.store(true);
    tickCount_.store(0);
    players_.clear();
    snapshot_.clear();
    tickThread_ = std::thread(&GameServer::tickLoop, this);
}

void GameServer::stop() {
    if (!running_.load()) return;
    running_.store(false);
    if (tickThread_.joinable()) tickThread_.join();
}

bool GameServer::pushInput(const InputPacket &packet) {
    return ring_.push(packet);
}

void GameServer::getSnapshot(std::vector<uint8_t> &outSnapshot) {
    std::lock_guard<std::mutex> lock(snapshotMutex_);
    outSnapshot = snapshot_;
}

void GameServer::tickLoop() {
    using clock = std::chrono::steady_clock;
    const double dt = 1.0 / 60.0;
    auto nextTime = clock::now();
    const auto step = std::chrono::duration_cast<clock::duration>(std::chrono::duration<double>(dt));
    while (running_.load()) {
        nextTime += step;
        stepSimulation(static_cast<float>(dt));
        std::this_thread::sleep_until(nextTime);
    }
}

void GameServer::stepSimulation(float dt) {
    std::vector<uint32_t> touched;
    InputPacket pkt;
    while (ring_.pop(pkt)) {
        processInput(pkt, dt, touched);
    }

    updateBots(dt, touched);

    for (auto &p : players_) {
        if (!p.active) {
            if (tickCount_.load() >= p.respawnTick) {
                respawnPlayer(p);
            }
            continue;
        }
        if (std::find(touched.begin(), touched.end(), p.id) == touched.end()) {
            InputPacket idle{};
            idle.yaw = p.yaw;
            idle.pitch = p.pitch;
            idle.weapon = p.weapon;
            integratePlayer(p, idle, dt);
        }

        if (!p.isBot && tickCount_.load() - p.lastInputTick > 600) {
            p.active = false;
            continue;
        }
    }

    tickCount_.fetch_add(1);
    buildSnapshot();
}

void GameServer::buildSnapshot() {
    std::vector<uint8_t> data;
    data.reserve(4 + 2 + players_.size() * 64);
    auto writeBytes = [&data](const void *ptr, size_t len) {
        const uint8_t *b = static_cast<const uint8_t *>(ptr);
        data.insert(data.end(), b, b + len);
    };
    const uint32_t tick = tickCount_.load();
    const uint16_t count = static_cast<uint16_t>(players_.size());
    writeBytes(&tick, sizeof(tick));
    writeBytes(&count, sizeof(count));
    for (const auto &p : players_) {
        writeBytes(&p.id, sizeof(p.id));
        writeBytes(&p.x, sizeof(p.x));
        writeBytes(&p.y, sizeof(p.y));
        writeBytes(&p.z, sizeof(p.z));
        writeBytes(&p.vx, sizeof(p.vx));
        writeBytes(&p.vy, sizeof(p.vy));
        writeBytes(&p.vz, sizeof(p.vz));
        writeBytes(&p.yaw, sizeof(p.yaw));
        writeBytes(&p.pitch, sizeof(p.pitch));
        int16_t health = static_cast<int16_t>(p.health);
        writeBytes(&health, sizeof(health));
        uint8_t active = p.active ? 1 : 0;
        writeBytes(&active, sizeof(active));
        uint8_t isBot = p.isBot ? 1 : 0;
        writeBytes(&isBot, sizeof(isBot));
        writeBytes(&p.weapon, sizeof(p.weapon));
        writeBytes(&p.lastSeq, sizeof(p.lastSeq));
    }

    std::lock_guard<std::mutex> lock(snapshotMutex_);
    snapshot_.swap(data);
}

PlayerState *GameServer::findPlayer(uint32_t id) {
    for (auto &p : players_) {
        if (p.id == id) return &p;
    }
    return nullptr;
}

PlayerState *GameServer::ensureBot(uint32_t botId) {
    if (config_.botCount == 0) return nullptr;
    PlayerState *p = findPlayer(botId);
    if (p) return p;
    if (players_.size() >= config_.maxPlayers) return nullptr;
    PlayerState bot{};
    bot.id = botId;
    bot.health = 100;
    bot.yaw = 0;
    bot.pitch = 0;
    bot.active = true;
    bot.lastSeq = 0;
    bot.lastInputTick = tickCount_.load();
    bot.weapon = 0;
    bot.isBot = true;
    respawnPlayer(bot);
    players_.push_back(bot);
    return &players_.back();
}
