/**
 * Product vocabulary — the approved dictionary read as a reference spelling
 * list, at withdrawal intake.
 *
 * The Product Code Dictionary is NOT an allowlist and does not become one here.
 * A genuinely new product must stay enterable; the shop sells things nobody has
 * registered yet and always will. What the dictionary *can* do is tell the
 * difference between a product nobody has registered and a product that is
 * registered under a spelling one character away:
 *
 *   มะม่วงเขียวมรกต   → known canonical name, nothing to say
 *   มะม่วงเขียวรกต    → suspicious. ม31 exists and is one character away
 *   ฝรั่งสายพันธุ์ใหม่ → unknown, and nothing in the dictionary is close
 *
 * The middle case is the one that poisons a withdrawal master: it silently
 * mints a second product identity, and the mistake only surfaces later when the
 * return is typed correctly and P4A refuses it as product_not_withdrawn.
 *
 * Everything in this module produces SUGGESTIONS. A near match is never proof
 * of identity — เขียวมรกต and เขียวมรกตเก่า are one token apart and are
 * different goods. Nothing here rewrites a product name, and no caller may.
 */

import { boundedEditDistance } from "@/lib/parsers/weigh-session/units";
import { PRODUCT_ALIASES } from "@/lib/summary/remaining-fruit";
import { PRODUCT_CODE_ENTRIES } from "./product-code/dictionary";

export interface ProductVocabularySuggestion {
  readonly productCode: string;
  readonly canonicalName: string;
}

/** Enough to identify the mistake, few enough that the reply stays readable. */
const MAX_SUGGESTIONS = 3;

/** One or two wrong characters is a typo. Three is a different word. */
const MAX_TYPO_DISTANCE = 2;

/**
 * Shortest run of shared characters that can stand in for a whole missing word
 * (เขียวมรกต inside มะม่วงเขียวมรกต). Below this every long product name would
 * "match" every other one through a common syllable.
 */
const MIN_SHARED_RUN = 4;

/**
 * Mechanical only: NFC and whitespace. Deliberately not
 * `normalizeProductName` — that applies the reporting alias map, and applying
 * it here would make the guard silently accept the very alias spellings it
 * exists to surface.
 */
function mechanical(name: string): string {
  return name.normalize("NFC").replace(/\s+/g, " ").trim();
}

/**
 * Approved spelling → its product code.
 *
 * Enabled rows only. A retired code stops resolving, and its canonical name
 * stops being an approved spelling with it — which costs one review press on a
 * product nobody registers any more, and errs toward asking a human.
 */
const CODE_BY_CANONICAL_NAME: ReadonlyMap<string, string> = new Map(
  PRODUCT_CODE_ENTRIES.filter((entry) => entry.enabled)
    .map((entry) => [mechanical(entry.canonicalName), entry.code] as const)
    .reverse(), // first code wins if two rows ever share a canonical name
);

/**
 * Intake-approved exact aliases. Unlike PRODUCT_ALIASES (reporting only),
 * these spellings are themselves valid at withdrawal — they resolve to the
 * same product code as the canonical name and do not raise a vocabulary
 * review. Never fuzzy; never a second economic identity.
 */
const APPROVED_PRODUCT_NAME_ALIASES: ReadonlyMap<string, string> = new Map([
  [mechanical("มะม่วงจิ้ว"), mechanical("มะม่วงจิ๋ว")],
]);

function approvedCodeFor(name: string): string | null {
  const entered = mechanical(name);
  const direct = CODE_BY_CANONICAL_NAME.get(entered);
  if (direct) return direct;
  const canonical = APPROVED_PRODUCT_NAME_ALIASES.get(entered);
  return canonical ? (CODE_BY_CANONICAL_NAME.get(canonical) ?? null) : null;
}

/** True when the operator typed an approved spelling exactly. */
export function isApprovedProductName(name: string): boolean {
  return approvedCodeFor(name) !== null;
}

/** The code an approved spelling belongs to, or null. */
export function approvedProductCode(name: string): string | null {
  return approvedCodeFor(name);
}

/**
 * Longest run of characters the two names share.
 *
 * This is the signal edit distance misses. เขียวมรกต is not two edits from
 * มะม่วงเขียวมรกต — it is six — but it is entirely contained in it, and shop
 * shorthand drops a leading word far more often than it misspells one.
 */
function longestSharedRun(a: string, b: string): number {
  let best = 0;
  let previous = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    const current = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j += 1) {
      if (a[i - 1] !== b[j - 1]) continue;
      current[j] = previous[j - 1] + 1;
      if (current[j] > best) best = current[j];
    }
    previous = current;
  }
  return best;
}

/**
 * The reviewed alias map is *reporting* canonicalization. It is read here as
 * evidence — a spelling the business has already confirmed means a particular
 * product — and never as a resolution: the operator still sees the canonical
 * spelling and still has to act, so the withdrawal master stops accumulating
 * one more variant of a product that already has an approved name.
 */
function reviewedAliasTarget(name: string): string | null {
  const target = PRODUCT_ALIASES[name];
  if (!target) return null;
  const canonical = mechanical(target);
  return CODE_BY_CANONICAL_NAME.has(canonical) ? canonical : null;
}

interface Scored {
  readonly code: string;
  readonly name: string;
  /** 0 reviewed alias, 1 typo, 2 shared run. Lower is stronger evidence. */
  readonly tier: number;
  /** Within a tier: edit distance, or the negated shared run. Lower is closer. */
  readonly rank: number;
}

/**
 * Up to three dictionary products the operator might have meant, strongest
 * evidence first. Deterministic and offline: no model, no embedding, no
 * network. An empty result is a legitimate answer — most genuinely new
 * products have no near neighbour.
 */
export function suggestDictionaryProducts(name: string): ProductVocabularySuggestion[] {
  const entered = mechanical(name);
  if (entered.length < 2) return [];

  const aliasTarget = reviewedAliasTarget(entered);
  const scored: Scored[] = [];

  for (const [candidate, code] of CODE_BY_CANONICAL_NAME) {
    if (candidate === entered) continue;

    if (candidate === aliasTarget) {
      scored.push({ code, name: candidate, tier: 0, rank: 0 });
      continue;
    }

    const distance = boundedEditDistance(entered, candidate, MAX_TYPO_DISTANCE);
    if (distance !== null) {
      scored.push({ code, name: candidate, tier: 1, rank: distance });
      continue;
    }

    // Measured against what the operator typed, not against the candidate: a
    // five-character head word shared with ฝรั่ง is not evidence that
    // ฝรั่งสายพันธุ์ใหม่ของสวนลุงมี was meant to be ฝรั่ง.
    const run = longestSharedRun(entered, candidate);
    if (run >= MIN_SHARED_RUN && run * 2 >= entered.length) {
      scored.push({ code, name: candidate, tier: 2, rank: -run });
    }
  }

  scored.sort(
    (a, b) =>
      a.tier - b.tier ||
      a.rank - b.rank ||
      a.name.length - b.name.length ||
      a.name.localeCompare(b.name, "th") ||
      a.code.localeCompare(b.code),
  );

  return scored
    .slice(0, MAX_SUGGESTIONS)
    .map(({ code, name: canonicalName }) => ({ productCode: code, canonicalName }));
}
