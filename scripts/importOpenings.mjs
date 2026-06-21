import { createClient } from "@supabase/supabase-js";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const OPENINGS_DIR = path.join(process.cwd(), "public", "chess-openings-master");
const BATCH_SIZE = 500;
const SOURCE = "lichess/chess-openings";

const supabaseUrl = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceRoleKey) {
  console.error(
    [
      "Missing Supabase import credentials.",
      "Set SUPABASE_URL or VITE_SUPABASE_URL, and set SUPABASE_SERVICE_ROLE_KEY in .env.",
      "Use the service-role key only for local scripts or trusted server environments.",
    ].join("\n"),
  );
  process.exit(1);
}

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

const tsvFiles = (await readdir(OPENINGS_DIR))
  .filter((fileName) => /^[a-e]\.tsv$/i.test(fileName))
  .sort();

let totalRows = 0;

for (const fileName of tsvFiles) {
  const filePath = path.join(OPENINGS_DIR, fileName);
  const tsv = await readFile(filePath, "utf8");
  const rows = parseOpeningRows(tsv, fileName);

  console.log(`Importing ${rows.length} rows from ${fileName}`);

  for (let index = 0; index < rows.length; index += BATCH_SIZE) {
    const batch = rows.slice(index, index + BATCH_SIZE);
    const { error } = await supabase
      .from("opening_lines")
      .upsert(batch, { onConflict: "source_file,eco,name,pgn" });

    if (error) {
      console.error(`Failed while importing ${fileName} rows ${index + 1}-${index + batch.length}`);
      console.error(error.message);
      process.exit(1);
    }
  }

  totalRows += rows.length;
}

console.log(`Done. Imported or updated ${totalRows} opening lines.`);

function parseOpeningRows(tsv, sourceFile) {
  const lines = tsv.trim().split(/\r?\n/);
  const [, ...dataRows] = lines;

  return dataRows.flatMap((row) => {
    const [eco, name, pgn] = row.split("\t");

    if (!eco || !name || !pgn) {
      return [];
    }

    return {
      eco,
      name,
      pgn,
      family: getOpeningFamily(eco, name),
      source: SOURCE,
      source_file: sourceFile,
      move_count: countPlies(pgn),
      updated_at: new Date().toISOString(),
    };
  });
}

function getOpeningFamily(eco, name) {
  if (eco >= "C60" && eco <= "C99" && /^Ruy Lopez|^Spanish Game/.test(name)) {
    return "spanish-game";
  }

  return slugify(name.split(":")[0] ?? name);
}

function slugify(value) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function countPlies(pgn) {
  return pgn
    .replace(/\d+\.(\.\.)?/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}
