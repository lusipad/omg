/* One isolated WebAssembly instance owns one set of ABI buffers. */
#include "factory_schedule.h"

static double resource_data[FACTORY_RESOURCES * FACTORY_RESOURCE_WIDTH];
static int stage_mask[FACTORY_STAGES * FACTORY_RESOURCES];
static double job_data[FACTORY_JOBS * FACTORY_JOB_WIDTH];
static double operation_data[FACTORY_JOBS * FACTORY_STAGES * FACTORY_RECORD_WIDTH];

double *factory_resources_ptr(void) { return resource_data; }
int *factory_mask_ptr(void) { return stage_mask; }
double *factory_jobs_ptr(void) { return job_data; }
double *factory_records_ptr(void) { return operation_data; }

int factory_run(int nr, int ns, int nj)
{
    return factory_schedule(nr, ns, nj, job_data, resource_data, stage_mask, operation_data);
}
