within ;
package Gouyuan "构元机电部件库"
  extends Modelica.Icons.Package;
  import SI = Modelica.Units.SI;
  import NonSI = Modelica.Units.NonSI;
  import Convert = Modelica.Units.Conversions;
  import R = Modelica.Mechanics.Rotational;
  import T = Modelica.Mechanics.Translational;

  block PositionDrive "固定增益位置/速度环与连续电流限制"
    parameter SI.Inertia referenceInertiaKgM2(min=0)=2*0.0000145;
    parameter SI.Torque ratedTorqueNm(min=0)=1.27;
    parameter NonSI.AngularVelocity_rpm ratedSpeedRpm(min=0)=3000;
    parameter SI.Current driveRatedCurrentA(min=0)=2.8;
    parameter SI.Current motorRatedCurrentA(min=0)=2.8;
    Modelica.Blocks.Interfaces.RealInput targetAngleRad(unit="rad");
    Modelica.Blocks.Interfaces.RealInput angleRad(unit="rad");
    Modelica.Blocks.Interfaces.RealInput speedRadS(unit="rad/s");
    Modelica.Blocks.Interfaces.RealOutput currentCommandA(unit="A");
  protected
    constant Real wn(unit="1/s")=24 "参考惯量下的临界阻尼自然频率，仿真假设";
    SI.AngularVelocity speedReference;
    SI.Torque requestedTorque;
  initial equation
    assert(referenceInertiaKgM2 > 0 and ratedTorqueNm > 0 and ratedSpeedRpm > 0 and
      driveRatedCurrentA > 0 and motorRatedCurrentA > 0, "驱动器的参考惯量与额定参数必须为正值。");
  equation
    speedReference = noEvent(max(-Convert.from_rpm(ratedSpeedRpm),
      min(Convert.from_rpm(ratedSpeedRpm), 0.5*wn*(targetAngleRad - angleRad))));
    requestedTorque = 2*wn*referenceInertiaKgM2*(speedReference - speedRadS);
    currentCommandA = noEvent(max(-driveRatedCurrentA,
      min(driveRatedCurrentA, requestedTorque*motorRatedCurrentA/ratedTorqueNm)));
  end PositionDrive;

  model RatedTorqueMotor "额定点校准的平均转矩源与电机转子"
    parameter SI.Inertia rotorInertiaKgM2(min=0)=0.0000145;
    parameter SI.Torque ratedTorqueNm(min=0)=1.27;
    parameter SI.Power ratedPowerW(min=0)=400;
    parameter SI.Current motorRatedCurrentA(min=0)=2.8;
    Modelica.Blocks.Interfaces.RealInput currentA(unit="A");
    Modelica.Blocks.Interfaces.RealOutput torqueNm(unit="N.m") "电机施加在转子上的有符号转矩";
    R.Interfaces.Flange_b shaft;
    R.Components.Inertia rotor(J=rotorInertiaKgM2, phi(start=0, fixed=true), w(start=0, fixed=true));
  protected
    R.Sources.Torque torqueSource(useSupport=false);
    SI.Torque torqueCap;
  initial equation
    assert(rotorInertiaKgM2 > 0 and ratedTorqueNm > 0 and ratedPowerW > 0 and motorRatedCurrentA > 0,
      "电机的转子惯量、额定转矩、功率和电流必须为正值。");
  equation
    torqueCap = ratedPowerW/noEvent(max(abs(rotor.w), ratedPowerW/ratedTorqueNm));
    torqueNm = noEvent(max(-torqueCap, min(torqueCap, currentA*ratedTorqueNm/motorRatedCurrentA)));
    torqueSource.tau = torqueNm;
    connect(torqueSource.flange, rotor.flange_a);
    connect(rotor.flange_b, shaft);
  end RatedTorqueMotor;

  model ServoAxis "从零位接受位置阶跃的刚性伺服轴"
    parameter NonSI.Angle_deg targetDeg(min=-3600,max=3600)=90 annotation(Evaluate=false);
    parameter Real loadInertiaRatio(min=0,max=100)=1 annotation(Evaluate=false);
    parameter SI.Inertia rotorInertiaKgM2(min=0)=0.0000145 annotation(Evaluate=false);
    parameter SI.Torque ratedTorqueNm(min=0)=1.27 annotation(Evaluate=false);
    parameter SI.Power ratedPowerW(min=0)=400 annotation(Evaluate=false);
    parameter NonSI.AngularVelocity_rpm ratedSpeedRpm(min=0)=3000 annotation(Evaluate=false);
    parameter SI.Current driveRatedCurrentA(min=0)=2.8 annotation(Evaluate=false);
    parameter SI.Current motorRatedCurrentA(min=0)=2.8 "资料未列电机电流时，按已知配套的驱动器额定电流估算" annotation(Evaluate=false);
    output NonSI.Angle_deg angleDeg;
    output NonSI.AngularVelocity_rpm speedRpm;
    output SI.Torque torqueNm;
    PositionDrive drive(referenceInertiaKgM2=2*rotorInertiaKgM2, ratedTorqueNm=ratedTorqueNm,
      ratedSpeedRpm=ratedSpeedRpm, driveRatedCurrentA=driveRatedCurrentA, motorRatedCurrentA=motorRatedCurrentA);
    RatedTorqueMotor motor(rotorInertiaKgM2=rotorInertiaKgM2, ratedTorqueNm=ratedTorqueNm,
      ratedPowerW=ratedPowerW, motorRatedCurrentA=motorRatedCurrentA);
    R.Components.Inertia load(J=rotorInertiaKgM2*loadInertiaRatio);
    R.Sensors.AngleSensor angle;
    R.Sensors.SpeedSensor speed;
  initial equation
    assert(loadInertiaRatio >= 0 and loadInertiaRatio <= 100 and abs(targetDeg) <= 3600,
      "目标角度须在 ±3600° 内，负载惯量比须在 0 至 100 内。");
  equation
    drive.targetAngleRad = Convert.from_deg(targetDeg);
    connect(angle.phi, drive.angleRad);
    connect(speed.w, drive.speedRadS);
    connect(drive.currentCommandA, motor.currentA);
    connect(motor.shaft, load.flange_a);
    connect(load.flange_b, angle.flange);
    connect(load.flange_b, speed.flange);
    angleDeg = Convert.to_deg(angle.phi);
    speedRpm = Convert.to_rpm(speed.w);
    torqueNm = motor.torqueNm;
    annotation(experiment(StartTime=0, StopTime=8, Interval=0.01, Tolerance=1e-8),
      Documentation(info="<html><p>理想电流跟踪，额定点线性换算电流与转矩，连续转矩和功率对称限幅。轴系刚性，未计摩擦、传动间隙、控制延迟和电磁暂态。控制器参数为模型假设。</p></html>"));
  end ServoAxis;

  model IdealLeadScrew "固定支撑的无损丝杠，可连接旋转与平动端口"
    parameter Real leadMmPerRev(unit="mm", min=0)=5 "每转的直线进给，mm/rev";
    R.Interfaces.Flange_a shaft;
    T.Interfaces.Flange_b carriage;
    R.Components.IdealGearR2T gear(ratio=2*Modelica.Constants.pi/(leadMmPerRev*0.001),
      useSupportR=false, useSupportT=false);
  initial equation
    assert(leadMmPerRev > 0, "丝杠导程必须大于零。");
  equation
    connect(shaft, gear.flangeR);
    connect(gear.flangeT, carriage);
  end IdealLeadScrew;

  model IdealLeadScrewBench "恒速旋转、恒定轴向阻力的丝杠端口验收"
    parameter Real leadMmPerRev(unit="mm", min=0)=5 annotation(Evaluate=false);
    parameter NonSI.AngularVelocity_rpm inputSpeedRpm=120 annotation(Evaluate=false);
    parameter SI.Force loadN=100 "正值阻抗正向移动" annotation(Evaluate=false);
    R.Sources.ConstantSpeed source(w_fixed=Convert.from_rpm(inputSpeedRpm), useSupport=false, phi(start=0, fixed=true));
    R.Sensors.TorqueSensor shaftTorque;
    R.Sensors.SpeedSensor shaftSpeed;
    IdealLeadScrew screw(leadMmPerRev=leadMmPerRev);
    T.Sensors.ForceSensor thrust;
    T.Sensors.PositionSensor position;
    T.Sensors.SpeedSensor linearSpeed;
    T.Sources.ConstantForce load(f_constant=-loadN, useSupport=false);
    output Real positionMm(unit="mm");
    output Real speedMmS(unit="mm/s");
    output SI.Torque driveTorqueNm;
    output SI.Force axialForceN;
    output SI.Power shaftPowerW;
    output SI.Power linearPowerW;
  equation
    connect(source.flange, shaftTorque.flange_a);
    connect(shaftTorque.flange_b, screw.shaft);
    connect(screw.shaft, shaftSpeed.flange);
    connect(screw.carriage, thrust.flange_a);
    connect(thrust.flange_b, load.flange);
    connect(screw.carriage, position.flange);
    connect(screw.carriage, linearSpeed.flange);
    positionMm = 1000*position.s;
    speedMmS = 1000*linearSpeed.v;
    driveTorqueNm = shaftTorque.tau;
    axialForceN = thrust.f;
    shaftPowerW = shaftTorque.tau*shaftSpeed.w;
    linearPowerW = thrust.f*linearSpeed.v;
    annotation(experiment(StartTime=0, StopTime=1, Interval=0.01, Tolerance=1e-8));
  end IdealLeadScrewBench;

  annotation(version="1.0.0", uses(Modelica(version="4.0.0")));
end Gouyuan;
