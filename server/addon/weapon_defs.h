#ifndef WEAPON_DEFS_H
#define WEAPON_DEFS_H

#include <cstdint>

struct GunDef {
    uint8_t id;
    const char *name;
    float maxDamage;
    float minDamage;
    uint32_t cooldownTicks;
    float range;
    float spread;
    int pellets;
};

inline constexpr GunDef kShotgun{0, "Pump Shotgun", 84.0f, 12.0f, 16, 22.0f, 0.07f, 8};

#endif
