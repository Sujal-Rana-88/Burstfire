#include "game_server.h"
#include <chrono>
#include <cmath>
#include <cstring>
#include <algorithm>
#include <random>
#include <limits>
#include <iterator>

namespace {
float clampf(float v, float lo, float hi) { return std::max(lo, std::min(hi, v)); }

struct GunDef {
    uint8_t id;
    const char *name;
    float damage;
    uint32_t cooldownTicks;
    float range;
};

constexpr GunDef kGuns[] = {
    {0, "SMG", 8.0f, 2, 40.0f},       // fast, low dmg
    {1, "Assault", 18.0f, 5, 55.0f},  // balanced
    {2, "Shotgun", 30.0f, 12, 25.0f}, // slow, short range
    {3, "Sniper", 60.0f, 20, 90.0f},  // very slow, long range
};

bool raySphereIntersect(const float ox, const float oy, const float oz,
                        const float dx, const float dy, const float dz,
                        const float cx, const float cy, const float cz,
                        const float radius, float maxDist) {
    // Ray origin o, direction d normalized. Sphere centered at c.
    const float lx = cx - ox;
    const float ly = cy - oy;
    const float lz = cz - oz;
    const float tca = lx * dx + ly * dy + lz * dz;
    if (tca < 0.0f) return false;
    const float d2 = lx * lx + ly * ly + lz * lz - tca * tca;
    const float r2 = radius * radius;
    if (d2 > r2) return false;
    const float thc = std::sqrt(std::max(0.0f, r2 - d2));
    const float t0 = tca - thc;
    const float t1 = tca + thc;
    const float tHit = (t0 >= 0.0f) ? t0 : t1;
    return tHit >= 0.0f && tHit <= maxDist;
}
}

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
    : running_(false), tickCount_(0), config_{64, 14.0f, 0} {}

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

    // Update players and handle respawns
    for (auto &p : players_) {
        if (!p.active) {
            if (tickCount_.load() >= p.respawnTick) {
                respawnPlayer(p);
            }
            continue;
        }
        // Apply friction/integration even with no new input this tick
        if (std::find(touched.begin(), touched.end(), p.id) == touched.end()) {
            InputPacket idle{}; // zero movement keeps friction and damping running
            idle.yaw = p.yaw;
            idle.pitch = p.pitch;
            idle.weapon = p.weapon;
            integratePlayer(p, idle, dt);
        }

        // Idle timeout to prune stale players
        if (!p.isBot && tickCount_.load() - p.lastInputTick > 600) { // 10 seconds
            p.active = false;
            continue;
        }
    }

    tickCount_.fetch_add(1);
    buildSnapshot();
}

void GameServer::processInput(const InputPacket &packet, float dt, std::vector<uint32_t> &touchedIds) {
    PlayerState *player = findPlayer(packet.playerId);
    if (!player) {
        if (players_.size() >= config_.maxPlayers) return;
        PlayerState newP{};
        newP.id = packet.playerId;
        newP.health = 100;
        newP.yaw = packet.yaw;
        newP.pitch = packet.pitch;
        newP.active = true;
        newP.lastSeq = packet.seq;
        newP.lastInputTick = tickCount_.load();
        newP.weapon = packet.weapon < std::size(kGuns) ? packet.weapon : 0;
        newP.isBot = false;
        respawnPlayer(newP);
        players_.push_back(newP);
        player = &players_.back();
    }

    if (!player->active && tickCount_.load() >= player->respawnTick) {
        respawnPlayer(*player);
    }

    if (!player->active) {
        player->lastSeq = packet.seq;
        player->lastInputTick = tickCount_.load();
        return;
    }

    player->weapon = packet.weapon < std::size(kGuns) ? packet.weapon : player->weapon;
    integratePlayer(*player, packet, dt);
    player->lastSeq = packet.seq;
    player->lastInputTick = tickCount_.load();
    touchedIds.push_back(player->id);

    // Firing
    const uint32_t currentTick = tickCount_.load();
    const GunDef &gun = kGuns[player->weapon % std::size(kGuns)];
    const uint32_t cooldown = gun.cooldownTicks;
    if (packet.fire && currentTick - player->lastFireTick >= cooldown) {
        player->lastFireTick = currentTick;
        for (auto &target : players_) {
            if (!target.active || target.id == player->id || target.health <= 0) continue;
            if (raycastHit(*player, target, gun.range)) {
                target.health -= static_cast<int32_t>(gun.damage);
                if (target.health <= 0) {
                    target.active = false;
                    target.respawnTick = tickCount_.load() + 180; // 3s respawn
                }
            }
        }
    }
}

