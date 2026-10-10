// Static server for site/ with optional periodic re-indexing.
//   npx tsx src/depositors/serve.ts [--port 8790] [--refresh 300] [--no-names]

import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { parseArgs, runIndexer } from "./indexer.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

export function startServer(port: number, root = "site") {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    let path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
    if (path.endsWith("/")) path += "index.html";
    const file = join(root, path);
    if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" });
    createReadStream(file).pipe(res);
  });
  // Bind to the loopback interface only; nothing on the LAN should reach this server.
  server.listen(port, "127.0.0.1", () => console.error(`depositor ranking: http://localhost:${port}/`));
  return server;
}

const isMain = process.argv[1] && /serve\.(ts|js)$/.test(process.argv[1]);
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  const port = Number(args.port ?? process.env.PORT ?? 8790);
  const refresh = Number(args.refresh ?? 0);
  startServer(port);
  if (refresh > 0) {
    const tick = async () => {
      try {
        await runIndexer({ withNames: args["no-names"] !== "true" });
      } catch (e) {
        console.error(`refresh failed: ${(e as Error).message}`);
      }
      setTimeout(tick, refresh * 1000);
    };
    void tick();
  }
}
