/**
 * Second sqlite connection for the read API.
 * The writer keeps its own handle. This one is read-only.
 * Importing the module does not open a file.
 */

import { DatabaseSync } from "node:sqlite";

/**
 * @param {string} path
 */
export function openReadConnection(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}
