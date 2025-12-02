import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CREATE_PATH = path.join(
  __dirname,
  "..",
  "src",
  "database",
  "parkcreate2.txt",
);
const INSERTS_PATH = path.join(
  __dirname,
  "..",
  "src",
  "database",
  "parkinserts2.txt",
);
// NOTE: write to public so browser can fetch it directly
const OUT_PATH = path.join(__dirname, "..", "public", "parkdata.json");

function readFileSafe(p) {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return "";
  }
}
function stripHashComments(s) {
  return s
    .split("\n")
    .map((l) => {
      const idx = l.indexOf("#");
      return idx >= 0 ? l.slice(0, idx) : l;
    })
    .join("\n");
}

function parseCreateTables(sql) {
  const out = {};
  if (!sql) return out;
  sql = stripHashComments(sql);
  const re = /create\s+table\s+`?([A-Za-z0-9_]+)`?\s*\(([\s\S]*?)\)\s*;/gi;
  let m;
  while ((m = re.exec(sql))) {
    const table = m[1];
    const body = m[2];
    const cols = [];
    const lines = body.split(/,(?![^\(]*\))/).map((l) => l.trim());
    for (let line of lines) {
      line = line.replace(/\/\*[\s\S]*?\*\//g, "").trim();
      if (!line) continue;
      if (
        /^primary\s+key/i.test(line) ||
        /^unique/i.test(line) ||
        /^constraint/i.test(line) ||
        /^foreign\s+key/i.test(line) ||
        /^index/i.test(line)
      )
        continue;
      const colMatch = line.match(/^`?([A-Za-z0-9_]+)`?\s+([A-Za-z0-9_\(\)]+)/);
      if (colMatch) cols.push(colMatch[1]);
    }
    out[table] = { columns: cols, rows: [] };
  }
  return out;
}

function splitTopLevelTuples(s) {
  s = s.trim();
  if (!s) return [];
  const tuples = [];
  let cur = "";
  let depth = 0;
  let inQuote = false;
  let prev = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    cur += ch;
    if (ch === "'" && prev !== "\\") inQuote = !inQuote;
    else if (!inQuote) {
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
    }
    prev = ch;
    if (depth === 0) {
      let j = i + 1;
      while (j < s.length && /\s/.test(s[j])) j++;
      if (j < s.length && s[j] === ",") {
        tuples.push(cur.trim());
        cur = "";
        i = j;
      } else if (j >= s.length) {
        tuples.push(cur.trim());
        cur = "";
        break;
      }
    }
  }
  return tuples
    .map((t) => t.replace(/^\(+/, "").replace(/\)+$/, "").trim())
    .filter(Boolean);
}

function parseValuesList(tuple) {
  const vals = [];
  let cur = "";
  let inQuote = false;
  let prev = null;
  for (let i = 0; i < tuple.length; i++) {
    const ch = tuple[i];
    if (ch === "'" && prev !== "\\") {
      inQuote = !inQuote;
      cur += ch;
    } else if (ch === "," && !inQuote) {
      vals.push(cur.trim());
      cur = "";
    } else cur += ch;
    prev = ch;
  }
  if (cur.trim() !== "") vals.push(cur.trim());
  return vals.map((v) => {
    if (/^null$/i.test(v)) return null;
    if (/^'(.*)'$/s.test(v)) {
      const inner = v.replace(/^'(.*)'$/s, "$1").replace(/\\'/g, "'");
      return inner.replace(/\\\\/g, "\\");
    }
    if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
    return v.replace(/^"(.*)"$/, "$1");
  });
}

function parseInserts(sql, tablesMeta) {
  if (!sql) return;
  sql = stripHashComments(sql);
  const re =
    /insert\s+into\s+`?([A-Za-z0-9_]+)`?\s*(?:\(([^)]+)\))?\s*values\s*([\s\S]*?);/gi;
  let m;
  while ((m = re.exec(sql))) {
    const table = m[1];
    const colsRaw = m[2];
    const valsRaw = m[3];
    const tuples = splitTopLevelTuples(valsRaw);
    const colList = colsRaw
      ? colsRaw.split(",").map((c) => c.replace(/`/g, "").trim())
      : tablesMeta[table]
        ? tablesMeta[table].columns
        : null;
    if (!colList) continue;
    for (const t of tuples) {
      const parsed = parseValuesList(t);
      const obj = {};
      for (let i = 0; i < colList.length; i++)
        obj[colList[i]] = parsed[i] === undefined ? null : parsed[i];
      if (!tablesMeta[table])
        tablesMeta[table] = { columns: colList, rows: [] };
      tablesMeta[table].rows.push(obj);
    }
  }
}

function normalizeName(s) {
  if (!s) return "";
  // remove diacritics and non-word, lowercase
  return String(s)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function buildJson() {
  const createSql = readFileSafe(CREATE_PATH);
  const insertSql = readFileSafe(INSERTS_PATH);
  const meta = parseCreateTables(createSql);
  parseInserts(insertSql, meta);
  const result = {};
  Object.keys(meta).forEach((t) => (result[t] = meta[t].rows || []));

  // enhance park rows: add normalized_name and isDogPark (from explicit column if exists, else heuristic)
  if (result.park && Array.isArray(result.park)) {
    result.park = result.park.map((row) => {
      // detect likely name column
      const name =
        row.park_name || row.name || row.NOME || row.nome || row.title || "";
      const normalized = normalizeName(name);
      // detect explicit dog column names
      const explicit =
        row.allows_dogs !== undefined && row.allows_dogs !== null
          ? !!row.allows_dogs
          : row.dogpark !== undefined && row.dogpark !== null
            ? !!row.dogpark
            : row.dogs !== undefined && row.dogs !== null
              ? !!row.dogs
              : null;
      const text = JSON.stringify(row).toLowerCase();
      const heuristic =
        /dog|cao|cachorro|cães|caes|canino|perros|cães|cao/i.test(text);
      const isDogPark = explicit === null ? heuristic : explicit;
      return { ...row, _name_normalized: normalized, isDogPark: !!isDogPark };
    });
  }

  // ensure public folder exists and write
  const outDir = path.dirname(OUT_PATH);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(result, null, 2), "utf8");
  console.log(
    new Date().toLocaleTimeString(),
    "→ parkdata.json updated:",
    OUT_PATH,
  );
}

let timeout = null;
function scheduleBuild() {
  if (timeout) clearTimeout(timeout);
  timeout = setTimeout(buildJson, 200);
}

console.log("Watching:", CREATE_PATH, INSERTS_PATH);
buildJson();
fs.watch(CREATE_PATH, { persistent: true }, () => scheduleBuild());
fs.watch(INSERTS_PATH, { persistent: true }, () => scheduleBuild());
fs.watch(path.dirname(CREATE_PATH), (ev, fname) => {
  if (!fname) return;
  if (
    fname === path.basename(CREATE_PATH) ||
    fname === path.basename(INSERTS_PATH)
  )
    scheduleBuild();
});
