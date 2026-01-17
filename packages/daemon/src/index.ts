import path from "path";
import { Runtime } from "./runtime/runtime.js";
import { createServer } from "./api/server.js";

const port = Number(process.env.VUHLP_PORT ?? 4000);
const dataDir = process.env.VUHLP_DATA_DIR ?? path.resolve(process.cwd(), "data");

const runtime = new Runtime({ dataDir });
runtime.start();

const server = createServer(runtime);
server.listen(port, () => {
  console.log(`vuhlp daemon listening on http://localhost:${port}`);
});
