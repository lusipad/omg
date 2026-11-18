import { describe, expect, it } from "vitest";
import { recordLocalModelEvent } from "../dev/servo-local-model";

describe("Codex 纯文本结果", () => {
  it("保留真实 CLI 在推理前发出诊断消息的成功轮次", () => {
    const turn = { answer: "", completed: false };
    const transcript = [
      { type: "thread.started" }, { type: "item.completed", item: { type: "error" } }, { type: "turn.started" },
      { type: "item.completed", item: { type: "agent_message", text: '{"series":"SV660N"}' } }, { type: "turn.completed" },
    ];
    for (const event of transcript) recordLocalModelEvent(JSON.stringify(event), turn);
    expect(turn).toEqual({ answer: '{"series":"SV660N"}', completed: true });
  });

  it.each(["command_execution", "file_change", "mcp_tool_call", "web_search", "collab_tool_call"])("拒绝 %s 事件", type => {
    expect(() => recordLocalModelEvent(JSON.stringify({ type: "item.started", item: { type } }), { answer: "", completed: false })).toThrow("使用了工具");
  });

  it("格式错误不会被当作工具或成功回答", () => {
    expect(() => recordLocalModelEvent("{", { answer: "", completed: false })).toThrow("无法识别");
  });

  it("已收到文本的失败轮次仍返回失败", () => {
    const turn = { answer: '{"series":"SV660N"}', completed: false };
    expect(() => recordLocalModelEvent('{"type":"turn.failed"}', turn)).toThrow("推理失败");
    expect(turn.completed).toBe(false);
  });
});
