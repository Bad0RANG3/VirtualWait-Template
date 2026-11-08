import fs from "fs";
import path from "path";

// The main file plus its WAL/SHM companions are one unit of runtime state: a
// leftover `-wal` would be replayed into the freshly created database and could
// resurrect rows the reset was supposed to drop.
const dataDir = process.env.VIRTUALWAIT_DATA_DIR
  ? path.resolve(process.env.VIRTUALWAIT_DATA_DIR)
  : path.join(process.cwd(), "data");
const dbFile = path.join(dataDir, "virtualwait.db");
const targets = [dbFile, `${dbFile}-wal`, `${dbFile}-shm`];

let removed = 0;
for (const target of targets) {
  if (fs.existsSync(target)) {
    fs.unlinkSync(target);
    console.log("Removed", target);
    removed += 1;
  }
}
if (removed === 0) {
  console.log("No database files to remove");
}
