/* Freestanding numerical harness. model-equations.h contains the selected
 * generated OpenModelica C assignments for all derivatives, outputs and parameters. */
typedef double modelica_real;
typedef int modelica_boolean;
typedef struct { const char *file; int line, column, end_line, end_column, flag; } FILE_INFO;
#define DIVISION_SIM(a, b, ...) ((a) / (b))
#define fabs(x) __builtin_fabs(x)
#define sqrt(x) __builtin_sqrt(x)
#define floor(x) __builtin_floor(x)
#define Greater(a, b) ((a) > (b))
#define GreaterEq(a, b) ((a) >= (b))
#define LessEq(a, b) ((a) <= (b))
#define MMC_DEFSTRINGLIT(name, size, text) char name[] = text
#define fmax(a, b) __builtin_wasm_max_f64(a, b)
#define fmin(a, b) __builtin_wasm_min_f64(a, b)
#define sign(x) (((x) > 0) - ((x) < 0))
#define infoStreamPrintWithEquationIndexes(...) ((void)0)
#define omc_assert_warning(...) ((void)0)
#define omc_assert_withEquationIndexes(...) __builtin_trap()
#define throwStreamPrintWithEquationIndexes(...) __builtin_trap()

#include "model-equations.h"

/* RK4 for autonomous continuous equations. The supported model has no event
 * surfaces; its noEvent current/power/speed limiters are in the generated code. */
void step(double h)
{
    double initial[STATE_COUNT], k[4][STATE_COUNT];
    for (int i = 0; i < STATE_COUNT; ++i)
        initial[i] = v[state_index[i]];
    for (int stage = 0; stage < 4; ++stage) {
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
