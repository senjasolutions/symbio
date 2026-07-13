/**
 * Database bootstrap owns the single Sequelize connection and applies SQLite
 * reliability pragmas before any request is accepted.
 */

import { Sequelize } from "sequelize";
import { config } from "../config.js";
import { defineModels } from "./models.js";

export const sequelize = new Sequelize({
  dialect: "sqlite",
  storage: config.databasePath,
  logging: false,
  pool: { max: 1, min: 0, idle: 10_000 },
});

export const models = defineModels(sequelize);

/** Opens SQLite and enables constraints, WAL, and a short lock wait. */
export const connectDatabase = async () => {
  await sequelize.authenticate();
  await sequelize.query("PRAGMA foreign_keys = ON");
  await sequelize.query("PRAGMA journal_mode = WAL");
  await sequelize.query("PRAGMA busy_timeout = 5000");
};

/** Closes SQLite during graceful process shutdown. */
export const closeDatabase = async () => {
  await sequelize.close();
};
