within ;
package GouyuanLinear "构元直线进给轴"
  extends Modelica.Icons.Package;
  import SI = Modelica.Units.SI;
  import NonSI = Modelica.Units.NonSI;
  import Convert = Modelica.Units.Conversions;
  import R = Modelica.Mechanics.Rotational;
  import T = Modelica.Mechanics.Translational;

  model FeedAxis "水平直驱丝杠和移动工作台的位置阶跃"
    parameter Real targetMm(unit="mm")=10 annotation(Evaluate=false);
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
    drive.targetAngleRad = 2*Modelica.Constants.pi*(targetMm/leadMmPerRev);
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
      Documentation(info="<html><p>水平刚性轴，正导程，初始位置和速度均为零。工作台质量由丝杠两端的力和运动约束直接作用到转子。模型采用无损丝杠和固定控制整定，忽略丝杠自身惯量、摩擦、间隙与切削力。</p></html>"));
  end FeedAxis;
  annotation(version="1.0.0", uses(Gouyuan(version="1.0.0"), Modelica(version="4.0.0")));
end GouyuanLinear;
