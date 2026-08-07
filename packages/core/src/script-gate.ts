/**
 * The script measurement, on its own so the two callers cannot disagree — or import each other.
 *
 * The write gate (engine) refuses a row an English-only embedder could not read; the pre-migration
 * diagnostic (diagnostics) counts what a move to such a model would strand. Different questions,
 * but they must be answered against the SAME number, or `doctor` clears a store the write path
 * would have refused, or warns about rows it would have accepted.
 *
 * A LEAF MODULE ON PURPOSE. engine already imports diagnostics for lifecycle-edge integrity, so
 * putting this in engine and importing it from diagnostics closes a value cycle between the two —
 * which happens to work today only because the constant is read inside a function body rather than
 * at module evaluation, and would break the first time that stops being true.
 */

/**
 * The share of non-Latin letters above which content is treated as unreadable by a Latin-only model.
 *
 * NOT ZERO, and the tolerance is the point: a technical note in English routinely carries a foreign
 * term, a name, or a quoted string, and refusing those would make the gate unusable on real text.
 * 0.2 admits a word or two in a sentence and refuses a sentence written in another script.
 */
export const NON_LATIN_LETTER_TOLERANCE = 0.2;

/**
 * The share of a text's LETTERS that are not Latin script. Pure, and never throws.
 *
 * Digits and punctuation are script-neutral, and a text with no letters at all returns 0: those are
 * not "non-Latin", they are simply not evidence either way.
 *
 * A FLOOR, NOT A LANGUAGE TEST. It detects SCRIPT. Text written in French, Vietnamese, Turkish or
 * any other Latin-alphabet language scores 0 here and degrades on an English-only model exactly the
 * same way — so a zero count means "no non-Latin script found", never "everything is English".
 */
export function nonLatinLetterShare(content: string): number {
  const letters = content.match(/\p{L}/gu);
  if (letters === null || letters.length === 0) return 0;
  return letters.filter((ch) => !/\p{Script=Latin}/u.test(ch)).length / letters.length;
}
