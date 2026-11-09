{{/*
Expand the name of the chart.
*/}}
{{- define "commonly.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "commonly.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Create chart name and version as used by the chart label.
*/}}
{{- define "commonly.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "commonly.labels" -}}
helm.sh/chart: {{ include "commonly.chart" . }}
{{ include "commonly.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "commonly.selectorLabels" -}}
app.kubernetes.io/name: {{ include "commonly.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Backend labels
*/}}
{{- define "commonly.backend.labels" -}}
{{ include "commonly.labels" . }}
app: backend
{{- end }}

{{/*
Backend selector labels
*/}}
{{- define "commonly.backend.selectorLabels" -}}
{{ include "commonly.selectorLabels" . }}
app: backend
{{- end }}

{{/* The worker must never match the backend Service selector. */}}
{{- define "commonly.backendWorker.labels" -}}
{{ include "commonly.labels" . }}
app: backend-worker
{{- end }}

{{- define "commonly.backendWorker.selectorLabels" -}}
{{ include "commonly.selectorLabels" . }}
app: backend-worker
{{- end }}

{{/*
Frontend labels
*/}}
{{- define "commonly.frontend.labels" -}}
{{ include "commonly.labels" . }}
app: frontend
{{- end }}

{{/*
Frontend selector labels
*/}}
{{- define "commonly.frontend.selectorLabels" -}}
{{ include "commonly.selectorLabels" . }}
app: frontend
{{- end }}

{{/*
MongoDB labels
*/}}
{{- define "commonly.mongodb.labels" -}}
{{ include "commonly.labels" . }}
app: mongodb
{{- end }}

{{/*
MongoDB selector labels
*/}}
{{- define "commonly.mongodb.selectorLabels" -}}
{{ include "commonly.selectorLabels" . }}
app: mongodb
{{- end }}

{{/*
PostgreSQL labels
*/}}
{{- define "commonly.postgresql.labels" -}}
{{ include "commonly.labels" . }}
app: postgres
{{- end }}

{{/*
PostgreSQL selector labels
*/}}
{{- define "commonly.postgresql.selectorLabels" -}}
{{ include "commonly.selectorLabels" . }}
app: postgres
{{- end }}

{{/*
Redis labels
*/}}
{{- define "commonly.redis.labels" -}}
{{ include "commonly.labels" . }}
app: redis
{{- end }}

{{/*
Redis selector labels
*/}}
{{- define "commonly.redis.selectorLabels" -}}
{{ include "commonly.selectorLabels" . }}
app: redis
{{- end }}

{{/*
Namespace
*/}}
{{- define "commonly.namespace" -}}
{{- default "commonly" .Values.global.namespace }}
{{- end }}

{{/*
The per-component Postgres roles (backend.env.pgAppUser, litellm.pgUser): each
names a role and the database-credentials key holding its password. Either
alone points a role at another role's password, and only the ExternalSecret
can carry a key other than postgres-password. Rendered by
templates/secrets/pg-role-checks.yaml, so it runs whatever else is enabled.
*/}}
{{- define "commonly.pgRoleOverride.checks" -}}
{{- range list (list .Values.backend.env.pgAppUser .Values.backend.env.pgAppPasswordKey "backend.env.pgAppUser") (list .Values.litellm.pgUser .Values.litellm.pgPasswordKey "litellm.pgUser") }}
{{- $role := index . 0 }}
{{- $key := index . 1 }}
{{- $path := index . 2 }}
{{- if ne (empty $role) (empty $key) }}
{{- fail (printf "%s: set the Postgres role and its password key together" $path) }}
{{- end }}
{{- /* Postgres truncates a longer name at CREATE ROLE but not at login, so 63 is the limit. */}}
{{- if and $role (or (not (regexMatch "^[a-z_][a-z0-9_]{0,62}$" $role)) (hasPrefix "pg_" $role)) }}
{{- fail (printf "%s: %q is not a plain Postgres role name ([a-z_][a-z0-9_]*, at most 63, no pg_ prefix)" $path $role) }}
{{- end }}
{{- /* A leading letter keeps the key a YAML string when rendered unquoted. */}}
{{- if and $key (not (regexMatch "^[a-zA-Z][-._a-zA-Z0-9]{0,252}$" (toString $key))) }}
{{- fail (printf "%s: %q is not a Secret key name (a letter, then [-._a-zA-Z0-9], at most 253)" $path (toString $key)) }}
{{- end }}
{{- if has $key (list "mongo-uri" "mongo-password") }}
{{- fail (printf "%s: %s is not a Postgres password key" $path $key) }}
{{- end }}
{{- if and $key (ne $key "postgres-password") (not $.Values.externalSecrets.enabled) }}
{{- fail (printf "%s: %s needs externalSecrets; the local Secret carries only postgres-password" $path $key) }}
{{- end }}
{{- end }}
{{- end }}
