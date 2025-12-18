#ifndef GAME_SERVER_H
#define GAME_SERVER_H

#include <atomic>
#include <cstdint>
#include <thread>
#include <vector>
#include <array>
#include <mutex>

struct InputPacket {
    uint32_t playerId;
    uint32_t seq;
    float moveX;
    float moveZ;
    float yaw;
    float pitch;
    bool fire;
    uint8_t weapon;
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
    PlayerState *findPlayer(uint32_t id);
    PlayerState *ensureBot(uint32_t botId);
    void setupMap();
    void resolveWalls(PlayerState &p);
    bool overlapsWall(const PlayerState &p, const Wall &w) const;

    bool raycastHit(const PlayerState &shooter, const PlayerState &target, float maxDist) const;

    std::thread tickThread_;
    std::atomic<bool> running_;
    std::atomic<uint32_t> tickCount_;
    InputRing ring_;
    std::vector<PlayerState> players_;
    GameConfig config_;
    std::mutex snapshotMutex_;
    std::vector<uint8_t> snapshot_;
    std::vector<Wall> walls_;
    float playerRadius_ = 0.35f;
};

#endif
