// Deterministic schedule examples with independently calculated event times.
// --native runs the identical inputs against a local C compiler as well as the published WASM.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const path = name => fileURLToPath(new URL(name, import.meta.url));
const header = path("../../public/modelica/GouyuanFactory/Resources/Include/factory_schedule.h");
const runtime = path("../../public/modelica/runtime/");
const manifest = JSON.parse(readFileSync(join(runtime, "factory-scheduler.json"), "utf8"));
const wasm = readFileSync(join(runtime, "factory-scheduler.wasm"));
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
assert.equal(sha(wasm), manifest.wasmSha256);
assert.equal(sha(readFileSync(header)), manifest.sourceSha256);
assert.equal(sha(readFileSync(path("factory-scheduler-wasm.c"))), manifest.wrapperSha256);
const library = new WebAssembly.Module(wasm);
assert.deepEqual(WebAssembly.Module.imports(library), []);
const kernel = new WebAssembly.Instance(library).exports;
const recordWidth = manifest.recordColumns.length;
assert.equal(recordWidth, 11);

function nativeComparator(dir) {
  const source = join(dir, "main.c"), executable = join(dir, "check");
  writeFileSync(source, `#include <stdio.h>
#include "factory_schedule.h"
int main(void) {
    int n[3], mask[FACTORY_RESOURCES * FACTORY_STAGES];
    double jobs[FACTORY_JOBS * 3], resources[FACTORY_RESOURCES * 8], out[FACTORY_JOBS * FACTORY_STAGES * 11];
    if (fread(n, sizeof(int), 3, stdin) != 3 || n[0] < 1 || n[0] > FACTORY_RESOURCES ||
        n[1] < 1 || n[1] > FACTORY_STAGES || n[2] < 1 || n[2] > FACTORY_JOBS) return 1;
    size_t nj = (size_t)n[2]*3, nr = (size_t)n[0]*8, nm = (size_t)n[0]*n[1], no = (size_t)n[1]*n[2]*11;
    if (fread(jobs, sizeof(double), nj, stdin) != nj || fread(resources, sizeof(double), nr, stdin) != nr ||
        fread(mask, sizeof(int), nm, stdin) != nm) return 2;
    int status = factory_schedule(n[0], n[1], n[2], jobs, resources, mask, out);
    if (fwrite(&status, sizeof(int), 1, stdout) != 1 || fwrite(out, sizeof(double), no, stdout) != no) return 3;
    return 0;
}`);
  const compiled = spawnSync(process.env.CC || "cc", ["-O2", "-std=c11", "-ffp-contract=off", "-Wall", "-Werror",
    "-I", dirname(header), source, "-lm", "-o", executable], { encoding: "utf8" });
  assert.equal(compiled.status, 0, compiled.error?.message || compiled.stderr);
  return (nr, ns, nj, jobs, resources, mask, status, records) => {
    const input = [Int32Array.of(nr, ns, nj), jobs, resources, mask].map(a => Buffer.from(a.buffer, a.byteOffset, a.byteLength));
    const native = spawnSync(executable, { input: Buffer.concat(input) });
    assert.equal(native.status, 0, native.error?.message || native.stderr.toString());
    assert.equal(native.stdout.readInt32LE(0), status);
    assert.equal(native.stdout.length, 4 + records.length * 8);
    for (const [i, value] of records.entries()) {
      const actual = native.stdout.readDoubleLE(4 + i * 8);
      assert(Math.abs(value - actual) <= 1e-12 * Math.max(1, Math.abs(value)), `native record ${i}: ${actual} / ${value}`);
    }
  };
}

