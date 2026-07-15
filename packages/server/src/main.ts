import { buildServer } from "./app/server.js";
import { env } from "./config.js";

async function main() {
  const app = await buildServer();

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, "shutting down");
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  try {
    await app.listen({ port: env.PORT, host: env.HOST });
  } catch (err) {
    app.log.error(err, "failed to start server");
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  // Only reachable if buildServer() itself throws, before app.log exists.
  console.error(err);
  process.exit(1);
});
