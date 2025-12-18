#ifndef GAME_SERVER_H
#define GAME_SERVER_H

#include <atomic>
#include <cstdint>
#include <thread>
#include <vector>
#include <array>
#include <mutex>

enum class EntityType : uint8_t {
    PLAYER = 0,
    SPIDER = 1,
};

struct InputPacket {
    uint32_t playerId;
    uint32_t seq;
    float moveX;
    float moveZ;
    float yaw;
    float pitch;
    bool fire;
    uint8_t weapon;
    bool jump;
};

struct PlayerState {
    uint32_t id;
    float x;
    float y;
    float z;
    float vx;
    float vy;
    float vz;
    float yaw;
    float pitch;
    int32_t health;
    uint32_t lastSeq;
    bool active;
    uint32_t respawnTick;
    uint32_t lastFireTick;
    uint32_t lastInputTick;
    uint8_t weapon;
    bool isBot;
    bool grounded;
};

struct GameConfig {
    uint32_t maxPlayers;
    float worldHalfExtent;
    uint32_t botCount;
};

struct Wall {
    float minX;
    float maxX;
    float minZ;
    float maxZ;
};

struct Platform {
    float minX;
    float maxX;
    float minZ;
    float maxZ;
    float height;
};

struct SpiderEntity {
    uint32_t id;
    float x;
    float y;
    float z;
    float vx;
    float vz;
    float yaw;
    int32_t health;
    bool active;
    uint32_t targetPlayerId;
    uint32_t lastAttackTick;
    float aggroRange = 18.0f;
    float attackRange = 1.5f;
    int32_t attackDamage = 8;
    uint32_t attackCooldownTicks = 30; // 0.5 seconds at 60Hz
    float moveSpeed = 5.0f;
};

class InputRing {
public:
    InputRing();
    bool push(const InputPacket &packet);
    bool pop(InputPacket &packet);

private:
    static constexpr size_t kSize = 4096;
    std::array<InputPacket, kSize> buffer_;
    std::atomic<size_t> head_;
    std::atomic<size_t> tail_;
};

class GameServer {
public:
    GameServer();
    ~GameServer();

    void start(const GameConfig &config);
    void stop();
    bool pushInput(const InputPacket &packet);
    void getSnapshot(std::vector<uint8_t> &outSnapshot);

private:
    void tickLoop();
    void stepSimulation(float dt);
    void processInput(const InputPacket &packet, float dt, std::vector<uint32_t> &touchedIds);
    void integratePlayer(PlayerState &p, const InputPacket &input, float dt);
    void respawnPlayer(PlayerState &p);
    void buildSnapshot();
    void updateBots(float dt, std::vector<uint32_t> &touchedIds);
    void updateSpiders(float dt, std::vector<uint32_t> &touchedIds);
    PlayerState *findPlayer(uint32_t id);
    PlayerState *ensureBot(uint32_t botId);
    PlayerState *findNearestPlayer(const SpiderEntity &spider);
    void setupMap();
    void resolveWalls(PlayerState &p);
    void resolveSpiderWalls(SpiderEntity &spider);
    void resolvePlatforms(PlayerState &p);
    bool overlapsWall(const PlayerState &p, const Wall &w) const;
    void spawnSpider(float x, float z);

    bool raycastHit(const float ox, const float oy, const float oz,
                    const float dirX, const float dirY, const float dirZ,
                    const PlayerState &target, float maxDist, float &hitDist) const;

    std::thread tickThread_;
    std::atomic<bool> running_;
    std::atomic<uint32_t> tickCount_;
    InputRing ring_;
    std::vector<PlayerState> players_;
    std::vector<SpiderEntity> spiders_;
    uint32_t nextSpiderId_ = 2000000;
    GameConfig config_;
    std::mutex snapshotMutex_;
    std::vector<uint8_t> snapshot_;
    std::vector<Wall> walls_;
    std::vector<Platform> platforms_;
    float playerRadius_ = 0.35f;
    float spiderRadius_ = 0.4f;
};

#endif
