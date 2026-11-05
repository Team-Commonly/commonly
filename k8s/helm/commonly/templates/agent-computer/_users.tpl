{{/*
The people who have an agent computer, as a JSON array of user ids. Empty
unless backend.env.agentComputerEnabled is "true". A malformed id fails the
render: every id becomes part of a Kubernetes name and an RBAC resourceName.
*/}}
{{- define "commonly.agentComputer.users" -}}
{{- $users := list -}}
{{- if eq (toString .Values.backend.env.agentComputerEnabled) "true" -}}
{{- range ((.Values.agentComputer).users | default list) -}}
{{- $id := toString . -}}
{{- if not (regexMatch "^[a-f0-9]{24}$" $id) -}}
{{- fail (printf "agentComputer.users: %q is not a 24-character lowercase hex user id" $id) -}}
{{- end -}}
{{- $users = append $users $id -}}
{{- end -}}
{{- end -}}
{{- $users | uniq | toJson -}}
{{- end -}}
