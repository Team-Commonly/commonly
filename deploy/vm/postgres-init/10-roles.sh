#!/bin/sh
# Runs once, when the postgres service starts on an empty data volume
# (docker-entrypoint-initdb.d). Creates the two login roles the stack uses:
#   PG_USER          the backend; owns the public schema, where its migrations run
#   LITELLM_PG_USER  LiteLLM; owns only the litellm schema, and cannot read chat
# The admin role (POSTGRES_USER) is left for backups and restores.
set -eu

: "${PG_USER:?}" "${PG_PASSWORD:?}" "${LITELLM_PG_USER:?}" "${LITELLM_PG_PASSWORD:?}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v app_user="$PG_USER" -v app_password="$PG_PASSWORD" \
  -v litellm_user="$LITELLM_PG_USER" -v litellm_password="$LITELLM_PG_PASSWORD" \
  -v db="$POSTGRES_DB" <<'SQL'
CREATE ROLE :"app_user" LOGIN PASSWORD :'app_password';
CREATE ROLE :"litellm_user" LOGIN PASSWORD :'litellm_password';
REVOKE ALL ON DATABASE :"db" FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE :"db" TO :"app_user", :"litellm_user";
ALTER SCHEMA public OWNER TO :"app_user";
CREATE SCHEMA litellm AUTHORIZATION :"litellm_user";
SQL