const dir = process.argv.includes("--native") ? mkdtempSync(join(tmpdir(), "gouyuan-factory-tests-")) : undefined;
if (dir) process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
const compare = dir && nativeComparator(dir);
let scenarios = 0;
function checkFlow(resources, mask, jobs, rows) {
  const occupancy = resources.map(() => []);
  const position = (id) => resources[id - 1].slice(1, 3);
  const distance = (a, b) => {
    const [x, y] = position(a), [u, v] = position(b);
    return Math.hypot(x - u, y - v);
  };
  const near = (actual, expected) => assert(Math.abs(actual - expected) <= 1e-12 * Math.max(1, Math.abs(expected)));
  for (let j = 0; j < jobs.length; ++j) {
    const [first, last, release] = jobs[j];
    let previous = 0, readyAt = release;
    for (let s = 0; s < mask.length; ++s) {
      const row = rows[j * mask.length + s];
      if (s + 1 < first || s + 1 > last) {
        assert(row.every(value => value === 0));
        continue;
      }
      const [station, carrier, from, origin, ready, dispatch, pickup, loaded, drop, service, finish] = row;
      assert.equal(mask[s][station - 1], 1);
      assert.equal(from, previous);
      assert.equal(ready, readyAt);
      assert([ready, dispatch, pickup, loaded, drop, service, finish].every((t, i, ts) => i === 0 || t >= ts[i - 1]));
      near(finish - service, resources[station - 1][3]);
      occupancy[station - 1].push([dispatch, finish]);
      if (carrier) {
        const p = resources[carrier - 1];
        assert.equal(mask[s][carrier - 1], 2);
        near(pickup - dispatch, distance(origin, from) * p[4]);
        near(loaded - pickup, p[6]);
        near(drop - loaded, distance(from, station) * p[5]);
        near(service - drop, p[7]);
        occupancy[carrier - 1].push([dispatch, service, origin, station]);
      } else {
        assert.equal(origin, 0);
        assert.equal(dispatch, service);
        if (from) assert.deepEqual(position(from), position(station));
      }
      previous = station; readyAt = finish;
    }
  }
  occupancy.forEach((times, resource) => {
    times.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let end = 0, lastSite = resource + 1;
    for (const [start, stop, origin, destination] of times) {
      assert(start >= end, "Overlapping equipment reservations");
      if (resources[resource][0] === 4) {
        assert.deepEqual(position(origin), position(lastSite), "AMR jumped between assignments");
        lastSite = destination;
      }
      end = stop;
    }
  });
}

function plan(resources, mask, jobs, expected = 0) {
  const nr = resources.length, ns = mask.length, nj = jobs.length;
  const fill = (type, offset, values) => {
    const view = new type(kernel.memory.buffer, offset, values.length);
    view.set(values);
    return view;
  };
  const data = fill(Float64Array, kernel.factory_resources_ptr(), resources.flat());
  const choices = fill(Int32Array, kernel.factory_mask_ptr(), mask.flat());
  const batch = fill(Float64Array, kernel.factory_jobs_ptr(), jobs.flat());
  const status = kernel.factory_run(nr, ns, nj);
  assert.equal(status, expected);
  const flat = new Float64Array(kernel.memory.buffer, kernel.factory_records_ptr(), ns * nj * recordWidth);
  compare?.(nr, ns, nj, batch, data, choices, status, flat);
  scenarios++;
  const rows = Array.from({ length: ns * nj }, (_, i) => Array.from(flat.subarray(i * recordWidth, (i + 1) * recordWidth)));
  if (status) assert(flat.every(value => value === 0), "Invalid run exposed earlier operations");
  else checkFlow(resources, mask, jobs, rows);
  return rows;
}

const station = (role, x, y, service) => [role, x, y, service, 0, 0, 0, 0];
const mobile = (x, y, empty = 1, loaded = 1, pick = 0, drop = 0) => [4, x, y, 0, empty, loaded, pick, drop];
const belt = [3, 0, 0, 0, 0, 0.5, 0.25, 0.75];
const times = rows => rows.map(r => [r[5], r[9], r[10]]);
const zero = Array(11).fill(0);

// FIFO by release time, even when the job table is not in release order.
assert.deepEqual(times(plan([station(1, 0, 0, 4)], [[1]], [[1, 1, 5], [1, 1, 0], [1, 1, 0]])),
  [[8, 8, 12], [0, 0, 4], [4, 4, 8]]);

// The 3-4-5 conveyor loads, moves five metres, unloads, then releases the part.
const fixed = [station(1, 0, 0, 2), station(2, 3, 4, 2), belt];
assert.deepEqual(plan(fixed, [[1, 0, 0], [0, 1, 2]], [[1, 2, 0]])[1],
  [2, 3, 1, 1, 2, 2, 2, 2.25, 4.75, 5.5, 7.5]);

// Two machines share one carrier. Throughput depends on both the empty return
// and the destination machine's capacity. The same machine cannot double-book.
const cells = [station(1, 0, 0, 1), station(2, 10, 0, 80), station(2, 10, 0, 80),
  station(1, 0, 0, 1), mobile(0, 0, 1, 1, 1, 1)];
