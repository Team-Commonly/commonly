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
