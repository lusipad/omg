import driveDefinition from "../examples/SV660NS2R8I-FS-INT.device.json";
import motorDefinition from "../examples/MS1H1-40B30CB-A331R-INT.device.json";
import { parseDevicePackage } from "./twin-device";

export const servoExampleDrive = parseDevicePackage(driveDefinition);
export const servoExampleMotor = parseDevicePackage(motorDefinition);
export const servoExampleLinks = {
  driveUrl: driveDefinition.source.productUrl,
  motorUrl: motorDefinition.source.productUrl,
  catalogUrl: driveDefinition.source.url,
};
