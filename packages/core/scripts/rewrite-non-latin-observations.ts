/**
 * Rewrite the store's non-Latin observations in English (#155).
 *
 *   MONET_DB=~/.monet/monet.db npx tsx scripts/rewrite-non-latin-observations.ts --apply
 *
 * A store pinned to a Latin-only checkpoint cannot read these rows: they keep their content and lose
 * their vectors, permanently. So they are re-expressed in English BEFORE any such migration, and the
 * English storage preference — which they predate and violate — finally holds.
 *
 * NOT AN EDIT. Each English version is written as a NEW observation on the SAME concept, and the
 * original is superseded by it. An observation is evidence of what was actually written, so it is
 * retired rather than overwritten: the Korean text stays in the row, out of retrieval, addressable
 * by id, and the supersession says exactly what replaced it. The new row picks up segments and
 * lexical tokens from the ordinary write path.
 *
 * IDEMPOTENT. A row already superseded is skipped, so a partial run can simply be re-run.
 *
 * Translations are faithful re-expressions, not summaries: same claims, same scope, same emphasis,
 * including the hedges. Where the original names a person, a date or a product, so does the English.
 */
import { MonetCore } from "../src/engine";
import { chooseStartupEmbedder } from "./mcp-cli";

/** oldObservationId -> the English text that replaces it. */
const REWRITES: Record<string, string> = {
  "c32fd66d-5fe2-40a6-ab0e-3cdf68ad8566":
    "When acting on PR review feedback, do not focus on mechanically closing comments. Define the real customer-facing impact first — what the user gains or loses, and whether normal use, reuse and automation UX are weakened — and choose the solution that satisfies the functionally intended product experience rather than the one that is merely technically consistent. A security fix must also preserve a safe normal path rather than simply blocking.",
  "035e2849-c284-4fc9-8e7c-79fee94ac935":
    "PR review fixes do not end at a per-comment patch. Define the one lifecycle invariant the customer depends on, audit every sibling path that invariant applies to together (normal execution, wait/resume, restart/reclaim, cache, storage, public output), then enforce the contract with types and regression tests. A review comment is a signal that something was missed; it is not the standard the design is held to.",
  "fb-migration:51ccb002a77d941d5238c3ff753f632c":
    "First Block pin (surface retired 2026-08-02): PR reviews and product fixes are judged by two principles. (1) What the customer actually gains and loses — the functionally intended product experience, including normal use, reuse and automation — comes before being technically right or closing a comment. A security fix preserves a safe normal path. (2) Do not stop at a local per-comment patch: define the lifecycle invariant the customer depends on, audit every sibling path together (normal execution, wait/resume, restart/reclaim, cache, storage, public output), and enforce the contract with types and regression tests. A review comment is a signal that something was missed, not the standard the design is held to.",
  "5b8762f8-f5a0-4ccc-aef0-bbee24c7b23f":
    "ClearanceX no longer has Preview as a product stage. The real flow for an Amazon Creators candidate is Review queue -> one pass of the existing AI review -> final owner approval -> Live. The \"preview\" values left in the code and in Firestore are legacy storage keys pointing at the Review queue; they must not be described as a product concept or as a Preview kept in sync.",
  "8fd600c8-8c53-483e-a487-0c1786dba399":
    "ClearanceX's content experiment does not start with robot vacuums. The 2026-07-26 live snapshot holds only one actual robot vacuum, which is not enough data to support a comparison-style GEO/SEO page. On current data the first candidate is the four gaming monitors, which are comparable with each other and all show a genuine price drop. Only one of the four has been verified within the last seven days, however, so improve data freshness before running the experiment.",
  "09f8ba93-07ec-448e-b71b-1ebae511179c":
    "ClearanceX's next step is to fix the consistency of existing SEO and trust signals before mass-producing content. The public site says every deal is a real price drop, verified against price history and competitor pricing, and editorially reviewed — but of the 59 live items on 2026-07-26, 28 show no price drop in their public fields, 57 carry a deal rating while zero have an editorialNote, and the internal priceIntelEvidence is stripped from the public Deal type. The fix is either to surface the hidden verification evidence on the public page, or to remove and soften the overclaiming copy and editorial labelling on deals whose evidence cannot be published.",
  "bfc3ebfd-8e67-463b-9873-94df03f4c439":
    "Core product definition for ClearanceX content (John, 2026-07-26): multi-angle synthesis drawn from web search is the body of the page. Classify products by user situation, assign tiers, then combine ClearanceX price data to show where each product sells, for how much, and whether the current price is good or bad. Analysis rankings are not subordinated to transient deal inventory, and any future price alerts key on the normalised product rather than on a deal ID.",
  "902feb90-fb49-4fc8-b6f6-eba444ba24dd":
    "The public price-intelligence UI on a ClearanceX buying guide stays simple (John, 2026-07-26): for each recommended product show only the retailer it is cheapest at right now, the current lowest price, and a price verdict (excellent / good / fair / expensive). Price history and competitor comparisons may inform that verdict as internal evidence, but they are not required on the public page.",
  "232ddc52-ec4b-419c-aaeb-05db57d9ab37":
    "The overriding purpose of the new ClearanceX buying-guide page (John, 2026-07-26) is accurate information and enough trust to decide immediately. The user journey answers the search question directly, presents situation-specific recommendations and tiers with their reasoning, then closes the decision with the cheapest place to buy, the current lowest price, and a price verdict. Confidence in the decision comes before traffic or click-through.",
  "46b091bf-8fc4-4e0c-bc22-a2fc26cbc371":
    "Core product principle for ClearanceX content (John, 2026-07-26): the point of the content is not to help a user analyse a product for longer, but to compress trustworthy evidence so the purchase decision is made quickly and correctly. Every structure, feature and line of copy is judged on decision speed and accuracy ahead of volume of information or time on page.",
  "54e1e10a-ebf1-4a3f-bfd8-ed6ca31f15b9":
    "SEO is the top launch criterion for ClearanceX's new purchase-decision content area. Page design and feature judgements prioritise precise search-intent match, a server-rendered direct answer, indexing safeguards, structured data, internal linking, and current price evidence.",
  "384e1510-14ad-4cab-a6b1-f5ec9e07c223":
    "A ClearanceX buying guide does not restrict its recommendations to products ClearanceX currently tracks. First research the full relevant product field currently purchasable in the Australian market along with existing expert reviews, and select an evidence-backed Top 3 independently per search question. ClearanceX price data attaches afterwards as a separate layer that does not distort the selection, supplying the cheapest tracked retailer, current price and price verdict for the products chosen. Content competitiveness comes from the quality of the question, evidence comparison, editorial judgement and a refreshable research framework — not from writing flair.",
  "59fbbe36-d500-49ab-b0e2-6b6020b9087f":
    "The content research order is: question -> search existing expert content and reviews -> find product candidates with sufficient evidence -> compare on identical criteria -> select a Top 3 -> attach ClearanceX pricing. Building the product list first is forbidden, because it degenerates into listing specifications with no evidence behind them. The focus of the new content is not bargain hunting but helping a reader quickly find the product their situation actually needs.",
  "7d9121d0-622e-4d49-92cb-de4c9762ab4a":
    "ClearanceX research scope is not limited to products sold in Australia. Build the question and the product-fit evidence from global content and reviews, and separate availability, model variants, price and warranty into a regional layer. The public site and price data are AU-first today, but the research data model must support global recommendation plus a regional availability/price overlay from the start. \"Sold in Australia\" is not an exclusion criterion for a research candidate; it is a condition on regional display and local-variant selection.",
  "3a8caf84-06d2-49c7-a217-f06874fc24d4":
    "Correction: AART is not a finished, tested product — it is currently parked. ClearanceX is not something to run on top of AART today; it is the representative use case that will dogfood the real content research pipeline when AART development resumes. So ClearanceX work does not push an AART integration now. Validate the question -> content search -> evidence -> Top 3 -> price-linking process manually or semi-automatically first, and preserve the output as a future AART acceptance scenario.",
  "92699ab6-0ef6-48cd-9ec7-4148bd94129a":
    "ClearanceX's current stage is validating a content direction, not automating content. A person drives question -> content search -> evidence extraction -> candidate discovery -> comparison -> Top 3 -> price linking -> column editing, and validates it by producing real documents. Only once trustworthiness, purchase-decision usefulness, SEO viability and production/refresh cost have passed does AART come back, to build a formal pipeline automating the validated process.",
  "27390831-144f-4aa2-b740-906e9b7c84b5":
    "Stage zero of the content pipeline is question-discovery search. The first question is not set by internal intuition. Collect and cluster real Search Console queries, autocomplete and related questions, community, forum and video comments, and questions competitors' content answers repeatedly, to discover the purchase-decision questions searchers actually express — then a person approves the core question. Only after that does the search for content and evidence answering it begin. \"Searching for the question\" and \"searching for the answer\" are separate stages.",
  "6b8dbf36-7f9f-40a6-8947-2010142879eb":
    "Sourcing principle for ClearanceX buying guides: separate the roles rather than increase the number of links. An independent hands-on review evidences response time, latency, brightness, HDR, VRR and weaknesses; a second independent review evidences reproduction and disagreement; official platform documentation evidences PS5/Xbox support signals; manufacturer documentation evidences exact model, ports, modes and warranty; academic research evidences general assumptions such as screen size and refresh rate; ClearanceX data evidences regional price and price quality only. Manufacturer material is not used for comparative performance or a \"best\" judgement, and price data does not decide whether a product makes the editorial recommendation.",
  "1d6aeb66-554f-47f7-9c50-0c0da724f552":
    "Before ClearanceX content is published, every recommended product must have an individual product link that actually opens. Prefer the official manufacturer product detail page, check that links are alive immediately before publishing, and do not publish a product whose link is dead or missing.",
  "adfe9374-c181-417b-a761-014b14e327bb":
    "ClearanceX public buying-guide copy does not cite academic papers directly. Translate the underlying principle into a practical criterion a buyer can act on, and prefer familiar expert review and measurement outlets such as RTINGS, TFTCentral and TechSpot for evidence links. Papers may remain as internal research material.",
  "ee1a66d2-40e1-48e7-aea6-90fea529be1d":
    "Price links in a ClearanceX buying guide are not restricted to products in the public deal feed; they query Neon's fresh inventory offers directly. A lowest price is shown only when the recommended model number matches the Neon product exactly — never on a similar sibling model or a partial string match. Clicks route through the internal `/go/price/<model>` path to whichever retailer is cheapest at click time. On a database lookup failure, fall back safely to the official product link.",
  "2fa2713f-50ea-4e28-a666-965c9f56e63d":
    "Site structure decision (John, 2026-08-01): john.onlee.io organizes into three sections, each with a stated value proposition — (1) AI Radar: \"discover the changes a good builder must not miss. It sells what deserves attention, not news\" (maps to existing /brief/, keep URL, relabel); (2) Insights: \"name what a change means and the problems that recur in practice. It sells a frame for judgement, not information\" (maps to existing /blog/); (3) Guides & Tools: \"apply that judgement to real systems and ways of working. It sells the ability to execute, not instructions\" (new section, does not exist yet). Google AdSense ads will run ONLY on the Guides & Tools section — Radar and Insights stay ad-free.",
};

