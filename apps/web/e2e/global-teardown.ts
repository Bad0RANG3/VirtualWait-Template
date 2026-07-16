import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export default async function globalTeardown() {
  await rm(path.join(os.tmpdir(), "virtualwait-playwright-data"), {
    recursive: true,
    force: true,
  });
}
