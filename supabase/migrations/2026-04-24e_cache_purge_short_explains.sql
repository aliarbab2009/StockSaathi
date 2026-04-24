-- =============================================================================
-- ONE-SHOT PURGE: evict poisoned "explain" cache rows (2026-04-24).
--
-- Context:
--   app/api/ai.js previously stored ANY LLM response in ai_response_cache
--   with no quality gate. Gemini 2.5 Flash Lite occasionally returns garbage
--   like "A 5" or "N/A" during soft rate-limits, and those got baked into
--   the cache as the "explanation" for whatever term was being looked up.
--   On the live demo the tooltip for P/E, 52W HIGH, Beta, Div Yield were
--   showing these poisoned values to every visitor because the cache hit
--   never fetched fresh.
--
--   The code fix (2026-04-24 commit) adds a word-count + length quality gate
--   and an awaited DELETE-and-retry path when a poisoned row is read. That
--   eventually self-heals each term as someone hovers it — but we can't
--   wait for 100 users to hover 100 terms to clean the table.
--
-- What this migration does:
--   Deletes every row in bucket = 'explain' whose payload->>'explanation'
--   fails the same quality gate the server now enforces:
--       * NULL
--       * shorter than 15 characters
--       * fewer than 3 whitespace-separated words
--   Subsequent lookups for those terms will miss the cache, fire a fresh
--   LLM fetch, pass the new quality gate, and repopulate with a real
--   answer. Good cached values (≥ 3 words, ≥ 15 chars) are untouched.
--
-- How to run:
--   Supabase Dashboard → SQL Editor → paste → Run.
--   Idempotent — re-running does nothing if no poison remains.
--   Returns a NOTICE with the count of rows deleted.
--
-- Rollback:
--   None possible — this DELETEs rows. But the cache is a pure performance
--   layer; deletion can only cost a little extra LLM traffic, never user
--   data. (The payload is regenerated on next hover.)
-- =============================================================================

do $$
declare
  n_deleted integer;
begin
  with victims as (
    delete from public.ai_response_cache
     where bucket = 'explain'
       and (
            payload ->> 'explanation' is null
         or length(payload ->> 'explanation') < 15
         or coalesce(
              array_length(
                string_to_array(
                  regexp_replace(payload ->> 'explanation', '\s+', ' ', 'g'),
                  ' '
                ),
                1
              ),
              0
            ) < 3
       )
    returning 1
  )
  select count(*) into n_deleted from victims;

  raise notice 'ai_response_cache purge: deleted % poisoned explain row(s).', n_deleted;
end $$;
