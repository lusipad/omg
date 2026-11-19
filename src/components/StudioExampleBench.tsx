import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { FolderInput } from "lucide-react";
import type { MotorAxisLocation, StudioExample, StudioTarget } from "@contracts/studio-navigation";
import { upsertLinearAssembly } from "@contracts/linear-assembly";
import { upsertFactoryLayout } from "@contracts/factory";
import type { TwinWorkspace } from "@contracts/twin-simulation";
import { loadStudioExample, prepareStudioExampleJoin, type LoadedStudioExample, type StudioBenchKind } from "@/lib/studio-example-workspace";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

const Wiring = lazy(() => import("./TwinSimulation"));
const Servo = lazy(() => import("./ServoAxisBench"));
const Linear = lazy(() => import("./LinearAssemblyBench"));
const Factory = lazy(() => import("./FactoryBench"));
const Follower = lazy(() => import("./So101MotionBench"));
const Mill = lazy(() => import("./MiloWorkbench"));
type ProjectProps = { workspace: TwinWorkspace; initialStructureId?: string; initialMotorResourceId?: string; initialMotorAxisId?: string;
  onApply: (next: TwinWorkspace, target: StudioTarget, focus?: MotorAxisLocation) => void };
type Confirmation = { project: TwinWorkspace; sample: TwinWorkspace; next: TwinWorkspace; description: string };
const errorMessage = (cause: unknown) => cause instanceof Error ? cause.message : "示例操作失败，请重试。";

function ExampleSession({ kind, download, workspace, initialStructureId, initialMotorResourceId, initialMotorAxisId, onApply }: ProjectProps & { kind: StudioBenchKind; download?: string }) {
  const motorFocus = useRef<MotorAxisLocation | undefined>(undefined);
  const trackMotor = useCallback((focus?: MotorAxisLocation) => { motorFocus.current = focus; }, []);
  const [loaded, setLoaded] = useState<LoadedStudioExample | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [assemblyReady, setAssemblyReady] = useState(false);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    loadStudioExample(kind, controller.signal, download).then(example => {
      if (!controller.signal.aborted) setLoaded(example);
    }).catch(cause => {
      if (!controller.signal.aborted) setError(errorMessage(cause));
    });
    return () => controller.abort();
  }, [kind, download, attempt]);

  function edit(next: TwinWorkspace) {
    setLoaded(previous => previous && { ...previous, workspace: next });
    setError(""); setConfirmation(null);
  }
  function apply(next: TwinWorkspace, sample: TwinWorkspace) {
    if (kind === "factory") {
      const layout = sample.factories?.[0];
      if (!layout) throw new Error("请先载入工厂布局。");
      onApply(next, `factory:${layout.id}`, motorFocus.current);
      return;
    }
    if (kind !== "linear-assembly") { onApply(next, kind); return; }
    const assembly = sample.assemblies?.[0];
    if (!assembly) throw new Error("请先载入直线装配。");
    onApply(next, `assembly:${assembly.id}`);
  }
  function join() {
    if (!loaded) return;
    setError("");
    try {
      const change = prepareStudioExampleJoin(kind, workspace, loaded.workspace);
      if (change.replacement) setConfirmation({ project: workspace, sample: loaded.workspace, next: change.next, description: change.replacement });
      else apply(change.next, loaded.workspace);
    } catch (cause) { setError(errorMessage(cause)); }
  }
  function confirm() {
    if (!confirmation) return;
    setConfirmation(null);
    if (confirmation.project !== workspace || confirmation.sample !== loaded?.workspace) {
      setError("工程或示例已修改，请重新核对要加入的配置。");
      return;
    }
    try { apply(confirmation.next, confirmation.sample); }
    catch (cause) { setError(errorMessage(cause)); }
  }

  if (!loaded) return error ? <div className="surface space-y-3 p-4">
    <p role="alert" className="text-sm text-destructive">{error}</p>
    <Button size="sm" variant="outline" onClick={() => { setError(""); setAttempt(n => n + 1); }}>重试载入示例</Button>
  </div> : <p className="p-4 text-sm text-muted-foreground" role="status">正在准备示例…</p>;

  const sample = loaded.workspace;
  const follower = sample.so101;
  const unapplied = (kind === "linear-assembly" || kind === "factory") && !assemblyReady;
  return <div className="min-w-0 space-y-4">
    <div className="flex flex-wrap items-center justify-end gap-2">
      {kind === "servo" && <p className="mr-auto text-xs text-muted-foreground">修改伺服参数后，请先组轴并运行。</p>}
      {unapplied && <p className="mr-auto text-xs text-muted-foreground">运行或应用当前设置后可加入工程。</p>}
      <Button size="sm" onClick={join} disabled={unapplied}><FolderInput />加入当前工程</Button>
    </div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <Suspense fallback={<p role="status" className="p-4 text-sm text-muted-foreground">正在打开运行台…</p>}>
      {kind === "wiring" && <Wiring workspace={sample} onChange={edit} />}
      {kind === "servo" && <Servo workspace={sample} onChange={edit} />}
      {kind === "linear-assembly" && <Linear trial workspace={sample} assembly={sample.assemblies?.[0]} onTrialReady={setAssemblyReady}
        onSave={assembly => edit(upsertLinearAssembly(sample, assembly))} />}
      {kind === "factory" && <Factory trial workspace={sample} layout={sample.factories?.[0]} initialStructureId={initialStructureId} initialMotorResourceId={initialMotorResourceId} initialMotorAxisId={initialMotorAxisId} onMotorFocus={trackMotor}
        onUpdateLibrary={edit} onTrialReady={setAssemblyReady}
        onSave={(layout, revised) => edit(upsertFactoryLayout(revised ?? sample, layout))} />}
      {kind === "so101" && follower && <Follower waypoints={follower.waypoints}
        onChange={waypoints => edit({ ...sample, so101: { ...follower, waypoints } })} />}
      {kind === "milo" && <Mill workspace={sample} initialPlan={loaded.plan} onChange={edit} />}
    </Suspense>
    <Dialog open={confirmation !== null} onOpenChange={open => { if (!open) setConfirmation(null); }}>
      <DialogContent>
        <DialogHeader><DialogTitle>确认替换当前配置</DialogTitle><DialogDescription className="break-words">{confirmation?.description}</DialogDescription></DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setConfirmation(null)}>取消</Button>
          <Button onClick={confirm}>确认替换并加入</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>;
}

export default function StudioExampleBench({ example, ...project }: ProjectProps & { example: StudioExample }) {
  if (example.kind === "physics") return null;
  return <ExampleSession key={JSON.stringify([example.id, project.initialStructureId, project.initialMotorResourceId, project.initialMotorAxisId])} kind={example.kind} download={example.download} {...project} />;
}
