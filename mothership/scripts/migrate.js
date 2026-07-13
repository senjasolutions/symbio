/** CLI entrypoint applies explicit migrations before startup or seeding. */

import { closeDatabase, connectDatabase } from "../src/db/index.js";
import { runMigrations } from "../src/db/migrations.js";

try {
  await connectDatabase();
  await runMigrations();
  console.log("Symbio mothership migrations are current.");
} finally {
  await closeDatabase();
}