void GameServer::integratePlayer(PlayerState &p, const InputPacket &input, float dt) {
    // Quake-ish acceleration on XZ plane. yaw = 0 looks down -Z to match camera.
    const float wishX = input.moveX;
    const float wishZ = input.moveZ;
    float forwardX = -std::sin(input.yaw);
    float forwardZ = -std::cos(input.yaw);
    float rightX = std::cos(input.yaw);
    float rightZ = -std::sin(input.yaw);
    float moveDirX = forwardX * wishZ + rightX * wishX;
    float moveDirZ = forwardZ * wishZ + rightZ * wishX;
    const float len = std::sqrt(moveDirX * moveDirX + moveDirZ * moveDirZ);
    if (len > 1e-4f) {
        moveDirX /= len;
        moveDirZ /= len;
    }
    const float accel = 50.0f;
    const float maxSpeed = 12.0f;
    p.vx += moveDirX * accel * dt;
    p.vz += moveDirZ * accel * dt;

    // Friction
    const float speed = std::sqrt(p.vx * p.vx + p.vz * p.vz);
    if (speed > 0.0f) {
        const float drop = speed * 8.0f * dt;
        const float newSpeed = std::max(0.0f, speed - drop);
        if (newSpeed != speed) {
            const float scale = newSpeed / speed;
            p.vx *= scale;
            p.vz *= scale;
        }
    }

    // Clamp speed
    const float newSpeed = std::sqrt(p.vx * p.vx + p.vz * p.vz);
    if (newSpeed > maxSpeed) {
        const float scale = maxSpeed / newSpeed;
        p.vx *= scale;
        p.vz *= scale;
    }

    p.x += p.vx * dt;
    p.z += p.vz * dt;
    p.y = 1.0f; // fixed height for now

    resolveWalls(p);

    // World bounds AABB clamp
    const float half = config_.worldHalfExtent;
    p.x = clampf(p.x, -half, half);
    p.z = clampf(p.z, -half, half);

    p.yaw = input.yaw;
    p.pitch = input.pitch;
}

void GameServer::respawnPlayer(PlayerState &p) {
    static std::mt19937 rng{std::random_device{}()};
    std::uniform_real_distribution<float> dist(-config_.worldHalfExtent + 1.0f, config_.worldHalfExtent - 1.0f);
    // try to avoid spawning inside walls
    for (int attempt = 0; attempt < 8; ++attempt) {
        p.x = dist(rng);
        p.z = dist(rng);
        bool bad = false;
        for (const auto &w : walls_) {
            if (overlapsWall(p, w)) {
                bad = true;
                break;
            }
        }
        if (!bad) break;
    }
    p.y = 1.0f;
    p.vx = p.vy = p.vz = 0.0f;
    p.health = 100;
    p.active = true;
    p.lastFireTick = 0;
    p.lastInputTick = tickCount_.load();
    p.weapon = p.weapon % std::size(kGuns);
}

bool GameServer::raycastHit(const PlayerState &shooter, const PlayerState &target, float maxDist) const {
    const float dirX = -std::sin(shooter.yaw) * std::cos(shooter.pitch);
    const float dirY = std::sin(shooter.pitch);
    const float dirZ = -std::cos(shooter.yaw) * std::cos(shooter.pitch);
    return raySphereIntersect(shooter.x, shooter.y, shooter.z, dirX, dirY, dirZ,
                              target.x, target.y, target.z, 0.6f, maxDist);
}

void GameServer::buildSnapshot() {
    // snapshot: [u32 tick][u16 count][players...]
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
    bot.weapon = botId % std::size(kGuns); // vary weapon per bot
    bot.isBot = true;
    respawnPlayer(bot);
    players_.push_back(bot);
    return &players_.back();
}

