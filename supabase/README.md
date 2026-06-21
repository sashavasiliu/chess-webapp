# Supabase Working Directory

This directory is ready for the Supabase CLI and GitHub/Supabase repository workflows.

## Files

- `config.toml` contains local Supabase service settings.
- `migrations/` contains database migrations that Supabase can apply in order.
- `schema.sql` remains a readable snapshot of the current app schema.
- `seed.sql` is reserved for local development seed data.
- `functions/` is reserved for future Edge Functions.

## Typical CLI Flow

Install the Supabase CLI, then:

```bash
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase db push
```

## Import Opening Lines

1. Apply the migrations in this directory to your Supabase project.
   - With the CLI: `supabase db push`
   - Or in the dashboard SQL Editor, run the SQL from `migrations/20260621170500_opening_lines.sql`.
2. Add your service-role key to local `.env`:

```bash
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
```

3. Run the import:

```bash
npm run import:openings
```

The import reads `public/chess-openings-master/a.tsv` through `e.tsv`, upserts rows into
`public.opening_lines`, and tags Ruy Lopez / Spanish Game rows as `family = 'spanish-game'`.

Do not commit `.env`, access tokens, service-role keys, database passwords, or generated local runtime folders.
