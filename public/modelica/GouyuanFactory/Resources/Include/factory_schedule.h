#ifndef GOUYUAN_FACTORY_SCHEDULE_H
#define GOUYUAN_FACTORY_SCHEDULE_H

/* Shared by the OpenModelica external function and the freestanding web module.
 * Arrays are flat, row-major. Resource and stage IDs on the boundary are 1-based.
 * Intervals are half-open [start, end), in seconds. Coordinates are in metres. */
enum { FACTORY_RESOURCES = 32, FACTORY_STAGES = 16, FACTORY_JOBS = 64,
       FACTORY_JOB_WIDTH = 3, FACTORY_RESOURCE_WIDTH = 8, FACTORY_RECORD_WIDTH = 11 };
enum { FACTORY_HANDLE = 1, FACTORY_MACHINE = 2, FACTORY_CONVEYOR = 3, FACTORY_MOBILE = 4 };
enum { FACTORY_ROLE, FACTORY_X, FACTORY_Y, FACTORY_SERVICE, FACTORY_EMPTY,
       FACTORY_LOADED, FACTORY_PICK, FACTORY_DROP };
enum { FACTORY_OK, FACTORY_DIMENSIONS, FACTORY_DEVICE, FACTORY_JOB, FACTORY_MASK,
       FACTORY_CONNECTION, FACTORY_NUMERIC };

typedef struct {
    int job, station, carrier, from, origin;
    double ready, dispatch, pickupStart, loadedStart, dropStart, serviceStart, finish;
} FactoryOperation;

static int factory_same_place(const double *resources, int a, int b)
{
    const double *p = resources + a * FACTORY_RESOURCE_WIDTH;
    const double *q = resources + b * FACTORY_RESOURCE_WIDTH;
    return p[FACTORY_X] == q[FACTORY_X] && p[FACTORY_Y] == q[FACTORY_Y];
}

static double factory_distance(const double *a, const double *b)
{
    double dx = __builtin_fabs(a[FACTORY_X] - b[FACTORY_X]);
    double dy = __builtin_fabs(a[FACTORY_Y] - b[FACTORY_Y]);
    double large = dx > dy ? dx : dy, small = dx > dy ? dy : dx;
    if (large == 0.0) return 0.0;
    double ratio = small / large;
    return large * __builtin_sqrt(1.0 + ratio * ratio);
}

static int factory_end(double start, double elapsed, double *end)
{
    *end = start + elapsed;
    return __builtin_isfinite(*end) && (elapsed == 0.0 || *end > start);
}

static int factory_arrive(double start, double distance, double secondsPerM, double *end)
{
    double duration = distance * secondsPerM;
    return (distance == 0.0 || duration > 0.0) && factory_end(start, duration, end);
}

/* FIFO among operations ready at the same feasible dispatch time. A job's own
 * eligible machines/vehicles compete on projected completion, then table order. */
static int factory_precedes(const FactoryOperation *a, const FactoryOperation *b)
{
    if (b->job < 0) return 1;
    if (a->dispatch != b->dispatch) return a->dispatch < b->dispatch;
    if (a->ready != b->ready) return a->ready < b->ready;
    if (a->job != b->job) return a->job < b->job;
    if (a->finish != b->finish) return a->finish < b->finish;
    if (a->station != b->station) return a->station < b->station;
    return a->carrier < b->carrier;
}

/* Per-stage lists keep the dispatch loop proportional to the actual topology.
 * A stage with no incoming carrier uses the -1 sentinel (co-located handoff). */
typedef struct {
    int stations[FACTORY_RESOURCES], carriers[FACTORY_RESOURCES], stationCount, carrierCount;
} FactoryStage;

