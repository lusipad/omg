import { scheduleFactory, type FactoryInputs } from "./factory-kernel";

self.onmessage = (event: MessageEvent<{ module: WebAssembly.Module; input: FactoryInputs }>) => {
  try {
    const records = scheduleFactory(event.data.module, event.data.input);
    self.postMessage(records, { transfer: [records.buffer] });
  } catch (cause) {
    self.postMessage({ error: cause instanceof Error ? cause.message : "工厂求解失败。" });
  }
};
