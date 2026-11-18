import { useState } from "react";
import { Boxes, Download } from "lucide-react";
import type { ModelRef } from "@contracts/import-catalog";
import { PICK_PLACE_EXAMPLE } from "@contracts/robot-examples";
import { Button } from "@/components/ui/button";

const slots = [
  { key: "arm", label: "机械臂组件", defaultName: "UR5e（目录模型包）" },
  { key: "gripper", label: "夹爪组件", defaultName: "Robotiq 2F-85（目录模型包）" },
  { key: "part", label: "工件组件", defaultName: "30 mm 自由方块（独立工件）" },
] as const;
const measurementHint = "夹爪的默认上举指令为 50 mm。运行后展开“阶段观测记录”，对照“夹紧保持”和“悬空保持”两行的夹爪与工件高度。";

type Props = {
  models: readonly ModelRef[];
  assembled: boolean;
  busy: boolean;
  partUrl: string;
  onChange: () => void;
  onAssemble: (arm?: ModelRef, gripper?: ModelRef, part?: ModelRef) => void;
};

export default function PickPlaceAssembly({ models, assembled, busy, partUrl, onChange, onAssemble }: Props) {
  const [selected, setSelected] = useState({ arm: "", gripper: "", part: "" });
  const [adjusting, setAdjusting] = useState(false);
  const selectedParts = slots.map(({ key }) => models.find((model) => model.id === selected[key]));
  const missing = slots.find(({ key }, i) => selected[key] && !selectedParts[i]);

  if (assembled && !adjusting) return <div aria-label="取放工位组件" className="space-y-2 border-b pb-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="min-w-0 break-words text-xs text-muted-foreground">{slots.map((slot, i) => selectedParts[i]?.name ?? slot.defaultName).join(" + ")}</p>
      <Button size="sm" variant="outline" onClick={() => setAdjusting(true)}>调整组件</Button>
    </div>
    <p className="text-xs leading-5 text-muted-foreground">{measurementHint}</p>
  </div>;

  return <form aria-label="取放工位组件" className="min-w-0 space-y-3" onSubmit={(event) => {
    event.preventDefault();
    if (busy || missing) return;
    setAdjusting(false);
    onAssemble(selectedParts[0], selectedParts[1], selectedParts[2]);
  }}>
    <h3 className="text-base font-semibold">{assembled ? "调整工位组件" : PICK_PLACE_EXAMPLE.name}</h3>
    <p className="text-sm leading-6 text-muted-foreground">选择机械臂、夹爪和工件。自有组件可先导入并安装，再从对应列表选择。</p>
    <div className="grid min-w-0 gap-3 md:grid-cols-3">
      {slots.map((slot) => <label key={slot.key} className="min-w-0">
        <span className="field-label">{slot.label}</span>
        <select aria-label={slot.label} className="h-9 w-full min-w-0 rounded-md border border-input bg-background px-2 text-sm" value={selected[slot.key]} onChange={(event) => {
          const id = event.target.value;
          onChange(); setSelected((previous) => ({ ...previous, [slot.key]: id }));
        }}>
          <option value="">{slot.defaultName}</option>
          {models.length > 0 && <optgroup label="本机已安装模型">{models.map((model) => <option value={model.id} key={model.id}>
            {model.name} · {model.entry} · {model.id.slice(0, 10)}
          </option>)}</optgroup>}
        </select>
      </label>)}
    </div>
    <p className="text-xs leading-5 text-muted-foreground">{measurementHint}</p>
    {missing && <p role="alert" className="text-sm text-destructive">选定的{missing.label}已不在当前模型库，请重新选择。</p>}
    <div className="flex flex-wrap items-center gap-3">
      <Button type="submit" disabled={busy || Boolean(missing)}><Boxes />组装取放工位</Button>
      <a href={partUrl} download className="inline-flex items-center gap-1 text-xs text-primary hover:underline"><Download className="size-3.5" />下载 30 mm 自由方块</a>
      {assembled && <Button type="button" size="sm" variant="ghost" onClick={() => setAdjusting(false)}>收起组件</Button>}
    </div>
  </form>;
}
