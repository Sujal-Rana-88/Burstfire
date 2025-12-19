#include "game_server.h"
#include "game_math.h"

#include <algorithm>

void GameServer::setupMap() {
    walls_.clear();
    platforms_.clear();
    const float h = config_.worldHalfExtent;
    walls_.push_back({-h, h, h - 1.0f, h});
    walls_.push_back({-h, h, -h, -h + 1.0f});
    walls_.push_back({-h, -h + 1.0f, -h, h});
    walls_.push_back({h - 1.0f, h, -h, h});

    // No interior walls beyond perimeter; rely on map visuals for navigation.

    auto addPlatformRect = [&](float minX, float maxX, float minZ, float maxZ, float height) {
        platforms_.push_back({minX, maxX, minZ, maxZ, height});
    };
    // No platforms for collider simplicity

    spiders_.clear();
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
        float minPen = penLeft;
        int axis = 0;
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

void GameServer::resolvePlatforms(PlayerState &p) {
    for (const auto &pl : platforms_) {
        const bool insideXZ = (p.x + playerRadius_ > pl.minX && p.x - playerRadius_ < pl.maxX &&
                               p.z + playerRadius_ > pl.minZ && p.z - playerRadius_ < pl.maxZ);
        if (!insideXZ) continue;
        const float top = pl.height;
        if (p.vy < 0.0f && p.y <= top + 0.2f && p.y >= top - 0.8f) {
            p.y = top;
            p.vy = 0.0f;
            p.grounded = true;
        }
        if (p.y > top + 0.2f) continue;
        const float penLeft = (pl.maxX - (p.x - playerRadius_));
        const float penRight = ((p.x + playerRadius_) - pl.minX);
        const float penDown = ((p.z + playerRadius_) - pl.minZ);
        const float penUp = (pl.maxZ - (p.z - playerRadius_));
        float minPen = penLeft;
        int axis = 0;
        if (penRight < minPen) { minPen = penRight; axis = 1; }
        if (penDown < minPen) { minPen = penDown; axis = 2; }
        if (penUp < minPen) { minPen = penUp; axis = 3; }
        switch (axis) {
            case 0: p.x = pl.maxX + playerRadius_; p.vx = 0.0f; break;
            case 1: p.x = pl.minX - playerRadius_; p.vx = 0.0f; break;
            case 2: p.z = pl.minZ - playerRadius_; p.vz = 0.0f; break;
            case 3: p.z = pl.maxZ + playerRadius_; p.vz = 0.0f; break;
        }
    }
}

void GameServer::resolveSpiderWalls(SpiderEntity &spider) {
    const float r = spiderRadius_;
    for (const auto &w : walls_) {
        if (spider.x + r > w.minX && spider.x - r < w.maxX &&
            spider.z + r > w.minZ && spider.z - r < w.maxZ) {
            const float overlapX = std::min(spider.x + r - w.minX, w.maxX - (spider.x - r));
            const float overlapZ = std::min(spider.z + r - w.minZ, w.maxZ - (spider.z - r));
            if (overlapX < overlapZ) {
                if (spider.x < (w.minX + w.maxX) / 2.0f) {
                    spider.x = w.minX - r - 0.01f;
                } else {
                    spider.x = w.maxX + r + 0.01f;
                }
            } else {
                if (spider.z < (w.minZ + w.maxZ) / 2.0f) {
                    spider.z = w.minZ - r - 0.01f;
                } else {
                    spider.z = w.maxZ + r + 0.01f;
                }
            }
        }
    }
}

void GameServer::spawnSpider(float x, float z) {
    SpiderEntity spider{};
    spider.id = nextSpiderId_++;
    spider.x = x;
    spider.y = 0.3f;
    spider.z = z;
    spider.vx = 0.0f;
    spider.vz = 0.0f;
    spider.yaw = 0.0f;
    spider.health = 80;
    spider.active = true;
    spider.targetPlayerId = 0;
    spider.lastAttackTick = 0;
    spiders_.push_back(spider);
}