void GameServer::updateBots(float dt, std::vector<uint32_t> &touched) {
    if (config_.botCount == 0) return;
    for (uint32_t i = 0; i < config_.botCount; ++i) {
        const uint32_t botId = 1000000 + i;
        PlayerState *bot = ensureBot(botId);
        if (!bot) continue;
        if (!bot->active) {
            if (tickCount_.load() < bot->respawnTick) continue;
            respawnPlayer(*bot);
        }
        // Find nearest human
        PlayerState *target = nullptr;
        float bestDist2 = std::numeric_limits<float>::max();
        for (auto &p : players_) {
            if (p.isBot || !p.active || p.health <= 0) continue;
            const float dx = p.x - bot->x;
            const float dz = p.z - bot->z;
            const float d2 = dx * dx + dz * dz;
            if (d2 < bestDist2) {
                bestDist2 = d2;
                target = &p;
            }
        }
        InputPacket ai{};
        ai.playerId = botId;
        ai.seq = tickCount_.load();
        ai.weapon = bot->weapon;
        if (target) {
            const float dx = target->x - bot->x;
            const float dz = target->z - bot->z;
            ai.yaw = std::atan2(-dx, -dz); // align with forward = (-sin(yaw), -cos(yaw))
            ai.pitch = 0.0f;
            const float dist = std::sqrt(bestDist2);
            // move toward but strafe a bit
            ai.moveZ = dist > 2.5f ? 1.0f : 0.0f;
            ai.moveX = (tickCount_.load() / 60) % 2 == 0 ? 0.5f : -0.5f;
            ai.fire = dist < kGuns[bot->weapon].range * 0.9f;
        } else {
            ai.yaw = bot->yaw;
            ai.pitch = bot->pitch;
            ai.moveX = 0.0f;
            ai.moveZ = 0.0f;
            ai.fire = false;
        }
        processInput(ai, dt, touched);
    }
}

void GameServer::setupMap() {
    walls_.clear();
    const float h = config_.worldHalfExtent;
    // Perimeter thickening
    walls_.push_back({-h, h, h - 1.0f, h});      // north
    walls_.push_back({-h, h, -h, -h + 1.0f});    // south
    walls_.push_back({-h, -h + 1.0f, -h, h});    // west
    walls_.push_back({h - 1.0f, h, -h, h});      // east
    // Interior blocks
    walls_.push_back({-3.0f, 3.0f, -1.0f, 1.0f});
    walls_.push_back({-8.0f, -4.0f, 4.0f, 8.0f});
    walls_.push_back({4.0f, 8.0f, -8.0f, -4.0f});
    walls_.push_back({-10.0f, -6.0f, -8.0f, -6.0f});
    walls_.push_back({6.0f, 10.0f, 6.0f, 8.0f});
}

bool GameServer::overlapsWall(const PlayerState &p, const Wall &w) const {
    const float r = playerRadius_;
    return (p.x + r > w.minX && p.x - r < w.maxX && p.z + r > w.minZ && p.z - r < w.maxZ);
}

void GameServer::resolveWalls(PlayerState &p) {
    for (const auto &w : walls_) {
        if (!overlapsWall(p, w)) continue;
        const float r = playerRadius_;
        const float penLeft = (w.maxX - (p.x - r));
        const float penRight = ((p.x + r) - w.minX);
        const float penDown = ((p.z + r) - w.minZ);
        const float penUp = (w.maxZ - (p.z - r));
        // Compute minimal push out
        float minPen = penLeft;
        int axis = 0; // 0=x,1=x,2=z,3=z
        if (penRight < minPen) { minPen = penRight; axis = 1; }
        if (penDown < minPen) { minPen = penDown; axis = 2; }
        if (penUp < minPen) { minPen = penUp; axis = 3; }
        switch (axis) {
            case 0: p.x = w.maxX + r; p.vx = 0.0f; break;
            case 1: p.x = w.minX - r; p.vx = 0.0f; break;
            case 2: p.z = w.minZ - r; p.vz = 0.0f; break;
            case 3: p.z = w.maxZ + r; p.vz = 0.0f; break;
        }
    }
}