async function main(): Promise<void> {
  const dbPath = process.env.MONET_DB;
  if (dbPath === undefined) { console.error("set MONET_DB"); process.exit(2); }
  const apply = process.argv.includes("--apply");

  const core = new MonetCore(dbPath, { embedder: await chooseStartupEmbedder(dbPath) });
  await core.ensureEmbedderPin();
  const db = (core as unknown as { db: { prepare: (sql: string) => { get: (...a: unknown[]) => unknown; run: (...a: unknown[]) => unknown } } }).db;

  let rewritten = 0, skipped = 0;
  for (const [oldId, english] of Object.entries(REWRITES)) {
    const row = db.prepare(
      `SELECT o.id, o.concept_id, o.kind, c.circle, o.superseded_by, o.superseded_at
         FROM observations o JOIN concepts c ON c.id = o.concept_id WHERE o.id = ?`,
    ).get(oldId) as { concept_id: string; kind: string; circle: string; superseded_by: string | null; superseded_at: number | null } | undefined;

    if (row === undefined) { console.log(`  MISSING  ${oldId}`); skipped++; continue; }
    if (row.superseded_by !== null || row.superseded_at !== null) { console.log(`  done     ${oldId}`); skipped++; continue; }

    if (!apply) { console.log(`  would    ${row.circle} ${oldId} -> ${english.length}c English`); rewritten++; continue; }
    // Stored WITHOUT the original kind, then stamped with it. store() enforces a species guard —
    // principle evidence may not attach to a non-principle concept — and some of these rows predate
    // it, sitting in exactly the shape it now refuses. This migration changes the LANGUAGE and
    // nothing else; re-adjudicating an observation's kind while translating it would be a second,
    // unrequested edit hidden inside the first.
    const result = await core.store(english, {
      circle: row.circle,
      attachTo: row.concept_id,
      sourceRefs: [`supersedes:`, "monet-core#155 English-only storage"],
    });
    db.prepare(`UPDATE observations SET kind = ? WHERE id = ?`).run(row.kind, result.observationId);
    core.supersedeObservation(oldId, result.observationId);
    console.log(`  rewrote  ${row.circle} ${oldId} -> ${result.observationId}`);
    rewritten++;
  }
  core.close();
  console.log(`\n${apply ? "rewrote" : "would rewrite"} ${rewritten}, skipped ${skipped}`);
  if (!apply) console.log(`re-run with --apply to write.`);
}
void main();
