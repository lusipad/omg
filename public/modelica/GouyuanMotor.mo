within ;
package GouyuanMotor "由绕组、永磁转子与轴承组成的伺服电机"
  extends Modelica.Icons.Package;
  import SI = Modelica.Units.SI;
  import NonSI = Modelica.Units.NonSI;
  import Convert = Modelica.Units.Conversions;
  import R = Modelica.Mechanics.Rotational;
  import T = Modelica.Mechanics.Translational;

  block StatorWinding "三相正弦绕组的基波 q 轴"
    parameter SI.Resistance phaseResistanceOhm(min=0)=2;
    parameter SI.Inductance qInductanceH(min=0)=0.004;
    parameter Real windingTurns(min=1)=50 "每相串联匝数";
    parameter Real windingFactor(min=0,max=1)=0.9 "基波绕组系数";
    Modelica.Blocks.Interfaces.RealInput voltageV(unit="V"), backEmfV(unit="V"), fluxPerPoleWb(unit="Wb");
    Modelica.Blocks.Interfaces.RealOutput currentA(unit="A",start=0,fixed=true,stateSelect=StateSelect.always);
    Modelica.Blocks.Interfaces.RealOutput fluxLinkageWb(unit="Wb");
    Real currentSlopeAS(unit="A/s") "q 轴电流变化率";
  initial equation
    assert(phaseResistanceOhm > 0 and qInductanceH > 0 and windingTurns >= 1 and
      windingTurns <= floor(windingTurns) and windingFactor > 0 and windingFactor <= 1, "请核对定子电阻、电感、整数匝数和绕组系数。");
  equation
    fluxLinkageWb = windingTurns*windingFactor*fluxPerPoleWb;
    currentSlopeAS = der(currentA);
    qInductanceH*currentSlopeAS = voltageV - phaseResistanceOhm*currentA - backEmfV;
  end StatorWinding;

  model PermanentMagnetRotor "表贴永磁转子的磁通、电磁转换与转动惯量"
    parameter Real polePairs(min=1)=2;
    parameter SI.MagneticFlux rotorFluxWb(min=0)=0.001 "每极基波磁通，满距单匝峰值";
    parameter SI.Inertia rotorInertiaKgM2(min=0)=0.00002;
    Modelica.Blocks.Interfaces.RealInput currentA(unit="A"), fluxLinkageWb(unit="Wb");
    Modelica.Blocks.Interfaces.RealOutput fluxPerPoleWb(unit="Wb"), backEmfV(unit="V"), torqueNm(unit="N.m");
    R.Interfaces.Flange_b shaft;
    R.Components.Inertia inertia(J=rotorInertiaKgM2,phi(start=0,fixed=true),w(start=0,fixed=true),stateSelect=StateSelect.always);
    R.Sources.Torque source(useSupport=false);
  initial equation
    assert(polePairs >= 1 and polePairs <= floor(polePairs) and rotorFluxWb > 0 and rotorInertiaKgM2 > 0,
      "请核对正整数极对数、永磁磁通和转子惯量。");
  equation
    fluxPerPoleWb = rotorFluxWb;
    backEmfV = polePairs*fluxLinkageWb*inertia.w;
    torqueNm = 1.5*polePairs*fluxLinkageWb*currentA;
    source.tau = torqueNm;
    connect(source.flange, inertia.flange_a);
    connect(inertia.flange_b, shaft);
  end PermanentMagnetRotor;

  model BearingSupport "一组同规格轴承的速度相关阻力"
    parameter SI.RotationalDampingConstant bearingViscousNmS(min=0)=0.00012 "每只轴承的等效粘性阻尼";
    parameter Real bearingCount(min=1)=2;
    R.Interfaces.Flange_a shaft;
    R.Components.Damper drag(d=bearingCount*bearingViscousNmS);
    R.Components.Fixed housing;
  initial equation
    assert(bearingViscousNmS >= 0 and bearingCount >= 1 and bearingCount <= floor(bearingCount),
      "轴承数量必须是正整数，粘性阻尼必须非负。");
  equation
    connect(shaft, drag.flange_a);
    connect(drag.flange_b, housing.flange);
  end BearingSupport;

  model PMServoMotor "部件装配而成的永磁伺服电机"
    parameter SI.Resistance phaseResistanceOhm=2;
    parameter SI.Inductance qInductanceH=0.004;
    parameter Real windingTurns=50, windingFactor=0.9, polePairs=2;
    parameter SI.MagneticFlux rotorFluxWb=0.001;
    parameter SI.Inertia rotorInertiaKgM2=0.00002;
    parameter SI.RotationalDampingConstant bearingViscousNmS=0.00012;
    parameter Real bearingCount=2;
    Modelica.Blocks.Interfaces.RealInput voltageV(unit="V");
    Modelica.Blocks.Interfaces.RealOutput currentA(unit="A"), backEmfV(unit="V"), torqueNm(unit="N.m");
    R.Interfaces.Flange_b shaft;
    StatorWinding stator(phaseResistanceOhm=phaseResistanceOhm,qInductanceH=qInductanceH,
      windingTurns=windingTurns,windingFactor=windingFactor);
    PermanentMagnetRotor rotor(polePairs=polePairs,rotorFluxWb=rotorFluxWb,rotorInertiaKgM2=rotorInertiaKgM2);
    BearingSupport bearings(bearingViscousNmS=bearingViscousNmS,bearingCount=bearingCount);
  equation
    connect(voltageV, stator.voltageV);
    connect(rotor.fluxPerPoleWb, stator.fluxPerPoleWb);
    connect(stator.fluxLinkageWb, rotor.fluxLinkageWb);
    connect(rotor.backEmfV, stator.backEmfV);
    connect(stator.currentA, rotor.currentA);
    connect(stator.currentA, currentA);
    connect(rotor.backEmfV, backEmfV);
    connect(rotor.torqueNm, torqueNm);
    connect(rotor.shaft, bearings.shaft);
    connect(rotor.shaft, shaft);
  end PMServoMotor;

  model CncFeedAxis "将装配电机接入水平直驱丝杠轴"
    replaceable model MotorModel = PMServoMotor constrainedby PMServoMotor "安装在轴上的电机总成类型";
    parameter Real targetMm(unit="mm")=10 annotation(Evaluate=false);
    parameter Real leadMmPerRev(unit="mm",min=0)=5 annotation(Evaluate=false);
    parameter SI.Mass tableMassKg(min=0)=5 annotation(Evaluate=false);
    parameter SI.Resistance phaseResistanceOhm(min=0)=2 annotation(Evaluate=false);
    parameter SI.Inductance qInductanceH(min=0)=0.004 annotation(Evaluate=false);
    parameter Real windingTurns(min=1)=50 annotation(Evaluate=false);
    parameter Real windingFactor(min=0,max=1)=0.9 annotation(Evaluate=false);
    parameter SI.Current windingCurrentLimitA(min=0)=4 "峰值 q 轴电流指令上限" annotation(Evaluate=false);
    parameter Real polePairs(min=1)=2 annotation(Evaluate=false);
    parameter SI.MagneticFlux rotorFluxWb(min=0)=0.001 annotation(Evaluate=false);
    parameter SI.Inertia rotorInertiaKgM2(min=0)=0.00002 annotation(Evaluate=false);
    parameter SI.RotationalDampingConstant bearingViscousNmS(min=0)=0.00012 annotation(Evaluate=false);
    parameter Real bearingCount(min=1)=2 annotation(Evaluate=false);
    parameter SI.Voltage driveVoltageLimitV(min=0)=24 "可用 q 轴电压幅值" annotation(Evaluate=false);
    parameter SI.Current driveCurrentLimitA(min=0)=4 annotation(Evaluate=false);
    parameter NonSI.AngularVelocity_rpm driveSpeedLimitRpm(min=0)=2500 annotation(Evaluate=false);
    parameter SI.Inertia driveReferenceInertiaKgM2(min=0)=0.00004 "工况指定的控制器整定基准" annotation(Evaluate=false);
    parameter SI.Resistance currentGainOhm(min=0)=8 "比例电流反馈的跨阻增益" annotation(Evaluate=false);

    Gouyuan.PositionDrive drive(referenceInertiaKgM2=driveReferenceInertiaKgM2,
      ratedTorqueNm=1.5*polePairs*windingTurns*windingFactor*rotorFluxWb*windingCurrentLimitA,
      ratedSpeedRpm=driveSpeedLimitRpm,driveRatedCurrentA=min(driveCurrentLimitA,windingCurrentLimitA),
      motorRatedCurrentA=windingCurrentLimitA);
    MotorModel motor(phaseResistanceOhm=phaseResistanceOhm,qInductanceH=qInductanceH,windingTurns=windingTurns,
      windingFactor=windingFactor,polePairs=polePairs,rotorFluxWb=rotorFluxWb,rotorInertiaKgM2=rotorInertiaKgM2,
      bearingViscousNmS=bearingViscousNmS,bearingCount=bearingCount);
    Gouyuan.IdealLeadScrew screw(leadMmPerRev=leadMmPerRev);
    T.Components.Mass table(m=tableMassKg);
    R.Sensors.AngleSensor angle;
    R.Sensors.SpeedSensor speed;
    SI.Voltage requestedVoltageV, appliedVoltageV;
    output Real positionMm(unit="mm"), velocityMmS(unit="mm/s");
    output NonSI.Angle_deg angleDeg;
    output NonSI.AngularVelocity_rpm speedRpm;
    output SI.Current currentA;
    output SI.Torque motorTorqueNm;
  initial equation
    assert(leadMmPerRev > 0 and tableMassKg > 0 and windingCurrentLimitA > 0 and
      driveVoltageLimitV > 0 and currentGainOhm > 0, "请核对轴的导程、移动质量和电流环工况。");
  equation
    drive.targetAngleRad = 2*Modelica.Constants.pi*(targetMm/leadMmPerRev);
    connect(angle.phi, drive.angleRad);
    connect(speed.w, drive.speedRadS);
    requestedVoltageV = currentGainOhm*(drive.currentCommandA - motor.currentA) + motor.backEmfV;
    appliedVoltageV = noEvent(max(-driveVoltageLimitV, min(driveVoltageLimitV, requestedVoltageV)));
    motor.voltageV = appliedVoltageV;
    connect(motor.shaft, angle.flange);
    connect(motor.shaft, speed.flange);
    connect(motor.shaft, screw.shaft);
    connect(screw.carriage, table.flange_a);
    positionMm = 1000*table.s;
    velocityMmS = 1000*table.v;
    angleDeg = Convert.to_deg(angle.phi);
    speedRpm = Convert.to_rpm(speed.w);
    currentA = motor.currentA;
    motorTorqueNm = motor.torqueNm;
    annotation(experiment(StartTime=0,StopTime=8,Interval=0.01,Tolerance=1e-8),
      Documentation(info="<html><p>幅值不变 dq 变换，i_d=0，电流与电压使用相峰值。水平刚性直驱轴采用理想反馈、固定增益、反电动势前馈和 q 轴电压限幅。轴承仅计速度相关的粘性阻力，忽略静摩擦、间隙、热变化、饱和、齿槽和 PWM 纹波。</p></html>"));
  end CncFeedAxis;

  annotation(version="1.0.0", uses(Gouyuan(version="1.0.0"),Modelica(version="4.0.0")));
end GouyuanMotor;
