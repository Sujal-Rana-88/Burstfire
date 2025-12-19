#ifndef GAME_MATH_H
#define GAME_MATH_H

#include <algorithm>

inline float clampf(float v, float lo, float hi) {
    return std::max(lo, std::min(hi, v));
}

#endif
