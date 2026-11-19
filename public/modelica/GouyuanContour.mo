within ;
package GouyuanContour "从连续位置指令驱动装机电机的轮廓跟踪模型"
  extends Modelica.Icons.Package;
  import SI = Modelica.Units.SI;
  import NonSI = Modelica.Units.NonSI;
  import Convert = Modelica.Units.Conversions;
  import R = Modelica.Mechanics.Rotational;
  import T = Modelica.Mechanics.Translational;

  model TrackingAxis "用实际装机电机跟踪工作台相对位移指令"
    replaceable model MotorModel = GouyuanMotor.PMServoMotor constrainedby GouyuanMotor.PMServoMotor;
    Modelica.Blocks.Interfaces.RealInput referenceMm(unit="mm") "从起始工作位置算的有符号指令位移";
    parameter Real leadMmPerRev(unit="mm",min=0)=5 annotation(Evaluate=false);
    parameter SI.Mass tableMassKg(min=0)=5 annotation(Evaluate=false);
    parameter SI.Resistance phaseResistanceOhm(min=0)=2 annotation(Evaluate=false);
    parameter SI.Inductance qInductanceH(min=0)=0.004 annotation(Evaluate=false);
    parameter Real windingTurns(min=1)=50 annotation(Evaluate=false);
    parameter Real windingFactor(min=0,max=1)=0.9 annotation(Evaluate=false);
    parameter SI.Current windingCurrentLimitA(min=0)=4 annotation(Evaluate=false);
    parameter Real polePairs(min=1)=2 annotation(Evaluate=false);
    parameter SI.MagneticFlux rotorFluxWb(min=0)=0.001 annotation(Evaluate=false);
    parameter SI.Inertia rotorInertiaKgM2(min=0)=0.00002 annotation(Evaluate=false);
    parameter SI.RotationalDampingConstant bearingViscousNmS(min=0)=0.00012 annotation(Evaluate=false);
    parameter Real bearingCount(min=1)=2 annotation(Evaluate=false);
    parameter SI.Voltage driveVoltageLimitV(min=0)=24 annotation(Evaluate=false);
    parameter SI.Current driveCurrentLimitA(min=0)=4 annotation(Evaluate=false);
    parameter NonSI.AngularVelocity_rpm driveSpeedLimitRpm(min=0)=2500 annotation(Evaluate=false);
    parameter SI.Inertia driveReferenceInertiaKgM2(min=0)=0.00004 annotation(Evaluate=false);
    parameter SI.Resistance currentGainOhm(min=0)=8 annotation(Evaluate=false);

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
    drive.targetAngleRad = 2*Modelica.Constants.pi*(referenceMm/leadMmPerRev);
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
    annotation(Documentation(info="<html><p>位置输入随时间连续更新。绕组电流、转角及角速度从静止零状态连续演化，工件系初始坐标由装夹资料给出。模型使用理想位置反馈、刚性直驱丝杠和零净外载。用于竖直轴时假定重力已平衡，切削力与传动间隙须另行建模。</p></html>"));
  end TrackingAxis;

  annotation(version="1.0.0",uses(GouyuanMotor(version="1.0.0"),Gouyuan(version="1.0.0"),Modelica(version="4.0.0")));
end GouyuanContour;
