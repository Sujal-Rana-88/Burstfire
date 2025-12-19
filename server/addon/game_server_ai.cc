#include "game_server.h"
#include "game_math.h"
#include "weapon_defs.h"

#include <cmath>
#include <limits>

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
        ai.weapon = 0;
        if (target) {
            const float dx = target->x - bot->x;
            const float dz = target->z - bot->z;
            ai.yaw = std::atan2(-dx, -dz);
            ai.pitch = 0.0f;
            const float dist = std::sqrt(bestDist2);
            ai.moveZ = dist > 2.5f ? 1.0f : 0.0f;
            ai.moveX = (tickCount_.load() / 60) % 2 == 0 ? 0.5f : -0.5f;
            ai.fire = dist < kShotgun.range * 0.9f;
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

void GameServer::updateSpiders(float dt, std::vector<uint32_t> &touched) {
    (void)touched;
    const uint32_t tick = tickCount_.load();
    for (auto &spider : spiders_) {
        if (!spider.active) continue;

        PlayerState *target = findNearestPlayer(spider);

        if (target) {
            spider.targetPlayerId = target->id;
            const float dx = target->x - spider.x;
            const float dz = target->z - spider.z;
            const float dist = std::sqrt(dx * dx + dz * dz);

            if (dist > spider.attackRange) {
                spider.yaw = std::atan2(-dx, -dz);
                const float dirX = dx / dist;
                const float dirZ = dz / dist;
                spider.vx = dirX * spider.moveSpeed;
                spider.vz = dirZ * spider.moveSpeed;
                spider.x += spider.vx * dt;
                spider.z += spider.vz * dt;

                const float h = config_.worldHalfExtent;
                spider.x = clampf(spider.x, -h, h);
                spider.z = clampf(spider.z, -h, h);

                resolveSpiderWalls(spider);
            } else {
                if (tick - spider.lastAttackTick >= spider.attackCooldownTicks) {
                    target->health -= spider.attackDamage;
                    spider.lastAttackTick = tick;
                    if (target->health <= 0) {
                        target->active = false;
                        target->respawnTick = tick + 180;
                    }
                }
                spider.vx = 0.0f;
                spider.vz = 0.0f;
            }
        } else {
            spider.targetPlayerId = 0;
            spider.vx = 0.0f;
            spider.vz = 0.0f;
        }

        spider.y = 0.3f;
    }
}

PlayerState *GameServer::findNearestPlayer(const SpiderEntity &spider) {
    PlayerState *target = nullptr;
    float bestDist2 = spider.aggroRange * spider.aggroRange;
    for (auto &p : players_) {
        if (!p.active || p.health <= 0) continue;
        const float dx = p.x - spider.x;
        const float dz = p.z - spider.z;
        const float d2 = dx * dx + dz * dz;
        if (d2 < bestDist2) {
            bestDist2 = d2;
            target = &p;
        }
    }
    return target;
}
