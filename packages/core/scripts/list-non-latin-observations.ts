/**
 * List the observations a Latin-only embedder would refuse (#155).
 *
 *   MONET_DB=~/.monet/monet.db npx tsx scripts/list-non-latin-observations.ts
 *
 * A store's pin is one-way for content: once it moves to an English-only checkpoint, anything
 * already stored in another script keeps its row and loses its vector forever. So this runs BEFORE a
 * migration, against the same tolerance the write gate enforces, and reports exactly what would
 * become unreachable. Read-only.
 */
import Database from "better-sqlite3";
import { NON_LATIN_LETTER_TOLERANCE } from "../src/engine";

const db = new Database(process.env.MONET_DB!, { readonly: true });
const rows = db.prepare(
  `SELECT o.id, o.content, o.kind, c.slug, c.circle, o.created_at
     FROM observations o JOIN concepts c ON c.id = o.concept_id
    WHERE o.superseded_by IS NULL AND o.superseded_at IS NULL AND o.kind != 'source'`,
).all() as Array<{ id: string; content: string; kind: string; slug: string; circle: string; created_at: number }>;
db.close();

const share = (text: string): number => {
  const letters = text.match(/\p{L}/gu);
  if (letters === null || letters.length === 0) return 0;
  return letters.filter((ch) => !/\p{Script=Latin}/u.test(ch)).length / letters.length;
};

const flagged = rows
  .map((r) => ({ ...r, share: share(r.content) }))
  .filter((r) => r.share > NON_LATIN_LETTER_TOLERANCE)
  .sort((a, b) => b.share - a.share);

console.log(`${flagged.length} of ${rows.length} live native observations exceed the ${(NON_LATIN_LETTER_TOLERANCE * 100).toFixed(0)}% non-Latin tolerance\n`);
for (const f of flagged) {
  console.log(`${(f.share * 100).toFixed(0).padStart(3)}%  ${f.circle}/${f.slug.slice(0, 40)}  [${f.kind}]  ${f.id}`);
  console.log(`      ${f.content.replace(/\s+/g, " ").slice(0, 150)}`);
}
console.log(`\nThese keep their rows and lose their vectors on a migration to a Latin-only checkpoint.`);
console.log(`Rewrite them in English before migrating, or accept that search will not reach them.`);
