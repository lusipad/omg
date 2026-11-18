import { packageKey, parseDevicePackage } from "./twin-device";
import { generateDevicePackage, inovanceSource } from "./twin-extract";
import { addInstance, connectPorts, emptyWorkspace, installPackage, setInput } from "./twin-simulation";
import voltageSourceDefinition from "../examples/voltage-source.device.json";
import { servoExampleDrive, servoExampleMotor } from "./servo-example";
import { assembleServoAxis } from "./servo-axis";

export function createTwinDemo() {
  const inputModule = generateDevicePackage(inovanceSource);
  const voltageSource = parseDevicePackage(voltageSourceDefinition);

  let workspace = installPackage(emptyWorkspace(), inputModule);
  workspace = installPackage(workspace, voltageSource);
  workspace = addInstance(workspace, packageKey(inputModule), "数字输入模块");
  workspace = addInstance(workspace, packageKey(voltageSource), "测试电压源");
  const [receiver, source] = workspace.instances;
  workspace = setInput(workspace, source.id, "setting", 24);
  return connectPorts(workspace, {
    from: { instanceId: source.id, portId: "out" },
    to: { instanceId: receiver.id, portId: "v0" },
  });
}

export function createServoDemo() {
  const devices = installPackage(installPackage(emptyWorkspace(), servoExampleDrive), servoExampleMotor);
  return assembleServoAxis(devices, {
    driveKey: packageKey(servoExampleDrive), motorKey: packageKey(servoExampleMotor),
    targetDeg: 90, loadInertiaRatio: 1,
  });
}
