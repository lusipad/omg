/* Share the generated equation ABI with the published fixed-reference axes. */
#include "wasm-integrator.c"

/* First-order hold on the commanded position. Each stage evaluates the
 * original compiled derivative with its own reference, including at corners. */
void stepReference(double h, double startMm, double endMm)
{
    if (!(h > 0.0) || !__builtin_isfinite(h) || !__builtin_isfinite(startMm) || !__builtin_isfinite(endMm))
        __builtin_trap();
    if (startMm == endMm) {
        REFERENCE_MM = startMm;
        step(h);
        return;
    }
    double initial[STATE_COUNT], k[4][STATE_COUNT];
    const double midpointMm = 0.5 * startMm + 0.5 * endMm;
    for (int i = 0; i < STATE_COUNT; ++i)
        initial[i] = v[state_index[i]];
    for (int stage = 0; stage < 4; ++stage) {
        REFERENCE_MM = stage == 0 ? startMm : (stage == 3 ? endMm : midpointMm);
        if (stage) {
            const double offset = stage == 3 ? h : h * 0.5;
            for (int i = 0; i < STATE_COUNT; ++i)
                v[state_index[i]] = initial[i] + offset * k[stage - 1][i];
        }
        regular();
        for (int i = 0; i < STATE_COUNT; ++i)
            k[stage][i] = v[derivative_index[i]];
    }
    for (int i = 0; i < STATE_COUNT; ++i)
        v[state_index[i]] = initial[i] + (h / 6) * (k[0][i] + 2 * k[1][i] + 2 * k[2][i] + k[3][i]);
    regular();
}