static int factory_connect(int nr, int ns, const double *resources, const int *mask,
                           const int *first, const int *hasPrevious, FactoryStage *stages)
{
    int beltFrom[FACTORY_RESOURCES], beltTo[FACTORY_RESOURCES];
    for (int r = 0; r < nr; ++r) beltFrom[r] = -1;
    for (int s = 0; s < ns; ++s) {
        FactoryStage *step = stages + s;
        int stationRole = 0;
        step->stationCount = step->carrierCount = 0;
        for (int r = 0; r < nr; ++r) {
            int use = mask[s * nr + r], role = (int)resources[r * FACTORY_RESOURCE_WIDTH + FACTORY_ROLE];
            if (use == 0) continue;
            if (use == 1 && (role == FACTORY_HANDLE || role == FACTORY_MACHINE)) {
                if (stationRole && stationRole != role) return FACTORY_MASK;
                stationRole = role;
                step->stations[step->stationCount++] = r;
            } else if (use == 2 && (role == FACTORY_CONVEYOR || role == FACTORY_MOBILE)) {
                step->carriers[step->carrierCount++] = r;
            } else return FACTORY_MASK;
        }
        if (!step->stationCount || (first[s] && step->carrierCount)) return FACTORY_MASK;
        if (step->carrierCount == 0) step->carriers[step->carrierCount++] = -1;
        if (!hasPrevious[s]) continue;
        const FactoryStage *previous = stages + s - 1;
        for (int c = 0; c < step->carrierCount; ++c) {
            int carrier = step->carriers[c];
            if (carrier >= 0 && resources[carrier * FACTORY_RESOURCE_WIDTH + FACTORY_ROLE] == FACTORY_MOBILE) continue;
            for (int i = 0; i < previous->stationCount; ++i) {
                int from = previous->stations[i];
                for (int k = 0; k < step->stationCount; ++k) {
                    int to = step->stations[k];
                    if (carrier < 0) {
                        if (!factory_same_place(resources, from, to)) return FACTORY_CONNECTION;
                    } else if (factory_same_place(resources, from, to)) {
                        return FACTORY_CONNECTION;
                    } else if (beltFrom[carrier] < 0) {
                        beltFrom[carrier] = from;
                        beltTo[carrier] = to;
                    } else if (!factory_same_place(resources, from, beltFrom[carrier]) ||
                               !factory_same_place(resources, to, beltTo[carrier])) return FACTORY_CONNECTION;
                }
            }
        }
    }
    return FACTORY_OK;
}

/* jobs: [firstStage, lastStage, releaseS]
 * resources: [role, xM, yM, serviceS, emptySPerM, loadedSPerM, pickS, dropS]
 * mask: 0 unused, 1 eligible workstation, 2 eligible inbound conveyor/AMR.
 * records: [station, carrier, fromStation, carrierOrigin, readyS, dispatchS,
 *           pickupStartS, loadedStartS, dropStartS, serviceStartS, finishS].
 * Records outside a job's route are zero. A nonzero return invalidates the run. */
