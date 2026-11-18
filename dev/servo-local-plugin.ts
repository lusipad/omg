import { getRequestListener } from "@hono/node-server";
import { TLSSocket } from "node:tls";
import { TRPCError } from "@trpc/server";
import { getHTTPStatusCodeFromError } from "@trpc/server/http";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Plugin } from "vite";
import { readLimitedBytes } from "../api/lib/read-limited-bytes";
import { codexChatLogin, codexServoModel, findLocalCodex } from "./servo-local-model";

const localAddress = (value?: string) => value === "::1" || value === "127.0.0.1" || value === "::ffff:127.0.0.1";
const prefix = "/api/local-servo";

export function localServoPlugin(enabled: boolean): Plugin {
  return {
    name: "servo-local-codex", apply: "serve", enforce: "pre",
    configureServer(server) {
      const binary = enabled ? findLocalCodex() : undefined;
      let busy = false;
      const app = new Hono();
      app.onError((error, c) => {
        if (error instanceof HTTPException) return c.json({ error: error.message }, error.status);
        if (error instanceof TRPCError) return Response.json({ error: error.message }, { status: getHTTPStatusCodeFromError(error) });
        return c.json({ error: "本机生成失败，请核对资料和 Codex 登录状态。" }, 500);
      });
      app.get(prefix + "/status", async c => c.json({ available: Boolean(binary && await codexChatLogin(binary)) }));
      app.post(prefix + "/generate", async c => {
        if (!binary) throw new HTTPException(503, { message: "请使用 npm run dev:servo 启动已安装 Codex 的本机工作台。" });
        if (busy) throw new HTTPException(429, { message: "本机已有一组伺服设备正在生成，请等待完成。" });
        if (c.req.header("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
          throw new HTTPException(415, { message: "请通过工作台提交两条官方资料链接。" });
        }
        busy = true;
        try {
          const bytes = await readLimitedBytes(c.req.raw, 8192, new HTTPException(413, { message: "资料链接请求过长。" }));
          let input: unknown;
          try { input = JSON.parse(bytes.toString("utf8")); }
          catch { throw new HTTPException(400, { message: "资料链接的 JSON 格式有误。" }); }
          // Load the same server module through Vite so project aliases and hot reload apply in development.
          const { servoPairInputSchema, generateServoPair } = await server.ssrLoadModule("/api/servo-generation.ts");
          const parsed = servoPairInputSchema.safeParse(input);
          if (!parsed.success) throw new HTTPException(400, { message: "请提供驱动器、电机的官方 HTTPS 链接及可选型号。" });
          if (!await codexChatLogin(binary)) throw new HTTPException(503, { message: "请先用 Codex CLI 登录 ChatGPT 再生成。" });
          return c.json(await generateServoPair(parsed.data, (prompt: string) => codexServoModel(binary, prompt, c.req.raw.signal)));
        } finally { busy = false; }
      });
      const handle = getRequestListener(app.fetch, { overrideGlobalObjects: false });
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith(prefix + "/")) return next();
        const host = req.headers.host ?? "";
        const localHost = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/i.test(host);
        const origin = req.headers.origin;
        const protocol = req.socket instanceof TLSSocket && req.socket.encrypted ? "https:" : "http:";
        const sameOrigin = origin === `${protocol}//${host}`;
        const proxied = ["forwarded", "x-forwarded-for", "x-forwarded-host"].some(key => req.headers[key] !== undefined);
        if (!localAddress(req.socket.remoteAddress) || !localHost || proxied || (origin !== undefined && !sameOrigin)
          || (req.method === "POST" && !sameOrigin) || req.headers["sec-fetch-site"] === "cross-site") {
          res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ error: "请从本机同源工作台发起操作。" }));
          return;
        }
        void handle(req, res);
      });
    },
  };
}
