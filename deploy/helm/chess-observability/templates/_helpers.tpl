{{- /* Image reference: digest wins when set (immutable); otherwise pinned tag.
     A component with NEITHER fails rendering (no silent latest). */ -}}
{{- define "obs.image" -}}
{{- $registry := .registry -}}
{{- $repository := .repository -}}
{{- $tag := .tag | default "" -}}
{{- $digest := .digest | default "" -}}
{{- if $digest -}}
{{- if not (regexMatch "^sha256:[0-9a-f]{64}$" $digest) -}}
{{- fail (printf "%s: image.digest must match ^sha256:[0-9a-f]{64}$" .context) -}}
{{- end -}}
{{- if $registry -}}{{ $registry }}/{{- end -}}{{ $repository }}@{{ $digest }}
{{- else -}}
{{- if not $tag -}}
{{- fail (printf "%s: set image.tag (pinned) or image.digest" .context) -}}
{{- end -}}
{{- if $registry -}}{{ $registry }}/{{- end -}}{{ $repository }}:{{ $tag }}
{{- end -}}
{{- end -}}

{{- define "obs.labels" -}}
app.kubernetes.io/managed-by: argocd
app.kubernetes.io/part-of: chess
{{- end -}}

{{- define "obs.selectorLabels" -}}
app.kubernetes.io/name: {{ .component }}
app.kubernetes.io/instance: chess-observability
{{- end -}}
