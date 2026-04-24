-- =============================================================================
-- ONE-SHOT PURGE v2: evict mid-sentence-truncated "explain" cache rows.
-- Follow-up to 2026-04-24e_cache_purge_short_explains.sql (2026-04-24).
--
-- Context:
--   v126 shipped a quality gate that rejected explanations shorter than
--   15 chars or fewer than 3 words. That caught "A 5"-style 1-2 word
--   garbage. It does NOT catch grammatically-truncated-but-word-count-
--   passing outputs. Live demo was showing:
--     * Beta       → "Beta measures how much a"       (5 words, 24 chars)
--     * Market Cap → "Market cap is the"              (4 words, 17 chars)
--   Both pass v126's gate but end mid-sentence. Root cause: opExplain was
--   routing to gemini-2.5-flash (a thinking model) with max_tokens=120,
--   so ~95 tokens were consumed by reasoning and only ~25 emitted as text.
--
--   v127 fixes the upstream cause — opExplain now routes to flash-lite
--   (non-thinking) and max_tokens is 200. v127 also extends the gate:
--   reject outputs whose last alphabetic token is a stub word (article,
--   pronoun, auxiliary verb, conjunction) or which end with a trailing
--   stall character ("…", "...", ",", "-", ":").
--
-- What this migration does:
--   Deletes every existing row in bucket='explain' whose stored
--   explanation now fails the v127 gate's new checks:
--     (a) last alphabetic run is a stub word
--     (b) text ends with trailing ",", "-", ":", "..." or "…"
--   Rows that still pass the v127 gate are untouched. Purged terms will
--   re-fetch on next hover and repopulate with a clean, complete sentence.
--
-- How to run:
--   Supabase Dashboard → SQL Editor → paste → Run.
--   Idempotent — re-running does nothing once the poison is gone.
--   Returns a NOTICE with the count of rows deleted.
--
-- Rollback: none possible (DELETE). But the cache is pure performance,
--   no user data lost — values regenerate on next hover.
-- =============================================================================

do $$
declare
  n_deleted integer;
  stub_words text[] := array[
    'a','an','the',
    'it','this','that','these','those',
    'is','are','was','were','be','been','being',
    'have','has','had','having',
    'do','does','did','doing','done',
    'will','would','should','could','can','may','might','must','shall',
    'and','or','but','nor','so','yet'
  ];
begin
  with victims as (
    delete from public.ai_response_cache
     where bucket = 'explain'
       and payload ->> 'explanation' is not null
       and (
         -- Ends with ",", "-", or ":" (ignoring trailing whitespace).
         regexp_replace(payload ->> 'explanation', '\s+$', '') ~ '[,\-:]$'
         -- Ends with "..." or "…" (ellipsis stall).
         or regexp_replace(payload ->> 'explanation', '\s+$', '') ~ '(\.{2,}|…)$'
         -- Last alphabetic run is a stub word.
         or substring(
              lower(payload ->> 'explanation')
              from '([a-z]+)[^a-z]*$'
            ) = any(stub_words)
       )
    returning 1
  )
  select count(*) into n_deleted from victims;

  raise notice 'ai_response_cache purge v2: deleted % mid-sentence-truncated explain row(s).', n_deleted;
end $$;
