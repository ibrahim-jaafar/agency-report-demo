# n8n for the agency report demo, on a free Hugging Face Docker Space.
# Data lives in Supabase Postgres, so restarts lose nothing.
# Secrets (DB password, encryption key) come from the Space's secret settings, never this file.
FROM n8nio/n8n:2.43.8

ENV N8N_PORT=7860 \
    N8N_PROTOCOL=https \
    N8N_PROXY_HOPS=1 \
    GENERIC_TIMEZONE=UTC \
    N8N_DIAGNOSTICS_ENABLED=false \
    N8N_PERSONALIZATION_ENABLED=false \
    NODE_FUNCTION_ALLOW_BUILTIN=crypto \
    DB_TYPE=postgresdb \
    DB_POSTGRESDB_SSL_ENABLED=true \
    DB_POSTGRESDB_SSL_REJECT_UNAUTHORIZED=false

EXPOSE 7860