static int factory_schedule(int nr, int ns, int nj, const double *jobs,
                            const double *resources, const int *mask, double *records)
{
    if (nr <= 0 || ns <= 0 || nj <= 0 || nr > FACTORY_RESOURCES || ns > FACTORY_STAGES ||
        nj > FACTORY_JOBS || !jobs || !resources || !mask || !records) return FACTORY_DIMENSIONS;
    const int values = nj * ns * FACTORY_RECORD_WIDTH;
    for (int i = 0; i < values; ++i) records[i] = 0.0;
    double freeAt[FACTORY_RESOURCES] = {0}, distances[FACTORY_RESOURCES][FACTORY_RESOURCES];
    int location[FACTORY_RESOURCES], next[FACTORY_JOBS], last[FACTORY_JOBS], at[FACTORY_JOBS];
    double ready[FACTORY_JOBS];
    for (int r = 0; r < nr; ++r) {
        const double *p = resources + r * FACTORY_RESOURCE_WIDTH;
        for (int k = 0; k < FACTORY_RESOURCE_WIDTH; ++k) {
            if (!__builtin_isfinite(p[k]) || (k >= FACTORY_SERVICE && p[k] < 0.0)) return FACTORY_DEVICE;
        }
        if (p[FACTORY_ROLE] < FACTORY_HANDLE || p[FACTORY_ROLE] > FACTORY_MOBILE ||
            p[FACTORY_ROLE] != (int)p[FACTORY_ROLE]) return FACTORY_DEVICE;
        if (p[FACTORY_ROLE] <= FACTORY_MACHINE && p[FACTORY_SERVICE] <= 0.0) return FACTORY_DEVICE;
        if (p[FACTORY_ROLE] >= FACTORY_CONVEYOR && p[FACTORY_LOADED] <= 0.0) return FACTORY_DEVICE;
        if (p[FACTORY_ROLE] == FACTORY_MOBILE && p[FACTORY_EMPTY] <= 0.0) return FACTORY_DEVICE;
        location[r] = r;
        for (int i = 0; i <= r; ++i) distances[i][r] = distances[r][i] =
            factory_distance(p, resources + i * FACTORY_RESOURCE_WIDTH);
    }
    int first[FACTORY_STAGES] = {0}, hasPrevious[FACTORY_STAGES] = {0}, remaining = 0;
    for (int j = 0; j < nj; ++j) {
        const double *job = jobs + j * FACTORY_JOB_WIDTH;
        if (!__builtin_isfinite(job[0]) || !__builtin_isfinite(job[1]) || !__builtin_isfinite(job[2]) ||
            job[0] < 1 || job[1] > ns || job[0] > job[1] || job[2] < 0.0 ||
            job[0] != (int)job[0] || job[1] != (int)job[1]) return FACTORY_JOB;
        next[j] = (int)job[0] - 1;
        last[j] = (int)job[1] - 1;
        ready[j] = job[2];
        at[j] = -1;
        first[next[j]] = 1;
        for (int s = next[j] + 1; s <= last[j]; ++s) hasPrevious[s] = 1;
        remaining += last[j] - next[j] + 1;
    }
    FactoryStage stages[FACTORY_STAGES];
    int status = factory_connect(nr, ns, resources, mask, first, hasPrevious, stages);
    if (status != FACTORY_OK) return status;
    while (remaining > 0) {
        FactoryOperation best = {.job = -1};
        for (int j = 0; j < nj; ++j) {
            if (next[j] > last[j] || (best.job >= 0 && ready[j] > best.dispatch)) continue;
            const FactoryStage *step = stages + next[j];
            for (int i = 0; i < step->stationCount; ++i) {
                int station = step->stations[i];
                double earliest = ready[j] > freeAt[station] ? ready[j] : freeAt[station];
                if (best.job >= 0 && earliest > best.dispatch) continue;
                for (int k = 0; k < step->carrierCount; ++k) {
                    int carrier = step->carriers[k];
                    double dispatch = carrier >= 0 && freeAt[carrier] > earliest ? freeAt[carrier] : earliest;
                    if (best.job >= 0 && dispatch > best.dispatch) continue;
                    FactoryOperation event = {
                        .job = j, .station = station, .carrier = carrier, .from = at[j], .origin = -1,
                        .ready = ready[j], .dispatch = dispatch, .pickupStart = dispatch, .loadedStart = dispatch,
                        .dropStart = dispatch, .serviceStart = dispatch
                    };
                    if (carrier >= 0) {
                        const double *p = resources + carrier * FACTORY_RESOURCE_WIDTH;
                        event.origin = p[FACTORY_ROLE] == FACTORY_MOBILE ? location[carrier] : at[j];
                        if (!factory_arrive(dispatch, distances[event.origin][at[j]], p[FACTORY_EMPTY], &event.pickupStart) ||
                            !factory_end(event.pickupStart, p[FACTORY_PICK], &event.loadedStart) ||
                            !factory_arrive(event.loadedStart, distances[at[j]][station], p[FACTORY_LOADED], &event.dropStart) ||
                            !factory_end(event.dropStart, p[FACTORY_DROP], &event.serviceStart)) goto numeric_error;
                    }
                    if (!factory_end(event.serviceStart, resources[station * FACTORY_RESOURCE_WIDTH + FACTORY_SERVICE],
                                     &event.finish)) goto numeric_error;
                    if (factory_precedes(&event, &best)) best = event;
                }
            }
        }
        /* Validation guarantees a workstation and an inbound transfer for every stage. */
        int j = best.job;
        double *row = records + (j * ns + next[j]) * FACTORY_RECORD_WIDTH;
        row[0] = best.station + 1; row[1] = best.carrier + 1;
        row[2] = best.from + 1; row[3] = best.origin + 1;
        row[4] = best.ready; row[5] = best.dispatch; row[6] = best.pickupStart;
        row[7] = best.loadedStart; row[8] = best.dropStart;
        row[9] = best.serviceStart; row[10] = best.finish;
        if (best.carrier >= 0) {
            freeAt[best.carrier] = best.serviceStart;
            location[best.carrier] = best.station;
        }
        freeAt[best.station] = best.finish;
        ready[j] = best.finish;
        at[j] = best.station;
        ++next[j];
        --remaining;
    }
    return FACTORY_OK;

numeric_error:
    for (int i = 0; i < values; ++i) records[i] = 0.0;
    return FACTORY_NUMERIC;
}
#endif
