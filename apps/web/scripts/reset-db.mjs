import fs from "fs";
import path from "path";

const dbFile = path.join(process.cwd(), "data", "virtualwait.db");
if (fs.existsSync(dbFile)) {
  fs.unlinkSync(dbFile);
  console.log("Removed", dbFile);
} else {
  console.log("No database file to remove");
}
