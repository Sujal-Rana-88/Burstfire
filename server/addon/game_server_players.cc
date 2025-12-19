#include "game_server.h"
#include "game_math.h"
#include "weapon_defs.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <random>

namespace {
// Safe spawn anchors roughly centered in rooms/corridors to avoid wall overlaps.
constexpr std::array<std::pair<float, float>, 8> kSpawnPoints{{
    {-5.0f, -5.0f},
    {5.0f, -5.0f},
    {-5.0f, 5.0f},
    {5.0f, 5.0f},
    {0.0f, -6.0f},
    {0.0f, 6.0f},
    {-8.0f, 0.0f},
    {8.0f, 0.0f},
}};

bool raySphereIntersect(const float ox, const float oy, const float oz,
                        const float dx, const float dy, const float dz,
                        const float cx, const float cy, const float cz,
                        const float radius, float maxDist, float &hitDist) {
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
    hitDist = tHit;
    return tHit >= 0.0f && tHit <= maxDist;
}
} // namespace

bool GameServer::raycastHit(const float ox, const float oy, const float oz,
                            const float dirX, const float dirY, const float dirZ,
                            const PlayerState &target, float maxDist, float &hitDist) const {
    const float len = std::sqrt(dirX * dirX + dirY * dirY + dirZ * dirZ);
    if (len < 1e-4f) return false;
    const float inv = 1.0f / len;
    const float dx = dirX * inv;
    const float dy = dirY * inv;
    const float dz = dirZ * inv;
    return raySphereIntersect(ox, oy, oz, dx, dy, dz,
                              target.x, target.y, target.z, 0.6f, maxDist, hitDist);
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
        newP.weapon = 0;
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

    player->weapon = 0;
    integratePlayer(*player, packet, dt);
    player->lastSeq = packet.seq;
    player->lastInputTick = tickCount_.load();
    touchedIds.push_back(player->id);

    const uint32_t currentTick = tickCount_.load();
    const GunDef &gun = kShotgun;
    if (packet.fire && currentTick - player->lastFireTick >= gun.cooldownTicks) {
        player->lastFireTick = currentTick;
        static thread_local std::mt19937 rng{std::random_device{}()};
        std::uniform_real_distribution<float> jitter(-gun.spread, gun.spread);
        for (auto &target : players_) {
            if (!target.active || target.id == player->id || target.health <= 0) continue;
            float totalDamage = 0.0f;
            for (int pellet = 0; pellet < gun.pellets; ++pellet) {
                const float yawOffset = jitter(rng);
                const float pitchOffset = jitter(rng) * 0.6f;
                const float yaw = player->yaw + yawOffset;
                const float pitch = player->pitch + pitchOffset;
                const float dirX = -std::sin(yaw) * std::cos(pitch);
                const float dirY = std::sin(pitch);
                const float dirZ = -std::cos(yaw) * std::cos(pitch);
                float hitDist = 0.0f;
                if (raycastHit(player->x, player->y, player->z, dirX, dirY, dirZ, target, gun.range, hitDist)) {
                    const float t = clampf(1.0f - (hitDist / gun.range), 0.0f, 1.0f);
                    const float pelletMax = gun.maxDamage / static_cast<float>(gun.pellets);
                    const float pelletMin = gun.minDamage / static_cast<float>(gun.pellets);
                    totalDamage += pelletMin + t * (pelletMax - pelletMin);
                }
            }
            if (totalDamage > 0.0f) {
                target.health -= static_cast<int32_t>(std::round(totalDamage));
                target.health = std::max(0, target.health);
                if (target.health <= 0) {
                    target.active = false;
                    target.respawnTick = tickCount_.load() + 180;
                }
            }
        }
    }
}

void GameServer::integratePlayer(PlayerState &p, const InputPacket &input, float dt) {
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

    const float newSpeed = std::sqrt(p.vx * p.vx + p.vz * p.vz);
    if (newSpeed > maxSpeed) {
        const float scale = maxSpeed / newSpeed;
        p.vx *= scale;
        p.vz *= scale;
    }

    p.x += p.vx * dt;
    p.z += p.vz * dt;

    const float gravity = 26.0f;
    const float jumpVel = 11.0f;
    const float groundY = 1.2f;  // Player center height when standing on PSU floor (floor underside anchored at y=0)
    bool onGround = p.y <= groundY + 0.05f;
    if (input.jump && onGround) {
        p.vy = jumpVel;
        onGround = false;
    }
    p.vy -= gravity * dt;
    p.y += p.vy * dt;
    if (p.y < groundY) {
        p.y = groundY;
        p.vy = 0.0f;
        onGround = true;
    }
    p.grounded = onGround;

    resolveWalls(p);
    resolvePlatforms(p);

    const float half = config_.worldHalfExtent;
    p.x = clampf(p.x, -half, half);
    p.z = clampf(p.z, -half, half);

    p.yaw = input.yaw;
    p.pitch = input.pitch;
}

void GameServer::respawnPlayer(PlayerState &p) {
    static std::mt19937 rng{std::random_device{}()};
    std::uniform_real_distribution<float> jitter(-1.2f, 1.2f);
    bool placed = false;
    for (int attempt = 0; attempt < 12; ++attempt) {
        const auto &base = kSpawnPoints[static_cast<size_t>(rng() % kSpawnPoints.size())];
        p.x = base.first + jitter(rng);
        p.z = base.second + jitter(rng);
        bool bad = false;
        for (const auto &w : walls_) {
            if (overlapsWall(p, w)) { bad = true; break; }
        }
        if (!bad) { placed = true; break; }
    }
    if (!placed) {
        std::uniform_real_distribution<float> dist(-config_.worldHalfExtent + 1.5f, config_.worldHalfExtent - 1.5f);
        for (int attempt = 0; attempt < 20; ++attempt) {
            p.x = dist(rng);
            p.z = dist(rng);
            bool bad = false;
            for (const auto &w : walls_) {
                if (overlapsWall(p, w)) { bad = true; break; }
            }
            if (!bad) { placed = true; break; }
        }
    }
    if (!placed) {
        p.x = 0.0f;
        p.z = 0.0f;
    }
    p.y = 10.0f;  // Spawn well above to find actual floor height
    p.vx = p.vy = p.vz = 0.0f;
    p.health = 100;
    p.active = true;
    p.lastFireTick = 0;
    p.lastInputTick = tickCount_.load();
    p.weapon = 0;
    p.grounded = false;  // Will fall and land on ground
}
