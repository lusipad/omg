within ;
package GouyuanFactory "制造与物流设备的工厂级节拍模型"
  extends Modelica.Icons.Package;
  import SI = Modelica.Units.SI;

  partial model ProcessDevice "单件处理与单载具运输的公共节拍接口"
    output SI.Time serviceS "工位对每个工件的处理时间";
    output Real emptySPerM(unit="s/m") "载具每米空驶时间";
    output Real loadedSPerM(unit="s/m") "每米有载运输时间";
    output SI.Time pickS "载具取件时间";
    output SI.Time dropS "载具放件时间";
  end ProcessDevice;

  partial model Workstation "固定处理工位"
    extends ProcessDevice;
  equation
    emptySPerM = 0;
    loadedSPerM = 0;
    pickS = 0;
    dropS = 0;
  end Workstation;

  partial model HandlingStation "上下料工位的替换接口"
    extends Workstation;
    final constant Integer handleRole=1 "上下料设备的调度角色";
  end HandlingStation;

  partial model MachineStation "加工工位的替换接口"
    extends Workstation;
    final constant Integer machineRole=2 "加工设备的调度角色";
  end MachineStation;

  partial model FixedConveyor "固定输送设备的替换接口"
    extends ProcessDevice;
    final constant Integer conveyorRole=3 "固定输送的调度角色";
  end FixedConveyor;

  partial model MobileCarrier "移动运输设备的替换接口"
    extends ProcessDevice;
    final constant Integer mobileRole=4 "移动载具的调度角色";
  end MobileCarrier;

  model PickPlace "每件货物的上下料节拍"
    extends HandlingStation;
    parameter SI.Time handlingS(min=0)=3 annotation(Evaluate=false);
  initial equation
    assert(handlingS > 0, "每件处理时间必须为正。");
  equation
    serviceS = handlingS;
  end PickPlace;

  model BeltConveyor "固定端点间的单件定速输送"
    extends FixedConveyor;
    parameter SI.Velocity speedMps(min=0)=1 annotation(Evaluate=false);
  initial equation
    assert(speedMps > 0, "输送速度必须为正。");
  equation
    serviceS = 0;
    emptySPerM = 0;
    loadedSPerM = 1 / speedMps;
    pickS = 0;
    dropS = 0;
  end BeltConveyor;

  model MobileRobot "定速空驶、取件、有载运输和放件"
    extends MobileCarrier;
    parameter SI.Velocity emptySpeedMps(min=0)=1.5 annotation(Evaluate=false);
    parameter SI.Velocity loadedSpeedMps(min=0)=1 annotation(Evaluate=false);
    parameter SI.Time pickTimeS(min=0)=1 annotation(Evaluate=false);
    parameter SI.Time dropTimeS(min=0)=1 annotation(Evaluate=false);
  initial equation
    assert(emptySpeedMps > 0 and loadedSpeedMps > 0 and pickTimeS >= 0 and dropTimeS >= 0, "请核对载具速度与取放时间。");
  equation
    serviceS = 0;
    emptySPerM = 1 / emptySpeedMps;
    loadedSPerM = 1 / loadedSpeedMps;
    pickS = pickTimeS;
    dropS = dropTimeS;
  end MobileRobot;

  model CycleCNC "以测定或给定的整件加工周期计算"
    extends MachineStation;
    parameter SI.Time cycleS(min=0)=30 annotation(Evaluate=false);
  initial equation
    assert(cycleS > 0, "加工周期必须为正。");
  equation
    serviceS = cycleS;
  end CycleCNC;

  model FeedCNC "装夹辅助时间与匀速切削进给时间之和"
    extends MachineStation;
    parameter SI.Time clampS(min=0)=4 annotation(Evaluate=false);
    parameter Real cutLengthMm(unit="mm", min=0)=160 annotation(Evaluate=false);
    parameter Real feedMmMin(unit="mm/min", min=0)=600 annotation(Evaluate=false);
  initial equation
    assert(clampS >= 0 and cutLengthMm > 0 and feedMmMin > 0, "请核对辅助时间、切削长度与进给速度。");
  equation
    serviceS = clampS + 60 * (cutLengthMm / feedMmMin);
  end FeedCNC;

  function schedule "从批次、已选设备的节拍与路线计算共享资源的工序时刻"
    input Integer nr "设备实例数";
    input Integer ns "全部路线的工序总数";
    input Integer nj "工件数";
    input Real jobs[3*nj] "每件依次记录首工序、末工序和释放时刻";
    input Real resources[8*nr] "设备角色、平面坐标和五个节拍输出";
    input Integer mask[ns*nr] "依次为各工序的候选工位和载具";
    output Integer status;
    output Real records[nj*ns*11] "工件、工序、十一项派工记录，按行展开";
    external "C" status = factory_schedule(nr, ns, nj, jobs, resources, mask, records)
      annotation(Include="#include \"factory_schedule.h\"", IncludeDirectory="modelica://GouyuanFactory/Resources/Include");
  end schedule;

  annotation(version="1.0.0", uses(Modelica(version="4.0.0")));
end GouyuanFactory;
