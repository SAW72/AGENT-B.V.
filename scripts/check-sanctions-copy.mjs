import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const skip = new Set(["node_modules", "dist", "coverage", ".git", "out", "cache"]);
const allowed = new Set([".md", ".mjs", ".js", ".ts", ".tsx", ".html", ".toml", ".yml", ".yaml", ".json"]);
const compliant = /ofac[-\s]compliant/i;
const proof = /sanctions[-\s]proof/i;
const endorsement = /endorsed by (?:the )?(?:u\.s\. )?treasury|treasury endorsement|ofac(?:\s|-)endorsed/i;
const negation = /not certified|isn't certified|is not certified|aren't certified|are not certified|never certified|no certification|not a certification/i;
const sanctionsTopic = /sanction|\bofac\b|\bsdn\b/i;
const pluralLists = /\blists\b/i;
const ALLOWED_SCREENING_LINE = "We screen wallet addresses against the U.S. Treasury OFAC SDN list. Screening may not catch every sanctioned party.";
const publicCopy = [
  "services/points-indexer/README.md",
  "docs/reputation-ledger.md",
  "docs/AGENT-BV-POINTS-SPEC.md",
  "PRIVACY.md",
  "docs/SANCTIONS-APPEALS.md",
];

const failures = [];

function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (skip.has(name)) continue;
    const path = join(dir, name);
    const info = statSync(path);
    if (info.isDirectory()) {
      walk(path);
      continue;
    }
    const dot = name.lastIndexOf(".");
    if (dot < 0 || !allowed.has(name.slice(dot))) continue;
    if (path.endsWith("check-sanctions-copy.mjs")) continue;
    const text = readFileSync(path, "utf8");
    const lines = text.split(/\r?\n/);
    lines.forEach((line, index) => {
      const where = `${relative(root, path)}:${index + 1}`;
      if (compliant.test(line) || proof.test(line) || endorsement.test(line)) failures.push(where + " " + line.trim());
      if (sanctionsTopic.test(line) && pluralLists.test(line)) {
        failures.push(where + " plural lists: " + line.trim());
      }
      const mentionsList = /ofac|sanction/i.test(line);
      const mentionsCertified = /certified/i.test(line);
      if (mentionsList && mentionsCertified && !negation.test(line)) {
        failures.push(where + " " + line.trim());
      }
    });
  }
}

walk(root);
for (const rel of publicCopy) {
  const text = readFileSync(join(root, rel), "utf8");
  if (!text.includes(ALLOWED_SCREENING_LINE)) failures.push(rel + " is missing the screening sentence");
  const extra = text.split(ALLOWED_SCREENING_LINE).length - 1;
  if (extra !== 1) failures.push(rel + " must contain the screening sentence once");
}
if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("sanctions public copy ok");