const recipe = [[1, 0, 0, 0, 0], [0, 1, 1, 0, 2], [0, 0, 0, 1, 2]];
const batch = [[1, 3, 0], [1, 3, 0]];
const parallel = plan(cells, recipe, batch);
assert.deepEqual(parallel[1], [2, 5, 1, 5, 1, 1, 1, 2, 12, 13, 93]);
assert.deepEqual(parallel[4], [3, 5, 1, 2, 2, 13, 23, 24, 34, 35, 115]);
assert.deepEqual(parallel[2], [4, 5, 2, 3, 93, 93, 93, 94, 104, 105, 106]);
assert.deepEqual(parallel[5], [4, 5, 3, 4, 115, 115, 125, 126, 136, 137, 138]);
assert.deepEqual(plan(cells, recipe, batch), parallel);
assert.equal(plan(cells, [recipe[0], [0, 1, 0, 0, 2], recipe[2]], batch)[5][10], 218);

// Separate production lines use different stage ranges and the same mobile robot.
const lines = [station(1, 0, 0, 1), station(2, 2, 0, 2), station(1, 0, 1, 2), station(2, 2, 1, 3), mobile(0, 0)];
const stages = [[1, 0, 0, 0, 0], [0, 1, 0, 0, 2], [0, 0, 1, 0, 0], [0, 0, 0, 1, 2]];
const split = plan(lines, stages, [[1, 2, 0], [3, 4, 0]]);
for (const i of [2, 3, 4, 5]) assert.deepEqual(split[i], zero);
assert.deepEqual(split[1], [2, 5, 1, 5, 1, 1, 1, 1, 3, 3, 5]);
assert.deepEqual(split[7].slice(0, 6), [4, 5, 3, 2, 2, 3]);
assert.equal(split[7][6], 3 + Math.sqrt(5));
assert.equal(split[7][10], 8 + Math.sqrt(5));
const shared = plan(lines, [stages[0], stages[1], stages[2], stages[1]], [[1, 2, 0], [3, 4, 0]]);
assert.deepEqual(shared[7].slice(0, 6), [2, 5, 3, 2, 2, 5]);
const mixedJobs = Array.from({ length: 64 }, (_, i) => i % 2 ? [1, 2, i * 0.4] : [3, 4, i * 0.6]);
plan([...lines, mobile(-3, 1, 0.5, 0.7, 2, 1)], stages.map(row => [...row, row[4]]), mixedJobs);

// A carrier-less handoff stays at the same physical point. A fixed conveyor
// has the same directed endpoints every time it appears, even across recipes.
assert.deepEqual(plan([station(1, 3, 4, 1), station(2, 3, 4, 3)], [[1, 0], [0, 1]], [[1, 2, 0]])[1],
  [2, 0, 1, 0, 1, 1, 1, 1, 1, 1, 4]);
plan(fixed, [[1, 0, 0], [0, 1, 0]], [[1, 2, 0]], 5);
plan(fixed, [[1, 0, 0], [0, 1, 2], [1, 0, 2]], [[1, 3, 0]], 5);
plan([fixed[0], station(2, 0, 0, 2), belt], [[1, 0, 0], [0, 1, 2]], [[1, 2, 0]], 5);
plan(fixed, [[1, 1, 0]], [[1, 1, 0]], 4);
plan(fixed, [[1, 0, 2]], [[1, 1, 0]], 4);
plan(fixed, [[0, 0, 0]], [[1, 1, 0]], 4);
plan(fixed, [[1, 0, 0]], [[1, 1.5, 0]], 3);
plan(fixed, [[1, 0, 0]], [[1, 1, NaN]], 3);
plan([station(1, 0, 0, 0)], [[1]], [[1, 1, 0]], 2);
plan([station(1, 0, 0, 1)], [[1]], [[1, 1, 0], [1, 1, Number.MAX_VALUE]], 6);
assert.equal(kernel.factory_run(33, 1, 1), 1);
assert.equal(kernel.factory_run(1, 17, 1), 1);
assert.equal(kernel.factory_run(1, 1, 65), 1);
assert.equal(kernel.factory_run(0, 1, 1), 1);

const maximum = plan(Array.from({ length: 32 }, () => station(1, 0, 0, 1)),
  Array.from({ length: 16 }, () => Array(32).fill(1)), Array.from({ length: 64 }, () => [1, 16, 0]));
assert.equal(maximum.length, 1024);
assert.equal(Math.max(...maximum.map(row => row[10])), 32);
console.log(`Factory scheduler: ${scenarios} scenarios passed${compare ? " in native C and WebAssembly" : " in WebAssembly"}, including 1024 operations and shared lines.`);
