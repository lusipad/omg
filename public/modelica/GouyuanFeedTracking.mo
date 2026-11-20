within ;
package GouyuanFeedTracking "从连续位置指令驱动直驱丝杠进给轴的模型"
  extends Modelica.Icons.Package;
  import SI = Modelica.Units.SI;
  import NonSI = Modelica.Units.NonSI;
  import Convert = Modelica.Units.Conversions;
  import R = Modelica.Mechanics.Rotational;
  import T = Modelica.Mechanics.Translational;

  model TrackingFeedAxis "水平直驱丝杠和移动工作台的连续参考位置跟踪"
    Modelica.Blocks.Interfaces.RealInput referenceMm(unit="mm") "从起始工作位置起算的有符号直线位置指令";
    parameter Real leadMmPerRev(unit="mm", min=0)=5 "每转直线进给，mm/rev" annotation(Evaluate=false);
    parameter SI.Mass tableMassKg(min=0)=5 "随工作台移动的总质量" annotation(Evaluate=false);
    parameter SI.Inertia rotorInertiaKgM2(min=0)=0.0000145 annotation(Evaluate=false);
    parameter SI.Torque ratedTorqueNm(min=0)=1.27 annotation(Evaluate=false);
    parameter SI.Power ratedPowerW(min=0)=400 annotation(Evaluate=false);
    parameter NonSI.AngularVelocity_rpm ratedSpeedRpm(min=0)=3000 annotation(Evaluate=false);
    parameter SI.Current driveRatedCurrentA(min=0)=2.8 annotation(Evaluate=false);
    parameter SI.Current motorRatedCurrentA(min=0)=2.8 annotation(Evaluate=false);

    Gouyuan.PositionDrive drive(referenceInertiaKgM2=2*rotorInertiaKgM2,
      ratedTorqueNm=ratedTorqueNm, ratedSpeedRpm=ratedSpeedRpm,
      driveRatedCurrentA=driveRatedCurrentA, motorRatedCurrentA=motorRatedCurrentA);
    Gouyuan.RatedTorqueMotor motor(rotorInertiaKgM2=rotorInertiaKgM2,
      ratedTorqueNm=ratedTorqueNm, ratedPowerW=ratedPowerW, motorRatedCurrentA=motorRatedCurrentA,
      rotor(stateSelect=StateSelect.always));
    Gouyuan.IdealLeadScrew screw(leadMmPerRev=leadMmPerRev);
    T.Components.Mass table(m=tableMassKg);
    T.Sensors.ForceSensor thrust;
    R.Sensors.AngleSensor angle;
    R.Sensors.SpeedSensor speed;

    output Real positionMm(unit="mm");
    output Real velocityMmS(unit="mm/s");
    output SI.Torque motorTorqueNm "电机施加的总转矩，包括加速转子所需转矩";
    output SI.Force axialForceN "丝杠施加在工作台上的有符号推力";
    output NonSI.Angle_deg angleDeg;
    output NonSI.AngularVelocity_rpm speedRpm;
  initial equation
    assert(leadMmPerRev > 0 and tableMassKg > 0, "丝杠导程与移动总质量须为正值。");
  equation
    drive.targetAngleRad = 2*Modelica.Constants.pi*(referenceMm/leadMmPerRev);
    connect(angle.phi, drive.angleRad);
    connect(speed.w, drive.speedRadS);
    connect(drive.currentCommandA, motor.currentA);
    connect(motor.shaft, angle.flange);
    connect(motor.shaft, speed.flange);
    connect(motor.shaft, screw.shaft);
    connect(screw.carriage, thrust.flange_a);
    connect(thrust.flange_b, table.flange_a);
    positionMm = 1000*table.s;
    velocityMmS = 1000*table.v;
    motorTorqueNm = motor.torqueNm;
    axialForceN = thrust.f;
    angleDeg = Convert.to_deg(angle.phi);
    speedRpm = Convert.to_rpm(speed.w);
    annotation(experiment(StartTime=0, StopTime=8, Interval=0.01, Tolerance=1e-8),
      Documentation(info="<html><p>水平刚性进给轴，接收连续位置指令 referenceMm（mm），支持限位急停或轨迹跟踪耦合仿真。</p></html>"));
  end TrackingFeedAxis;
  annotation(version="1.0.0", uses(Gouyuan(version="1.0.0"), Modelica(version="4.0.0")));
end GouyuanFeedTracking;
